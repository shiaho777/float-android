// lib/memory-recall-log.ts
// 记忆检索日志：可检查、可关闭、有限容量、只存本机、不含 API 密钥。
//
// 为什么需要它：记忆出错时（"明明记过却想不起来"、"推测变成了事实"）没有现场可查——
// 只有模型最终说了什么，看不到它当时拿到的是哪几条记忆、分数怎么算出来的、谁被挤掉了。
// 这个模块把每轮召回的决策、各后台任务执行时的开关状态，以及记忆的新增/合并/归档动作
// 记成一条条紧凑记录，出错时能倒查。
//
// 存储：kv（IndexedDB，同步内存缓存 + 异步落盘），环形，超出容量丢最旧。
// 默认开启，可在记忆设置里关闭（MemoryConfig.memoryRecallLogEnabled）。
// 导出走 exportMemoryRecallLog()：递归剔除任何名字像密钥的字段。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadMemoryConfig } from "./memory-storage";

const LOG_KEY = "ai_phone_mem_recall_log";
/** 环形容量。调小是为了控制每次生成时的序列化开销。 */
const LOG_CAP = 150;
/** 单条摘录上限，避免日志本身变成大对象。 */
const EXCERPT_MAX = 60;

registerKvMigration(LOG_KEY);

export type MemoryScoreParts = {
    /** 四维打分的各分项（归一化权重后的实际贡献值） */
    recency: number;
    salience: number;
    relevance: number;
    novelty: number;
    /** 相关性拆开看：向量余弦 / 文字相关（批内归一化后） */
    vectorRelevance: number;
    lexicalRelevance: number;
};

export type MemoryLogCandidate = {
    id: string;
    kind: string;
    score: number;
    parts: MemoryScoreParts;
    /** 未入选者必填：为什么没进去 */
    reason?: string;
    excerpt: string;
};

export type MemoryRecallLogEntry = {
    id: string;
    at: string;
    kind: "recall" | "core-recall" | "task" | "write";
    characterId?: string;
    /** ── recall ── */
    /** 检索方式：向量+文字混合 / 只有文字兜底 */
    mode?: "vector+lexical" | "lexical-only";
    /** 这一轮有没有可用的向量（无向量时必须仍能靠文字召回） */
    vectorValid?: boolean;
    /** 本轮检索主线（当前用户消息 + 最近对话） */
    focus?: string;
    /** 背景上下文（世界书命中 / 日程等） */
    background?: string;
    /** 真正进了提示词的条目（仅事实层，排序后） */
    selected?: MemoryLogCandidate[];
    /** 差一点入选的候选（用于判断"为什么没想起那件事"） */
    nearMiss?: MemoryLogCandidate[];
    /** ── task / write ── */
    task?: string;
    action?: "create" | "merge" | "supersede" | "archive" | "skip";
    switches?: Record<string, boolean>;
    outcome?: string;
    entryId?: string;
};

function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX)}…` : flat;
}

/** 供调用方复用同一套截断口径（日志只存摘录，不存整条记忆）。 */
export function excerptForLog(text: string): string {
    return excerpt(text);
}

function makeId(): string {
    return `mlog_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 日志是否开启。开关本身存在 MemoryConfig 里，这里只读，不另立一份状态。 */
export function isMemoryRecallLogEnabled(): boolean {
    try {
        return loadMemoryConfig().memoryRecallLogEnabled !== false;
    } catch {
        return false;
    }
}

/** 当前记忆相关开关的快照，写进日志用（"执行任务及开关状态"）。不含任何密钥。 */
export function memorySwitchSnapshot(): Record<string, boolean> {
    const config = loadMemoryConfig();
    return {
        autoSummarizeEnabled: config.autoSummarizeEnabled === true,
        autoBuildCoreEnabled: config.autoBuildCoreEnabled === true,
        autoReflectionEnabled: config.autoReflectionEnabled === true,
        autoPersonaDriftEnabled: config.autoPersonaDriftEnabled === true,
        vectorRecallEnabled: config.vectorRecallEnabled === true,
        memoryRecallLogEnabled: config.memoryRecallLogEnabled !== false,
    };
}

export function readMemoryRecallLog(): MemoryRecallLogEntry[] {
    if (typeof window === "undefined") return [];
    const raw = kvGet(LOG_KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as MemoryRecallLogEntry[]) : [];
    } catch {
        return []; // 坏数据不阻塞召回
    }
}

/**
 * 追加一条日志。关闭时静默跳过（调用方无需自己判断开关）。
 * 写入走 kvSet（同步进内存缓存 + 异步入库），不阻塞生成。
 */
export function appendMemoryRecallLog(
    entry: Omit<MemoryRecallLogEntry, "id" | "at"> & { id?: string; at?: string },
): void {
    if (typeof window === "undefined") return;
    if (!isMemoryRecallLogEnabled()) return;
    try {
        const full: MemoryRecallLogEntry = {
            ...entry,
            id: entry.id ?? makeId(),
            at: entry.at ?? new Date().toISOString(),
        };
        const next = [...readMemoryRecallLog(), full];
        kvSet(LOG_KEY, JSON.stringify(next.length > LOG_CAP ? next.slice(-LOG_CAP) : next));
    } catch {
        // 记日志失败绝不能影响聊天
    }
}

/** 记录一次后台任务执行及其开关状态（总结 / 核心 / 整理）。 */
export function logMemoryTask(params: {
    task: string;
    characterId?: string;
    switches: Record<string, boolean>;
    action?: MemoryRecallLogEntry["action"];
    outcome?: string;
    entryId?: string;
}): void {
    appendMemoryRecallLog({
        kind: "task",
        characterId: params.characterId,
        task: params.task,
        switches: params.switches,
        action: params.action ?? "skip",
        outcome: params.outcome,
        entryId: params.entryId,
    });
}

/** 记录一次记忆写入动作（新增 / 合并 / 替代 / 归档）。 */
export function logMemoryWrite(params: {
    action: NonNullable<MemoryRecallLogEntry["action"]>;
    characterId?: string;
    entryId?: string;
    outcome?: string;
}): void {
    appendMemoryRecallLog({
        kind: "write",
        characterId: params.characterId,
        action: params.action,
        entryId: params.entryId,
        outcome: params.outcome,
    });
}

export function clearMemoryRecallLog(): void {
    if (typeof window === "undefined") return;
    kvSet(LOG_KEY, "[]");
}

/** 递归剔除任何名字像密钥的字段，导出文件可以安全分享。 */
function sanitize(value: unknown, depth = 0): unknown {
    if (depth > 8 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (/key|token|secret|password|authorization|apikey/i.test(key)) {
            out[key] = "[redacted]";
            continue;
        }
        out[key] = sanitize(raw, depth + 1);
    }
    return out;
}

/**
 * 导出脱敏诊断文件内容。
 * 只包含日志本身；不含任何用户配置里的密钥（重复一遍：字段名像密钥的一律替换）。
 */
export function exportMemoryRecallLog(): string {
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        version: 1,
        entries: sanitize(readMemoryRecallLog()),
    }, null, 2);
}
