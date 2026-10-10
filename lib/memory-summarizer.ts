// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry, MemoryContentKind, MemorySourceKind } from "./memory-types";
import {
    DEFAULT_SUMMARIZATION_PROMPT,
    DEFAULT_SUMMARIZATION_PROMPT_V2,
    DEFAULT_SUMMARIZATION_PROMPT_V3,
    LEGACY_SUMMARIZATION_PROMPT_V2,
    isProtectedEntry,
    memoryBatchKeyOf,
} from "./memory-types";
import { loadCharacters } from "./character-storage";
import { buildMemoryRoster, isForeignMemoryText, retainPersonalMemoryProse } from "./group-memory-scope";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntry,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { loadApiConfigs, loadBindingConfig, resolveAuxiliaryApiConfig, resolveBinding } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import { maybeRunConsolidation } from "./memory-consolidation";
import { logMemoryTask, logMemoryWrite, memorySwitchSnapshot } from "./memory-recall-log";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * 写在用户可编辑总结提示词之后，不能被预设或世界书拿掉。
 * 群聊素材已经按亲历过滤；这里再拦住模型把旁人的事改写成这个角色的经历。
 */
const PERSONAL_MEMORY_ATTRIBUTION_RULE = `归属约束（必须遵守，覆盖上面模板里与此冲突的要求）：
- 只记录{{char}}自己做的事、说的话，以及别人直接对{{char}}说的、直接发生在{{char}}身上的事。
- 其他角色自己的行动、行程、情绪、朋友圈和日记不是{{char}}的经历。不要写进 SUMMARY，也不要写成 EPISODE。
- 每条 EPISODE 都要能看出{{char}}本人在场并参与。整句只有别人的名字时，不要输出这一条。
- 不要把「某人做了某事」改写成{{char}}做的。素材里{{char}}没参与的事，就当没发生过。
- 用户告诉{{char}}的事实可以保留，但要写成「用户告诉{{char}}……」，不能写成{{char}}自己的经历。`;

export type ParsedEpisode = {
    salience: number;
    content: string;
    /** 支持这一条的事件编号（1 起，对应传入事件记录的顺序）；空 = 模型没给证据 */
    evidenceIdx: number[];
};

export type ParsedSummarizationOutput = {
    summary: string;
    episodes: ParsedEpisode[];
    /** 输出里是否出现结构化标记（SUMMARY: / EPISODE| / EPISODES:）。 */
    structured: boolean;
};

/**
 * 解析总结输出：SUMMARY: 段 + EPISODE|<1-10>|<内容>[|EVIDENCE:<编号,…>] 行。
 *
 * v3 起每条 EPISODE 要带 `EVIDENCE:<事件编号>`，好让每条记忆**定位到自己的证据**，
 * 而不是把整批消息无差别挂给所有条目。仍然兼容 v2 的无 EVIDENCE 行。
 *
 * `structured` 交给调用方判断"这次输出到底按格式来了没有"：用内置结构化模板时，
 * 一段没有任何标记的输出很可能是拒答 / 报错 / 跑题，不该被存成一条有效记忆。
 */
export function parseSummarizationOutput(raw: string): ParsedSummarizationOutput {
    const text = raw.trim();
    const episodes: ParsedEpisode[] = [];
    // 内容用惰性匹配、EVIDENCE 组可选并锚在行尾：既吃 v3 的带证据行，也吃 v2 的裸行。
    const episodeRe = /^\s*(?:[-*]\s*)?EPISODE\s*[|｜]\s*(\d{1,2})\s*[|｜]\s*(.+?)\s*(?:[|｜]\s*EVIDENCE\s*[:：]?\s*([\d\s,，、]+))?\s*$/gim;
    let match: RegExpExecArray | null;
    let firstEpisodeStart = -1;
    while ((match = episodeRe.exec(text)) !== null) {
        if (firstEpisodeStart === -1) firstEpisodeStart = match.index;
        const salience = Math.min(10, Math.max(1, Number(match[1]) || 1));
        const content = match[2].trim();
        const evidenceIdx = Array.from(new Set(
            (match[3] ?? "")
                .split(/[\s,，、]+/)
                .map(part => Number(part))
                .filter(value => Number.isFinite(value) && value > 0),
        ));
        if (content) episodes.push({ salience, content, evidenceIdx });
    }

    const hasSummaryMarker = /SUMMARY\s*[:：]/i.test(text);
    const hasEpisodesHeader = /^\s*EPISODES?\s*[:：]?\s*$/im.test(text);
    const structured = hasSummaryMarker || hasEpisodesHeader || episodes.length > 0;

    // SUMMARY: 段 = "SUMMARY:" 到 "EPISODES:" 或第一条 EPISODE 行之间
    const summaryMatch = /SUMMARY\s*[:：]/i.exec(text);
    let summary = "";
    if (summaryMatch) {
        const start = summaryMatch.index + summaryMatch[0].length;
        const tail = text.slice(start);
        const episodesHeader = /^\s*EPISODES?\s*[:：]?\s*$/im.exec(tail);
        const episodeLineIdx = firstEpisodeStart > start ? firstEpisodeStart - start : -1;
        const cutAt = episodesHeader
            ? episodesHeader.index
            : (episodeLineIdx >= 0 ? episodeLineIdx : tail.length);
        summary = tail.slice(0, cutAt).trim();
    }
    if (!summary) {
        // 无结构标记：剥掉 EPISODE 行后整体当摘要（用户自定义纯文本提示词走这条）
        summary = text.replace(episodeRe, "").replace(/EPISODES\s*[:：]?\s*$/im, "").trim();
    }
    if (!summary) summary = text;
    return { summary, episodes, structured };
}

/**
 * 总结批次的幂等键：同一时间窗 + 同样条数 = 同一批。
 *
 * "写入记忆"与"推进处理游标"分处两个存储、没法放进一个事务；如果写完记忆、还没
 * 推游标就崩了，下一次会拿同一个窗口重跑。有了这个键，重跑发现同批已入库就只推游标，
 * 不会重复创建同一批记忆。
 */
function buildBatchKey(earliest: string, latest: string, count: number): string {
    const raw = `${earliest}|${latest}|${count}`;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
    return `batch_${(hash >>> 0).toString(36)}`;
}

/**
 * 内容性质判定的兜底网。提示词已经要求模型把梦/计划/假设写明，这里再按词面兜一层：
 * 梦、计划、假设**不是**已发生的事，标出来之后，核心总结与召回都能据此区别对待。
 * 顺序有意为之——先判梦，再判假设/玩笑，然后才是计划与偏好。
 */
export function classifyContentKind(text: string): MemoryContentKind {
    if (/(梦见|做梦|梦到|梦里|梦见了)/.test(text)) return "dream";
    if (/(假设|假如|要是|如果|开玩笑|玩笑话|随口一说|随口说)/.test(text)) return "hypothesis";
    if (/(打算|计划|准备要|准备去|想去|想要去|约定好|约好|安排在|下次要|明天要|下周要)/.test(text)) return "plan";
    if (/(喜欢|讨厌|爱吃|不爱吃|偏好|习惯|口味|最喜欢的)/.test(text)) return "preference";
    return "experience";
}

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // API 解析：角色主对话绑定优先（重要性评分/事件抽取要跟角色本体同模型），
    // 回落到辅助「记忆总结」绑定——两条路都没有才报错。
    const bindings = loadBindingConfig();
    const mainSlotApiId = resolveBinding(bindings, characterId).apiConfigId;
    const apiConfig = (mainSlotApiId ? loadApiConfigs().find(c => c.id === mainSlotApiId) : undefined)
        ?? resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在配置绑定中设置主对话或辅助记忆 API）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, {
            ...(afterTimestamp ? { afterTimestamp } : {}),
            forPersonalMemory: true,
        }),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    // 编号化：v3 模板让模型用编号回指"这条 episode 由哪几条事件支撑"，
    // 每条记忆因此有自己的证据，而不是整批消息无差别挂给所有条目。
    const formatted = formatTimelineForSummarization(allEntries, { indexed: true });
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // 幂等：同一窗口重跑时先看这批是不是已经写过。写完记忆、还没推进游标就崩了的
    // 情况会重跑同一个窗口——不查这一下就会重复创建同一批记忆。
    const batchKey = buildBatchKey(earliest, latest, allEntries.length);
    if (!options?.force) {
        const existingEntries = await loadMemoryEntries(characterId);
        if (existingEntries.some(entry => memoryBatchKeyOf(entry) === batchKey)) {
            setLastSummarizedTimestamp(characterId, latest);
            resetEventCounter(characterId);
            logMemoryTask({
                task: "summarize",
                characterId,
                switches: memorySwitchSnapshot(),
                action: "skip",
                outcome: `批次 ${batchKey} 已入库（重试），跳过重复写入`,
            });
            return { success: true };
        }
    }

    // 存量用户若还存着 v1/v2 默认模板文本，自动升级到 v3（episode 带证据编号）。
    let promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT_V3;
    if (
        promptTemplate === DEFAULT_SUMMARIZATION_PROMPT.trim()
        || promptTemplate === LEGACY_SUMMARIZATION_PROMPT_V2.trim()
        || promptTemplate === DEFAULT_SUMMARIZATION_PROMPT_V2.trim()
    ) {
        promptTemplate = DEFAULT_SUMMARIZATION_PROMPT_V3;
    }
    // 只有内置的结构化模板才强制要求结构；用户自定义提示词保持宽松回退（他那份本身就是纯文本）。
    const requireStructure = promptTemplate === DEFAULT_SUMMARIZATION_PROMPT_V3.trim();
    const summaryPrompt = `${promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText)}

${PERSONAL_MEMORY_ATTRIBUTION_RULE.replace(/\{\{char\}\}/gi, characterName)}`;

    // Call LLM for summarization — compatible with all providers
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const rawOutput = result.content;
    const parsed = parseSummarizationOutput(rawOutput);

    // 解析失败守卫：输出里没有任何结构化标记，极可能是模型的拒答 / 报错 / 跑题。
    // 把这种整段异常回复直接存成"有效记忆"，正是"推测逐渐变成事实"的上游。
    if (requireStructure && !parsed.structured) {
        if (!options?.force) resetEventCounter(characterId);
        logMemoryTask({
            task: "summarize",
            characterId,
            switches: memorySwitchSnapshot(),
            action: "skip",
            outcome: "输出不含 SUMMARY/EPISODE 标记，已拒绝入库（未写入任何记忆）",
        });
        return { success: false, error: "总结输出不是你要求的格式，已拒绝入库（避免把异常回复存成记忆）" };
    }

    const roster = buildMemoryRoster(loadCharacters(), characterId, characterName);
    const summary = retainPersonalMemoryProse(parsed.summary, roster.selfNames, roster.otherNames);
    const episodes = parsed.episodes
        .map(episode => ({
            ...episode,
            content: retainPersonalMemoryProse(episode.content, roster.selfNames, roster.otherNames),
        }))
        .filter(episode => episode.content && !isForeignMemoryText(episode.content, roster.selfNames, roster.otherNames))
        .slice(0, 8);
    if (!summary && episodes.length === 0) {
        // 水位线不动，同一窗口下次还能再总结。计数清掉，避免每条新消息都立刻重试。
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: "总结没有写到这个角色本人，已跳过入库" };
    }
    const summaryText = summary || episodes.map(episode => episode.content).join("");

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summaryText, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));
    const allSourceMessageIds = Array.from(new Set(
        allEntries.map(entry => entry.id).filter(Boolean),
    ));

    // 谁讲的：素材里谁的发言占多数。用户转述的事不能变成角色的亲历。
    const authorCounts = new Map<string, number>();
    for (const entry of allEntries) {
        const key = entry.authorType ?? "unknown";
        authorCounts.set(key, (authorCounts.get(key) ?? 0) + 1);
    }
    const dominantAuthor = [...authorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const batchSourceKind: MemorySourceKind =
        dominantAuthor === "user" ? "user_said" : dominantAuthor === "character" ? "character_said" : "system";

    // 证据解析：把模型给的编号映射回具体条目。编号越界 / 没给编号都**不伪造**证据。
    const evidenceEntriesFor = (idx: number[]) =>
        idx.map(i => allEntries[i - 1]).filter((entry): entry is (typeof allEntries)[number] => Boolean(entry));
    const evidenceIdsFor = (idx: number[]) =>
        Array.from(new Set(evidenceEntriesFor(idx).map(entry => entry.id).filter(Boolean)));
    const occurredAtFor = (idx: number[]): string => {
        const times = evidenceEntriesFor(idx).map(entry => entry.timestamp).filter(Boolean).sort();
        return times[0] ?? latest;
    };
    const sourceKindFor = (idx: number[]): MemorySourceKind => {
        const evidence = evidenceEntriesFor(idx);
        if (evidence.length === 0) return batchSourceKind;
        const userCount = evidence.filter(entry => entry.authorType === "user").length;
        return userCount * 2 >= evidence.length ? "user_said" : "character_said";
    };

    // Save as long-term memory (kind=summary，旧格式输出也走这里，episodes 为空即等价旧行为)
    const now = new Date().toISOString();
    const summaryId = `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const longTermEntry: MemoryEntry = {
        id: summaryId,
        characterId,
        sourceApp: dominantSource as MemoryEntry["sourceApp"],
        type: "long_term",
        kind: "summary",
        content: summaryText,
        embedding,
        importance: 0.8,
        createdAt: now,
        updatedAt: now,
        sourceMessageIds: allSourceMessageIds.length ? allSourceMessageIds : undefined,
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
            // 证据关联：summary 与它派生的 episode 共享同一个 eventId/batchKey ——
            // 它们是"同一次经历的两面"，因此**不能**被当成两份独立证据。
            batchKey,
            eventId: batchKey,
            sourceKind: batchSourceKind,
            contentKind: "experience",
            occurredAt: latest,
            status: "active",
            revision: 1,
        },
    };
    await saveMemoryEntry(longTermEntry);

    // Episode 条目：每条一句话事件 + LLM 重要性评分 + **它自己的证据编号**。
    // 上限 8 条（prompt 约束），解析失败的行已被 parser 丢掉。
    for (const [index, episode] of episodes.entries()) {
        const evidenceIds = evidenceIdsFor(episode.evidenceIdx);
        let episodeEmbedding: number[] | undefined;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const emb = await generateEmbedding(episode.content, embeddingApiConfig);
                if (emb) episodeEmbedding = emb;
            } catch { /* ignore */ }
        }
        await saveMemoryEntry({
            id: `mem_ep_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
            characterId,
            sourceApp: dominantSource as MemoryEntry["sourceApp"],
            type: "long_term",
            kind: "episode",
            content: episode.content,
            embedding: episodeEmbedding,
            importance: Math.min(1, Math.max(0.1, episode.salience / 10)),
            salience: episode.salience,
            links: [summaryId],
            createdAt: now,
            updatedAt: now,
            // 证据精确到条目：只在解析到编号时才挂靠，**不做整批挂靠**。
            sourceMessageIds: evidenceIds.length ? evidenceIds : undefined,
            metadata: {
                timeSpan: `${earliest} ~ ${latest}`,
                batchKey,
                // 与 summary 同一个 eventId：同一次经历的两面，不是两份证据。
                eventId: batchKey,
                episodeIndex: index + 1,
                sourceKind: sourceKindFor(episode.evidenceIdx),
                contentKind: classifyContentKind(episode.content),
                occurredAt: evidenceIds.length ? occurredAtFor(episode.evidenceIdx) : latest,
                status: "active",
                revision: 1,
                // 模型没给编号：不伪造证据，标出来待核（内容仍成立，但不作为独立证据）。
                ...(evidenceIds.length ? {} : { evidenceUnresolved: true }),
            },
        });
    }

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // 容量清理：**只作用于长期记忆**，而且只归档、不删除。
    //
    // 旧写法读的是 loadMemoryEntries（long_term + core 都要），再按 createdAt 从最旧
    // 往下删——核心记忆恰恰是创建最早的，于是"清理长期记忆"会把核心记忆一起删掉。
    // 现在：核心 / 固定保留 / 手工确认一律豁免；超过上限的最旧条目改为标记 archived
    //（保留证据与恢复能力），归档后不再参与召回，也不再计入容量。
    const longTermEntries = (await loadMemoryEntries(characterId))
        .filter(entry => entry.type === "long_term" && entry.metadata?.archived !== true);
    const evictable = longTermEntries.filter(entry => !isProtectedEntry(entry));
    if (evictable.length > config.maxLongTermEntries) {
        const overflow = evictable.slice(0, evictable.length - config.maxLongTermEntries);
        for (const entry of overflow) {
            await saveMemoryEntry({
                ...entry,
                updatedAt: now,
                metadata: { ...entry.metadata, archived: true, archivedAt: now },
            });
            logMemoryWrite({
                action: "archive",
                characterId,
                entryId: entry.id,
                outcome: "超出容量上限，归档而非删除",
            });
        }
    }

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    // 空闲固化：新记忆积累够重要时后台反思+性格漂移（自身有水位线门控，不怕频繁调用）
    void maybeRunConsolidation(characterId, characterName).catch((error) => {
        console.warn("[MemorySummarizer] consolidation tail failed:", error);
    });

    logMemoryTask({
        task: "summarize",
        characterId,
        switches: memorySwitchSnapshot(),
        action: "create",
        outcome: `总结 ${allEntries.length} 条事件 → 1 条长期记忆 + ${episodes.length} 条事件，归档 ${Math.max(0, evictable.length - config.maxLongTermEntries)} 条`,
    });

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 long-term memory`);
    return { success: true };
}
