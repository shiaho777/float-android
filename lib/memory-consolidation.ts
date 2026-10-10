// lib/memory-consolidation.ts
// 空闲固化循环：角色在空闲时自主整理记忆。
//   1. 反思：跨多条记忆的新结论（kind=reflection）。复述、单条换说法、别人的事都不入库。
//   2. 性格漂移：默认关闭。只有记忆设置里打开后，才写 trait_shift 和 PersonaState。
//   3. 去重：同 kind 且文字近重复的条目合并（保新删旧，links 并集）。
//
// 触发：总结管线尾部（重要性积累到位自然跟上）+ 空闲调度器周期 tick。
//
// 开关语义（重要，别搞混）：
//   autoReflectionEnabled  反思总闸，**默认关**。关掉后**后台**（空闲扫描 + 总结尾部）
//                          不再产出任何 reflection / trait_shift —— 反思是推断不是事实，
//                          让它自动生长正是"推测逐渐变成事实"的根源。
//   autoPersonaDriftEnabled 性格漂移闸，默认关。比反思更严的一层。
//   手动触发（记忆页"整理记忆"、角色工具 runConsolidation）不受总闸限制，因为它是
//      用户/角色显式发起的，且会写进检索日志。
//
// 兼容：全部走 saveMemoryEntry，字段可选；无任何 LLM 绑定时安静跳过。

import type { MemoryEntry } from "./memory-types";
import { memoryKindOf, effectiveSalience, isRecallableEntry, memoryEventIdOf } from "./memory-types";
import {
    loadMemoryEntries,
    saveMemoryEntry,
    deleteMemoryEntries,
    getLastConsolidatedTimestamp,
    setLastConsolidatedTimestamp,
    loadMemoryConfig,
} from "./memory-storage";
import { loadApiConfigs, loadBindingConfig, resolveAuxiliaryApiConfig, resolveBinding } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { applyTraitShift, loadPersonaState } from "./persona-state";
import { loadCharacters } from "./character-storage";
import { buildMemoryRoster, isForeignMemoryText } from "./group-memory-scope";
import { logMemoryTask, memorySwitchSnapshot } from "./memory-recall-log";

/** 固化水位线无活动时多久强制跑一次（毫秒）；有活动时靠总结尾部触发 */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 参与反思的近期记忆上限 */
const REFLECTION_CANDIDATE_LIMIT = 40;
/** 反思输出上限 */
const MAX_REFLECTIONS = 3;
const MAX_TRAIT_SHIFTS = 2;
/** 去重判定阈值：归一化 bigram Jaccard。换种说法的复述靠覆盖率和包含关系补上。 */
const DEDUPE_SIMILARITY = 0.62;
/** 性格漂移至少要跨过的幅度。更小的抖动不写入性格状态。 */
const MIN_TRAIT_DELTA = 0.25;

const consolidatingSet = new Set<string>();

export type ConsolidationResult = {
    ran: boolean;
    reflections: number;
    traitShifts: number;
    deduped: number;
    error?: string;
};

/** 当前开关状态快照，只用于日志与门控，不含任何密钥。 */
function currentSwitches(): Record<string, boolean> {
    return memorySwitchSnapshot();
}

/** 门控：开关打开 且 距上次固化够久 且 期间有新记忆积累，才值得跑。 */
export async function maybeRunConsolidation(
    characterId: string,
    characterName: string,
): Promise<void> {
    if (consolidatingSet.has(characterId)) return;

    // 反思总闸（默认关）+ 上游总结开关。任一关掉，后台就不再产出反思与性格变化——
    // 这是"关掉自动总结后后台仍生成反思"的直接修复点。
    const config = loadMemoryConfig();
    if (!config.autoReflectionEnabled) return;
    if (!config.autoSummarizeEnabled) return;

    const last = getLastConsolidatedTimestamp(characterId);
    if (last && Date.now() - Date.parse(last) < MIN_INTERVAL_MS) return;

    const entries = await loadMemoryEntries(characterId);
    // 事实层才是原料：已有反思不能当新反思的证据（否则推断自我繁殖）；
    // 已作废 / 待重算的条目同样不作数，否则"被推翻的事"会继续被拿去推理。
    const fresh = (last ? entries.filter(e => e.createdAt > last) : entries)
        .filter(e => e.type === "long_term" && isRecallableEntry(e));
    // 新积累量太少（<4 条或累计重要性 <12）不值得一次反思调用
    const salienceSum = fresh.reduce((acc, e) => acc + effectiveSalience(e), 0);
    if (fresh.length < 4 || salienceSum < 12) {
        if (fresh.length === 0) setLastConsolidatedTimestamp(characterId, new Date().toISOString());
        return;
    }

    consolidatingSet.add(characterId);
    try {
        await runConsolidation(characterId, characterName, fresh, {
            driftEnabled: config.autoPersonaDriftEnabled === true,
        });
    } catch (error) {
        console.warn("[MemoryConsolidation] failed:", error);
    } finally {
        consolidatingSet.delete(characterId);
    }
}

/** 对所有角色跑一遍固化门控（空闲调度器调用）。 */
export async function runConsolidationSweep(
    characters: { id: string; name: string }[],
): Promise<void> {
    // 调度器入口也检查开关：省掉每个角色的读盘与门控开销，也让"关了就是关了"更直白。
    const config = loadMemoryConfig();
    if (!config.autoReflectionEnabled || !config.autoSummarizeEnabled) return;
    for (const c of characters) {
        try {
            await maybeRunConsolidation(c.id, c.name);
        } catch { /* 单角色失败不阻塞全局 */ }
    }
}

const REFLECTION_PROMPT = `你正在整理{{char}}自己已经记住的事。下面这些记忆是原料，不是要你换种说法再写一遍。

{{memories}}

只输出真正新的结论：必须同时用到至少两条记忆，而且只能是关于{{char}}自己的经历、感受或关系。
不要复述任何一条原料，不要把别人的行动写成{{char}}的经历，不要推测性格、依赖或黏人。
没有这样的新结论时，只输出 NONE。

否则每行一条，最多{{maxReflections}}条，不要输出别的内容：
REFLECTION|<一句话新结论>|EVIDENCE:<至少两个编号,逗号分隔>`;

const TRAIT_PROMPT_SECTION = `
只有多条记忆共同证明{{char}}自己的习惯发生了持续变化时，才可以额外写性格变化。没有就不要写。
不要根据一件事推测。不要写依赖、黏人、讨好，除非这些记忆的原文多次明确写出这种变化。
TRAIT|<性格维度>|<漂移量-1到1，绝对值至少${MIN_TRAIT_DELTA}>|<一句话描述{{char}}自己的变化>|EVIDENCE:<至少两个编号>
最多{{maxTraits}}条。`;

type ParsedReflection = { content: string; evidenceIdx: number[] };
type ParsedTrait = { key: string; delta: number; desc: string; evidenceIdx: number[] };

function parseConsolidationOutput(raw: string): { reflections: ParsedReflection[]; traits: ParsedTrait[] } {
    const reflections: ParsedReflection[] = [];
    const traits: ParsedTrait[] = [];
    const evidenceOf = (tail: string): number[] =>
        Array.from(tail.matchAll(/\d+/g)).map(m => Number(m[0])).filter(n => n > 0);
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim().replace(/^[-*]\s*/, "");
        const ref = /^REFLECTION\s*[|｜](.+?)(?:[|｜]\s*EVIDENCE\s*[:：]?\s*(.*))?$/i.exec(trimmed);
        if (ref) {
            const content = ref[1].trim();
            if (content) reflections.push({ content, evidenceIdx: evidenceOf(ref[2] ?? "") });
            continue;
        }
        const tr = /^TRAIT\s*[|｜]([^|｜]+)[|｜](-?\d*\.?\d+)[|｜](.+?)(?:[|｜]\s*EVIDENCE\s*[:：]?\s*(.*))?$/i.exec(trimmed);
        if (tr) {
            const key = tr[1].trim();
            const delta = Math.min(1, Math.max(-1, Number(tr[2]) || 0));
            const desc = tr[3].trim();
            if (key && desc && Math.abs(delta) >= 0.05) {
                traits.push({ key, delta, desc, evidenceIdx: evidenceOf(tr[4] ?? "") });
            }
        }
    }
    return { reflections: reflections.slice(0, MAX_REFLECTIONS), traits: traits.slice(0, MAX_TRAIT_SHIFTS) };
}

function normalizeMemoryText(value: string): string {
    return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function characterBigrams(value: string): Set<string> {
    const set = new Set<string>();
    if (value.length < 2) {
        if (value) set.add(value);
        return set;
    }
    for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
    return set;
}

function bigramJaccard(a: string, b: string): number {
    const ga = characterBigrams(a);
    const gb = characterBigrams(b);
    let inter = 0;
    for (const gram of ga) if (gb.has(gram)) inter++;
    const union = ga.size + gb.size - inter;
    return union > 0 ? inter / union : 0;
}

/**
 * 新反思 / 新性格变化入库前的拦截：相等、互相包含、较高重叠，或短句几乎被另一句盖住。
 * 不用于删除已有记忆。
 */
export function isNearDuplicateMemoryText(a: string, b: string): boolean {
    const na = normalizeMemoryText(a);
    const nb = normalizeMemoryText(b);
    if (!na.length || !nb.length) return false;
    if (na === nb) return true;
    const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
    if (shorter.length >= 8 && longer.includes(shorter)) return true;
    if (bigramJaccard(na, nb) >= DEDUPE_SIMILARITY) return true;
    const ga = characterBigrams(na);
    const gb = characterBigrams(nb);
    let inter = 0;
    for (const gram of ga) if (gb.has(gram)) inter++;
    const smaller = Math.min(ga.size, gb.size);
    return smaller >= 6 && inter / smaller >= 0.8;
}

/** 已有条目的合并仍要几乎逐字相同，避免把两件不同的事收成一条。 */
function isSameWording(a: string, b: string): boolean {
    const na = normalizeMemoryText(a);
    const nb = normalizeMemoryText(b);
    if (!na.length || !nb.length) return false;
    if (na === nb) return true;
    return bigramJaccard(na, nb) >= 0.9;
}

export async function runConsolidation(
    characterId: string,
    characterName: string,
    freshEntries?: MemoryEntry[],
    options?: {
        /** 手动触发（记忆页"整理记忆"按钮 / 角色工具）：不受反思总闸限制。 */
        manual?: boolean;
        /** 性格漂移开关；缺省按当前配置读。 */
        driftEnabled?: boolean;
    },
): Promise<ConsolidationResult> {
    const manual = options?.manual === true;

    // 自动运行的总闸兜底：调用方（maybeRunConsolidation）已经检查过一次，
    // 这里再查一次是为了防住"直接调用 runConsolidation 的新入口"漏检。
    if (!manual) {
        const gate = currentSwitches();
        if (!gate.autoReflectionEnabled || !gate.autoSummarizeEnabled) {
            return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: "反思开关未打开" };
        }
    }

    // 主对话绑定优先（与总结管线一致：反思必须用角色本体模型）
    const bindings = loadBindingConfig();
    const mainSlotApiId = resolveBinding(bindings, characterId).apiConfigId;
    const apiConfig = (mainSlotApiId ? loadApiConfigs().find(c => c.id === mainSlotApiId) : undefined)
        ?? resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: "未配置 API" };
    }

    const all = (await loadMemoryEntries(characterId)).filter(e => e.type === "long_term");
    // 原料与证据都取"可召回的事实层"：已有反思不能当新反思的证据（否则推断会自我繁殖），
    // 已作废 / 待重算的条目也不能当证据（否则被推翻的事会继续支撑新推断）。
    const factEntries = all.filter(e => isRecallableEntry(e));
    const last = getLastConsolidatedTimestamp(characterId);
    const candidates = (freshEntries ?? (last ? factEntries.filter(e => e.createdAt > last) : factEntries))
        .filter(e => e.type === "long_term" && isRecallableEntry(e))
        .sort((a, b) => effectiveSalience(b) - effectiveSalience(a))
        .slice(0, REFLECTION_CANDIDATE_LIMIT);

    if (candidates.length < 4) {
        setLastConsolidatedTimestamp(characterId, new Date().toISOString());
        return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: "素材不足" };
    }

    const memoriesText = candidates
        .map((e, i) => `[${i + 1}] (重要性${effectiveSalience(e)}) ${e.content}`)
        .join("\n");

    const driftEnabled = options?.driftEnabled ?? (loadMemoryConfig().autoPersonaDriftEnabled === true);
    const prompt = `${REFLECTION_PROMPT}${driftEnabled ? TRAIT_PROMPT_SECTION : ""}`
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{memories\}\}/gi, memoriesText)
        .replace(/\{\{maxReflections\}\}/gi, String(MAX_REFLECTIONS))
        .replace(/\{\{maxTraits\}\}/gi, String(MAX_TRAIT_SHIFTS));

    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.4 });
    if (!result.content || result.wasTruncated) {
        return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: result.error || "空输出/截断" };
    }

    // 在途保护：请求往返期间用户可能把反思关掉了。自动运行此刻必须放弃写入，
    // 否则"关了开关还在生成反思"会从这条竞态路径复活。
    if (!manual) {
        const nowSwitches = currentSwitches();
        if (!nowSwitches.autoReflectionEnabled || !nowSwitches.autoSummarizeEnabled) {
            logMemoryTask({
                task: "consolidation(auto)",
                characterId,
                switches: nowSwitches,
                action: "skip",
                outcome: "LLM 返回时开关已关闭，放弃写入",
            });
            return { ran: false, reflections: 0, traitShifts: 0, deduped: 0, error: "开关已关闭" };
        }
    }

    const parsed = parseConsolidationOutput(result.content);
    const now = new Date().toISOString();
    let reflectionCount = 0;
    let traitCount = 0;

    const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    const embeddingEnabled = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig!));

    const existingLongTerm = all.filter(e => e.type === "long_term");
    const roster = buildMemoryRoster(loadCharacters(), characterId, characterName);
    const evidenceIdsFor = (idx: number[]): string[] =>
        idx.map(i => candidates[i - 1]?.id).filter((id): id is string => Boolean(id));
    const acceptedReflectionTexts: string[] = [];

    for (const ref of parsed.reflections) {
        // 证据编号必须有效且唯一；而且至少要两条**独立事件**。
        // 一条 summary 与它派生的 episode 共享 eventId —— 它们是同一次经历的两面，
        // 不能各算一份证据，否则"一件事"就能凑出"两条记忆共同证明"的假象。
        const validIdx = Array.from(new Set(ref.evidenceIdx.filter(index => index >= 1 && index <= candidates.length)));
        if (validIdx.length < 2) continue;
        const distinctEvents = new Set(validIdx.map(index => memoryEventIdOf(candidates[index - 1])));
        if (distinctEvents.size < 2) continue;
        const evidenceTexts = validIdx
            .map(index => candidates[index - 1]?.content)
            .filter((content): content is string => Boolean(content));
        const duplicateOf = [...existingLongTerm.map(entry => entry.content), ...acceptedReflectionTexts];
        if (duplicateOf.some(content => isNearDuplicateMemoryText(content, ref.content))) continue;
        if (evidenceTexts.some(content => isNearDuplicateMemoryText(content, ref.content))) continue;
        if (isForeignMemoryText(ref.content, roster.selfNames, roster.otherNames)) continue;
        let embedding: number[] | undefined;
        if (embeddingEnabled) {
            try {
                embedding = (await generateEmbedding(ref.content, embeddingApiConfig!)) ?? undefined;
            } catch { /* ignore */ }
        }
        const id = `mem_rf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await saveMemoryEntry({
            id,
            characterId,
            sourceApp: "chat",
            type: "long_term",
            kind: "reflection",
            content: ref.content,
            embedding,
            importance: 0.9,
            salience: 9,
            links: evidenceIdsFor(validIdx),
            createdAt: now,
            updatedAt: now,
            metadata: {
                generatedBy: "consolidation",
                // 反思是推断，不是事实：标出性质并单独保存，不自动进入核心、不改写人物卡。
                contentKind: "reflection",
                sourceKind: "character_said",
                occurredAt: now,
                status: "active",
                revision: 1,
            },
        });
        acceptedReflectionTexts.push(ref.content);
        reflectionCount++;
    }

    const activeTraitKeys = new Set(loadPersonaState(characterId).traits.map(trait => trait.key));
    const existingTraitTexts = existingLongTerm
        .filter(entry => memoryKindOf(entry) === "trait_shift")
        .map(entry => entry.content);

    for (const tr of driftEnabled ? parsed.traits : []) {
        // 与反思同样的证据门槛：编号有效唯一，且至少两条**独立事件**。
        const traitIdx = Array.from(new Set(tr.evidenceIdx.filter(index => index >= 1 && index <= candidates.length)));
        if (traitIdx.length < 2) continue;
        if (new Set(traitIdx.map(index => memoryEventIdOf(candidates[index - 1]))).size < 2) continue;
        if (Math.abs(tr.delta) < MIN_TRAIT_DELTA) continue;
        if (activeTraitKeys.has(tr.key)) continue;
        const traitText = `性格变化：${tr.desc}（${tr.key} ${tr.delta > 0 ? "+" : ""}${tr.delta}）`;
        if (existingTraitTexts.some(content => isNearDuplicateMemoryText(content, traitText) || isNearDuplicateMemoryText(content, tr.desc))) {
            continue;
        }
        const id = `mem_ts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const evidenceIds = evidenceIdsFor(traitIdx);
        await saveMemoryEntry({
            id,
            characterId,
            sourceApp: "chat",
            type: "long_term",
            kind: "trait_shift",
            content: traitText,
            importance: 0.85,
            salience: 8,
            links: evidenceIds,
            createdAt: now,
            updatedAt: now,
            metadata: {
                generatedBy: "consolidation",
                traitKey: tr.key,
                delta: tr.delta,
                contentKind: "reflection",
                occurredAt: now,
                status: "active",
                revision: 1,
            },
        });
        applyTraitShift(characterId, {
            traitKey: tr.key,
            delta: tr.delta,
            confidence: Math.min(1, 0.3 + evidenceIds.length * 0.2),
            evidenceEntryIds: evidenceIds,
            change: `${tr.desc}（${tr.key} ${tr.delta > 0 ? "+" : ""}${tr.delta.toFixed(2)}）`,
            sourceEntryId: id,
        });
        activeTraitKeys.add(tr.key);
        existingTraitTexts.push(traitText);
        traitCount++;
    }

    // 去重合并：同 kind 且内容近似 → 保新删旧、links 并集迁移到新条目
    let deduped = 0;
    const longTerm = (await loadMemoryEntries(characterId)).filter(e => e.type === "long_term");
    const byKind = new Map<string, MemoryEntry[]>();
    for (const e of longTerm) {
        const k = memoryKindOf(e);
        const list = byKind.get(k) ?? [];
        list.push(e);
        byKind.set(k, list);
    }
    const toDelete = new Set<string>();
    for (const list of byKind.values()) {
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            if (toDelete.has(a.id)) continue;
            for (let j = i + 1; j < list.length; j++) {
                const b = list[j];
                if (toDelete.has(b.id)) continue;
                if (!isSameWording(a.content, b.content)) continue;
                const [keep, drop] = a.createdAt >= b.createdAt ? [a, b] : [b, a];
                const mergedLinks = Array.from(new Set([...(keep.links ?? []), ...(drop.links ?? [])]));
                if (mergedLinks.length !== (keep.links?.length ?? 0)) {
                    keep.links = mergedLinks;
                    keep.updatedAt = now;
                    await saveMemoryEntry(keep);
                }
                toDelete.add(drop.id);
                deduped++;
            }
        }
    }
    if (toDelete.size) await deleteMemoryEntries([...toDelete]);

    setLastConsolidatedTimestamp(characterId, now);
    console.log(`[MemoryConsolidation] ${characterName}: ${reflectionCount} reflections, ${traitCount} trait shifts, ${deduped} deduped`);
    logMemoryTask({
        task: manual ? "consolidation(manual)" : "consolidation(auto)",
        characterId,
        switches: currentSwitches(),
        action: reflectionCount > 0 || traitCount > 0 ? "create" : "skip",
        outcome: `反思 ${reflectionCount} / 性格 ${traitCount} / 合并去重 ${deduped}`,
    });
    return { ran: true, reflections: reflectionCount, traitShifts: traitCount, deduped };
}
