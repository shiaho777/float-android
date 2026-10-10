// lib/memory-correction.ts
// 修正 / 作废记忆，并沿证据关联把派生条目一起失效。
//
// 为什么必须级联：一条 episode 被证明是错的，由它总结出的 summary、由 summary 得出的
// reflection、以及据 reflection 写入的 trait_shift，如果不跟着失效，就会继续被召回、
// 继续被核心总结采用——错误在链条上活得比原始证据还长，这就是"修正正文后，错误总结、
// 反思、核心及向量副本仍然生效"。
//
// 设计原则：
//  1. **不改写历史正文来否认**（不要往记忆里追加"某事没有发生"）。正文只记录真实经历，
//     纠正的原因放进审计日志与条目的 correctionReason。
//  2. 只标记状态、不删除数据 —— superseded / needs_review / invalid 都能用 restore 恢复。
//  3. 派生条目按「是否还有自己的独立证据」区分：还有 → needs_review（待重算）；
//     没有了 → superseded（已替代）。两者都会立即停止召回。

import type { MemoryEntry, MemoryStatus } from "./memory-types";
import { memoryStatusOf } from "./memory-types";
import { clearMemorySurfacedRecords, loadMemoryEntries, saveMemoryEntry } from "./memory-storage";
import { logMemoryWrite } from "./memory-recall-log";

export type MemoryCorrectionChange = {
    id: string;
    status: MemoryStatus;
    /** 为什么被这样处理（进入审计日志） */
    reason: string;
};

export type MemoryCorrectionOutcome = {
    /** 被改动状态的条目（含根条目） */
    changed: MemoryCorrectionChange[];
    /** 未能处理的原因（条目不存在、已是目标状态等） */
    skipped: { id: string; reason: string }[];
};

/** 本条目由哪些条目派生（顶层 links 即 derivedFrom）。 */
function derivedFromOf(entry: MemoryEntry): string[] {
    return Array.isArray(entry.links)
        ? entry.links.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
}

/** 这条记忆有没有属于自己的原始证据（原始消息指向）。 */
function hasOwnEvidence(entry: MemoryEntry): boolean {
    return Array.isArray(entry.sourceMessageIds) && entry.sourceMessageIds.length > 0;
}

/**
 * 修正条目正文。
 *
 * 改写后：向量作废（正文变了，旧向量描述的是旧内容）、注入记账清零、
 * 所有沿 links 依赖它的派生条目按上表处理。
 */
export async function correctMemoryEntry(
    characterId: string,
    entryId: string,
    newContent: string,
    options?: { reason?: string },
): Promise<MemoryCorrectionOutcome> {
    const content = newContent.trim();
    if (!content) {
        return { changed: [], skipped: [{ id: entryId, reason: "新正文为空" }] };
    }
    return applyCorrection(characterId, entryId, options?.reason ?? "手工修正", (entry) => {
        const revision = (typeof entry.metadata?.revision === "number" ? entry.metadata.revision : 1) + 1;
        const revisions = Array.isArray(entry.metadata?.revisions) ? entry.metadata.revisions : [];
        return {
            ...entry,
            content,
            updatedAt: new Date().toISOString(),
            // 正文变了：旧向量描述的是旧内容，必须作废（删除引用，需要时重新索引）。
            embedding: undefined,
            metadata: {
                ...entry.metadata,
                status: "active" as MemoryStatus,
                revision,
                embeddingStale: true,
                correctionReason: options?.reason ?? "手工修正",
                revisions: [
                    ...revisions,
                    { at: entry.updatedAt ?? entry.createdAt, content: entry.content },
                ].slice(-3),
            },
        };
    }, "merge");
}

/**
 * 作废条目：不再召回、不再进核心，但数据保留、可恢复。
 */
export async function invalidateMemoryEntry(
    characterId: string,
    entryId: string,
    options?: { reason?: string },
): Promise<MemoryCorrectionOutcome> {
    return applyCorrection(characterId, entryId, options?.reason ?? "手工作废", (entry) => ({
        ...entry,
        updatedAt: new Date().toISOString(),
        embedding: undefined,
        metadata: {
            ...entry.metadata,
            status: "invalid" as MemoryStatus,
            embeddingStale: true,
            invalidatedAt: new Date().toISOString(),
            correctionReason: options?.reason ?? "手工作废",
        },
    }), "supersede");
}

/**
 * 恢复条目：把状态改回 active。派生条目的状态**不会**自动跟着恢复——
 * 它们需要按现在的证据重新计算，这正是 needs_review 的含义。
 */
export async function restoreMemoryEntry(
    characterId: string,
    entryId: string,
): Promise<MemoryCorrectionOutcome> {
    const entries = await loadMemoryEntries(characterId);
    const target = entries.find(entry => entry.id === entryId);
    if (!target) return { changed: [], skipped: [{ id: entryId, reason: "条目不存在" }] };
    if (memoryStatusOf(target) === "active" && target.metadata?.archived !== true) {
        return { changed: [], skipped: [{ id: entryId, reason: "已经是有效状态" }] };
    }
    const restored: MemoryEntry = {
        ...target,
        updatedAt: new Date().toISOString(),
        metadata: { ...target.metadata, status: "active" as MemoryStatus, archived: false, restoredAt: new Date().toISOString() },
    };
    await saveMemoryEntry(restored);
    logMemoryWrite({ action: "create", characterId, entryId, outcome: "手工恢复为有效" });
    return { changed: [{ id: entryId, status: "active", reason: "手工恢复" }], skipped: [] };
}

/**
 * 级联核心：改根条目 → 沿 links 反向找派生条目 → 逐层标记。
 *
 * 派生条目状态判定：还有自己的原始证据 → needs_review（待重算）；否则 → superseded。
 * 无论哪种都会立即退出召回（isRecallableEntry 只认 active）。
 */
async function applyCorrection(
    characterId: string,
    entryId: string,
    reason: string,
    mutateRoot: (entry: MemoryEntry) => MemoryEntry,
    rootAction: "merge" | "supersede",
): Promise<MemoryCorrectionOutcome> {
    const entries = await loadMemoryEntries(characterId);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const root = byId.get(entryId);
    if (!root) return { changed: [], skipped: [{ id: entryId, reason: "条目不存在" }] };

    const changed: MemoryCorrectionChange[] = [];
    const skipped: { id: string; reason: string }[] = [];

    // 根条目
    const mutatedRoot = mutateRoot(root);
    await saveMemoryEntry(mutatedRoot);
    byId.set(entryId, mutatedRoot);
    changed.push({ id: entryId, status: memoryStatusOf(mutatedRoot), reason });
    logMemoryWrite({ action: rootAction, characterId, entryId, outcome: reason });

    // 反向邻接：谁 links 里含我，谁就是我派生出来的
    const dependents = new Map<string, string[]>();
    for (const entry of entries) {
        for (const source of derivedFromOf(entry)) {
            const list = dependents.get(source) ?? [];
            list.push(entry.id);
            dependents.set(source, list);
        }
    }

    // 广度优先级联。visited 防住环（links 理论上无环，但坏数据不该把这里卡死）。
    const visited = new Set<string>([entryId]);
    const queue = [...(dependents.get(entryId) ?? [])];
    const touchedIds: string[] = [];

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);
        const current = byId.get(currentId);
        if (!current) {
            skipped.push({ id: currentId, reason: "派生条目已不存在（悬空引用）" });
            continue;
        }

        const nextStatus: MemoryStatus = hasOwnEvidence(current) ? "needs_review" : "superseded";
        const updated: MemoryEntry = {
            ...current,
            updatedAt: new Date().toISOString(),
            embedding: undefined,
            metadata: {
                ...current.metadata,
                status: nextStatus,
                embeddingStale: true,
                correctionReason: reason,
                correctedAt: new Date().toISOString(),
            },
        };
        await saveMemoryEntry(updated);
        byId.set(currentId, updated);
        touchedIds.push(currentId);
        changed.push({
            id: currentId,
            status: nextStatus,
            reason: `${reason}（派生自 ${entryId}，${nextStatus === "needs_review" ? "尚有自身证据，待重算" : "已失去全部证据，标记替代"}）`,
        });
        logMemoryWrite({
            action: "supersede",
            characterId,
            entryId: currentId,
            outcome: `${reason} → ${nextStatus}`,
        });

        // 继续往下传播
        for (const child of dependents.get(currentId) ?? []) {
            if (!visited.has(child)) queue.push(child);
        }
    }

    // 注入记账清零：作废/改写的条目不该继续贡献"新鲜度"这一维。
    clearMemorySurfacedRecords([entryId, ...touchedIds]);

    return { changed, skipped };
}
