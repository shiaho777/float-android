// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import {
    effectiveSalience,
    isPinnedEntry,
    isRecallableEntry,
    memoryKindOf,
    memoryOccurredAtOf,
    memoryStatusOf,
    isArchivedEntry,
    type MemorySurfacedRecord,
} from "./memory-types";
import { loadMemoryEntriesByType, loadMemorySurfacedRecords, markMemorySurfaced } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import {
    generateEmbedding,
    resolveEmbeddingModel,
    cosineSimilarity,
    prepareLexicalQuery,
    lexicalRelevanceScore,
} from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { appendMemoryRecallLog, excerptForLog, type MemoryLogCandidate, type MemoryScoreParts } from "./memory-recall-log";

/**
 * 检索输入。主线（focus）是当前用户消息 + 最近几轮对话；背景（background）是世界书
 * 命中、日程这类"当时挂着"的环境信息。
 *
 * 分开是为了不被背景带跑偏：以前整轮只喂 wbActivationContext，日历和今日世界里的
 * 无关事件会主导词表，真正相关的旧记忆反而检索不到。
 */
export type MemoryRetrievalQuery = {
    /** 本轮主线：当前用户消息 + 最近几轮对话。文字/语义相关性的主要来源。 */
    focus: string;
    /** 背景上下文。只在主线没命中时补位，权重更低。 */
    background?: string;
};

/** 背景上下文在文字相关性里的权重（主线命中优先，背景只是补位）。 */
const BACKGROUND_QUERY_WEIGHT = 0.4;
/** 固定保留条目在长期注入预算里独占的份额，避免被新条目整块挤出。 */
const RESERVED_BUDGET_RATIO = 0.3;
/** 日志里记录多少条"差一点入选"的候选。 */
const NEAR_MISS_LIMIT = 6;

/**
 * Retrieve relevant long-term memories for prompt injection.
 *
 * **混合检索**：向量语义（可用时）+ 文字相关（永远可用），合并后按四维打分排序。
 *
 *   score = recency·新近 + salience·重要性 + relevance·相关性 + novelty·新鲜度
 *
 * - recency    半衰期 ~7 天：越久远的经历越淡
 * - salience   LLM 评的重要性
 * - relevance  **max(向量余弦, 文字相关)**，文字相关做批内归一化（见下）
 * - novelty    刚讲过、反复讲过的降权 → 同一批陈年旧事不会天天霸榜
 *
 * 三条曾经的坑，现在都在这里堵上：
 *   1. 没有向量时 relevance 归零 → 明确提到关键词的旧记忆永远进不来。现在文字检索兜底。
 *   2. "总量没超预算就整包返回"的捷径 → 相关性排序作废、每轮拿到一模一样的记忆。已删除。
 *   3. reflection / trait_shift 是**推断**不是事实 —— 不参与事实召回，也不再吃加成。
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    query: string | MemoryRetrievalQuery,
    config: MemoryConfig,
    options?: { trackSurfacing?: boolean },
): Promise<MemoryEntry[]> {
    const { focus, background, embeddingText } = resolveQuery(query);
    if (!embeddingText) return [];

    // 事实层候选：归档、已作废/待重算、以及推断层（reflection / trait_shift）都不参与事实召回。
    // 归档 = 容量清理的落点（只标记不删除，可恢复）；推断层没有自己的原始证据，
    // 让它们与事实混排正是"推测逐渐变成事实"的入口。
    const longTermEntries = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(entry => isRecallableEntry(entry));
    if (longTermEntries.length === 0) return [];

    const budget = config.longTermTokenBudget;
    const nowMs = Date.now();

    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    const queryEmbedding = embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)
        ? await generateEmbedding(embeddingText, embeddingApiConfig).catch(() => null)
        : null;

    // ── 文字相关（永远可用，不依赖向量服务）──
    const focusTokens = prepareLexicalQuery(focus);
    const backgroundTokens = background ? prepareLexicalQuery(background) : null;
    const rawLexical = longTermEntries.map(entry => {
        const fromFocus = lexicalRelevanceScore(focusTokens, entry.content);
        const fromBackground = backgroundTokens ? lexicalRelevanceScore(backgroundTokens, entry.content) : 0;
        return Math.max(fromFocus, fromBackground * BACKGROUND_QUERY_WEIGHT);
    });
    const maxLexical = rawLexical.reduce((max, value) => (value > max ? value : max), 0);

    const surfacedRecords = loadMemorySurfacedRecords(longTermEntries.map(entry => entry.id));

    // 有向量 → 四维（语义相关性占大头）；没有向量 → 同样四维，只是相关性由文字兜底。
    // 两条车道都保留 relevance 权重，不再出现"没向量就白丢相关性"的三维归一化。
    const hybridWeights = { recency: 0.25, salience: 0.2, relevance: 0.35, novelty: 0.2 };
    const lexicalWeights = { recency: 0.3, salience: 0.25, relevance: 0.25, novelty: 0.2 };

    const scored = longTermEntries.map((entry, index) => {
        const entryEmbedding = queryEmbedding && entry.embedding?.length ? entry.embedding : null;
        const vectorRelevance = entryEmbedding && queryEmbedding
            ? Math.max(0, cosineSimilarity(queryEmbedding, entryEmbedding))
            : 0;
        // 批内归一化：这一批里文字上最像的一条记 1.0。长查询的词元覆盖天然偏低，
        // 不归一化的话"关键词命中了"会被 0.1 这类覆盖率稀释成噪声。
        const lexicalRelevance = maxLexical > 0 ? rawLexical[index] / maxLexical : 0;
        const relevance = Math.max(vectorRelevance, lexicalRelevance);

        const weights = entryEmbedding ? hybridWeights : lexicalWeights;
        const parts: MemoryScoreParts = {
            recency: weights.recency * recencyScoreOf(entry, nowMs),
            salience: weights.salience * salienceScoreOf(entry),
            relevance: weights.relevance * relevance,
            novelty: weights.novelty * noveltyScoreOf(surfacedRecords.get(entry.id), nowMs),
            vectorRelevance,
            lexicalRelevance,
        };
        const score = parts.recency + parts.salience + parts.relevance + parts.novelty;
        return { entry, score, parts };
    });
    scored.sort((a, b) => b.score - a.score
        || memoryOccurredAtOf(a.entry).localeCompare(memoryOccurredAtOf(b.entry)));

    // 固定保留（metadata.pinned）走独立预算车道：关系事实不该被一堆新条目挤出上下文。
    const reservedBudget = Math.round(budget * RESERVED_BUDGET_RATIO);
    const pinnedItems = scored.filter(item => isPinnedEntry(item.entry));
    const generalItems = scored.filter(item => !isPinnedEntry(item.entry));
    const pickedPinned = fillByBudget(pinnedItems, reservedBudget);
    const pinnedTokens = pickedPinned.reduce((sum, entry) => sum + budgetCost(entry), 0);
    const pickedGeneral = fillByBudget(generalItems, Math.max(0, budget - pinnedTokens));
    const selected = [...pickedPinned, ...pickedGeneral];
    // 输出按时间正序：读起来仍是一段有先后的经历，而不是按分数乱排的清单
    selected.sort((a, b) => memoryOccurredAtOf(a).localeCompare(memoryOccurredAtOf(b)));

    if (config.memoryRecallLogEnabled !== false) {
        logRecall({
            characterId,
            focus,
            background,
            vectorValid: Boolean(queryEmbedding),
            scored,
            selected,
            budget,
            usedTokens: selected.reduce((sum, entry) => sum + budgetCost(entry), 0),
        });
    }

    // 记账：本轮真正进了提示词 → 下一轮新鲜度自然下降。同步写 kv 缓存，不阻塞生成。
    // trackSurfacing=false 给"记忆不是喂给模型、而是交给自定义 APP 当数据"的读用——
    // 那种读取没往任何提示词里塞东西，不该让召回权重偏移。
    // （核心记忆按关系事实稳定注入、不参与轮换，所以不记账。）
    if (options?.trackSurfacing !== false) {
        markMemorySurfaced(selected.map(entry => entry.id), new Date(nowMs).toISOString());
    }

    return selected;
}

/** 拼检索主线时取最近几轮对话。 */
const MEMORY_QUERY_RECENT_TURNS = 6;
/** 主线正文上限，避免长历史把词表撑爆、也让 tokenize 保持廉价。 */
const MEMORY_QUERY_FOCUS_MAX = 1200;

/**
 * 从最近对话构造检索输入。
 *
 * 主线 = 最近几轮对话 + **最后一条用户消息单独再放一次**（让它在词表里占比更高，
 * 不被旁支对话稀释）；背景 = 世界书命中/日程这类环境信息，权重更低。
 *
 * 结构化类型而不是 ChatMessage：memory-service 不该依赖聊天模块的形状，
 * 调用方传 { role, content } 数组即可。
 */
export function buildMemoryRetrievalQuery(
    recentMessages: { role: string; content?: string | null }[],
    background?: string,
): MemoryRetrievalQuery {
    const tail = recentMessages.slice(-MEMORY_QUERY_RECENT_TURNS);
    const focusParts: string[] = [];
    for (const message of tail) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = (message.content ?? "").trim();
        if (text) focusParts.push(text);
    }
    const lastUser = [...tail].reverse().find(
        message => message.role === "user" && (message.content ?? "").trim(),
    );
    if (lastUser) focusParts.push((lastUser.content ?? "").trim());

    const focus = focusParts.join("\n").slice(-MEMORY_QUERY_FOCUS_MAX);
    return { focus, background: background?.trim() || undefined };
}

function resolveQuery(query: string | MemoryRetrievalQuery): {
    focus: string;
    background: string;
    embeddingText: string;
} {
    if (typeof query === "string") {
        const text = query.trim();
        return { focus: text, background: "", embeddingText: text };
    }
    const focus = (query.focus ?? "").trim();
    const background = (query.background ?? "").trim();
    return { focus, background, embeddingText: [focus, background].filter(Boolean).join("\n") };
}

function recencyScoreOf(entry: MemoryEntry, nowMs: number): number {
    // 用**发生时间**而不是写入时间：导入或重建索引后，一件旧事不该因为是刚写入的
    // 就被当成"刚发生"，把真正的近期经历挤掉。
    const ageDays = Math.max(0, (nowMs - new Date(memoryOccurredAtOf(entry)).getTime()) / 86400000);
    return Math.exp(-ageDays / 7);
}

function salienceScoreOf(entry: MemoryEntry): number {
    return effectiveSalience(entry) / 10;
}

/**
 * 新鲜度：刚讲过、反复讲过的记忆降权，从未提起的给满分。
 * 半衰期 ~1.4 天 + 计数惩罚——这是让"同一批记忆天天霸榜"自己散开的机关。
 */
function noveltyScoreOf(record: MemorySurfacedRecord | undefined, nowMs: number): number {
    if (!record || !record.at) return 1;
    const lastMs = Date.parse(record.at);
    if (!Number.isFinite(lastMs)) return 1;
    const ageDays = Math.max(0, (nowMs - lastMs) / 86400000);
    return Math.exp(-ageDays / 2) / (1 + 0.5 * record.count);
}

/**
 * 取核心记忆。核心按关系事实稳定注入、不参与轮换，也不记账。
 * 归档条目与已作废/待重算条目都不再注入。
 */
export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = (await loadMemoryEntriesByType(characterId, "core"))
        .filter(entry => !isArchivedEntry(entry) && memoryStatusOf(entry) === "active");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.occurredAt ?? a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.occurredAt ?? b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    const selected = fillByBudget(sorted.map(entry => ({ entry })), config.coreMemoryTokenBudget);

    if (config.memoryRecallLogEnabled !== false) {
        appendMemoryRecallLog({
            kind: "core-recall",
            characterId,
            selected: selected.map(entry => ({
                id: entry.id,
                kind: memoryKindOf(entry),
                score: effectiveSalience(entry) / 10,
                parts: emptyParts(),
                excerpt: excerptForLog(entry.content),
            })),
            outcome: `核心记忆 ${selected.length}/${coreEntries.length} 条入选`,
        });
    }

    return selected;
}

function emptyParts(): MemoryScoreParts {
    return { recency: 0, salience: 0, relevance: 0, novelty: 0, vectorRelevance: 0, lexicalRelevance: 0 };
}

/** 条目在预算里的成本（与 fillByBudget 的记账口径必须一致）。 */
function budgetCost(entry: MemoryEntry): number {
    return estimateTokens(entry.content) + 4;
}

/**
 * 按顺序挑条目直到预算用尽。
 *
 * 用 continue 而不是 break：条目是按分数排序的，某一条超预算不能把后面所有
 * 更小的条目一起丢——预算调小（最低 200 token）时 break 会让整块长期记忆变空。
 */
function fillByBudget<T extends { entry: MemoryEntry }>(items: T[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const item of items) {
        const tokens = budgetCost(item.entry);
        if (used + tokens > budget) continue;
        result.push(item.entry);
        used += tokens;
    }
    return result;
}

function round(value: number): number {
    return Number(value.toFixed(4));
}

function logRecall(params: {
    characterId: string;
    focus: string;
    background: string;
    vectorValid: boolean;
    scored: { entry: MemoryEntry; score: number; parts: MemoryScoreParts }[];
    selected: MemoryEntry[];
    budget: number;
    usedTokens: number;
}): void {
    const selectedIds = new Set(params.selected.map(entry => entry.id));
    const toCandidate = (
        item: { entry: MemoryEntry; score: number; parts: MemoryScoreParts },
        reason?: string,
    ): MemoryLogCandidate => ({
        id: item.entry.id,
        kind: memoryKindOf(item.entry),
        score: round(item.score),
        parts: {
            recency: round(item.parts.recency),
            salience: round(item.parts.salience),
            relevance: round(item.parts.relevance),
            novelty: round(item.parts.novelty),
            vectorRelevance: round(item.parts.vectorRelevance),
            lexicalRelevance: round(item.parts.lexicalRelevance),
        },
        reason,
        excerpt: excerptForLog(item.entry.content),
    });

    const remaining = params.budget - params.usedTokens;
    appendMemoryRecallLog({
        kind: "recall",
        characterId: params.characterId,
        mode: params.vectorValid ? "vector+lexical" : "lexical-only",
        vectorValid: params.vectorValid,
        focus: params.focus.slice(0, 120),
        background: params.background ? params.background.slice(0, 120) : undefined,
        selected: params.scored.filter(item => selectedIds.has(item.entry.id)).map(item => toCandidate(item)),
        nearMiss: params.scored
            .filter(item => !selectedIds.has(item.entry.id))
            .slice(0, NEAR_MISS_LIMIT)
            .map(item => toCandidate(
                item,
                budgetCost(item.entry) > remaining ? "剩余预算放不下" : "分数低于已入选条目",
            )),
    });
}
