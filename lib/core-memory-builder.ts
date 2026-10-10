import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT, LEGACY_CORE_MEMORY_PROMPT, isRecallableEntry } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { loadCharacters } from "./character-storage";
import {
    CORE_MEMORY_FACT_RULE,
    formatCharacterCardFacts,
    stripUngroundedStartAges,
} from "./core-memory-facts";
import { logMemoryTask, memorySwitchSnapshot } from "./memory-recall-log";

const coreBuildingSet = new Set<string>();

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
};

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    return {
        eventsText: entries.map(entry => `- ${entry.content}`).join("\n"),
        earliest: entries[0].timestamp,
        latest: entries[entries.length - 1].timestamp,
        count: entries.length,
    };
}

/**
 * 从核心正文里抽出明确的关系与约定，存成结构化索引。
 *
 * 为什么需要：正文有 80-180 字的上限，写不下"关系是什么、约定了什么"这类关键事实；
 * 索引不受字数限制，召回与排查时能直接看到关系状态，不必再去正文里猜。
 * 只认明确词面，不做推测——没写就是没有。
 */
export function buildRelationshipIndex(text: string): string[] {
    const patterns: [RegExp, string][] = [
        [/(结婚|已婚|配偶|丈夫|妻子|老公|老婆)/, "婚姻关系"],
        [/订婚/, "订婚"],
        [/(分手|分开|结束关系)/, "已分手"],
        [/复合/, "复合"],
        [/离婚/, "离婚"],
        [/(恋人|男朋友|女朋友|对象|在一起)/, "恋爱关系"],
        [/(同居|一起住|搬到?一起)/, "同居"],
        [/(见家长|见父母)/, "见家长"],
        [/(姐弟|兄妹)/, "姐弟"],
        [/(网友|线上认识|网上认识)/, "网友"],
        [/(一起养|共同养|养了)/, "共同养宠物"],
        [/(约定|约好|答应|承诺)/, "重要约定"],
        [/(朋友|好友)/, "朋友"],
    ];
    const labels: string[] = [];
    for (const [pattern, label] of patterns) {
        if (pattern.test(text)) labels.push(label);
    }
    return Array.from(new Set(labels));
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    // 核心记忆只能由**可召回的事实层**支撑：reflection / trait_shift 是推断（没有自己的
    // 原始证据），把它们总结进核心正是"推测逐渐变成事实"的直接通道。归档、已作废、
    // 待重算的条目同样排除；「未核验」的旧条目照常参与（它只是没证据编号，内容仍成立）。
    const allLongTermEntries = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(entry => isRecallableEntry(entry));

    if (allLongTermEntries.length === 0) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const afterTimestamp = options?.force ? undefined : (getLastCoreSummarizedTimestamp(characterId) ?? undefined);
    const entries = allLongTermEntries
        .filter(entry => !afterTimestamp || entry.createdAt > afterTimestamp)
        .map(entry => ({
            id: entry.id,
            timestamp: entry.createdAt,
            content: entry.content,
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (entries.length === 0) {
        if (!options?.force) resetCoreMemoryCounter(characterId);
        return { success: false, error: "没有新的长期记忆需要总结" };
    }

    const formatted = formatCoreTimelineForSummarization(entries);
    if (!formatted) return { success: false, error: "格式化核心记忆数据失败" };

    const { eventsText, earliest, latest } = formatted;
    let promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    if (promptTemplate === LEGACY_CORE_MEMORY_PROMPT.trim()) {
        promptTemplate = DEFAULT_CORE_MEMORY_PROMPT;
    }
    const character = loadCharacters().find((item) => item.id === characterId) ?? null;
    const cardFacts = formatCharacterCardFacts(character
        ? { persona: character.persona, personality: character.personality }
        : null);
    let prompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText)
        .replace(/\{\{longTermMemories\}\}/gi, eventsText);
    if (/\{\{cardFacts\}\}/i.test(prompt)) {
        prompt = prompt.replace(/\{\{cardFacts\}\}/gi, cardFacts);
    } else {
        prompt += `\n\n人物卡（只用于核对）：\n${cardFacts}`;
    }
    prompt += `\n\n${CORE_MEMORY_FACT_RULE}`;

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆总结失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = stripUngroundedStartAges(result.content.trim(), eventsText);
    if (!summary) {
        return { success: false, error: "核心记忆把持续时间写成了起始年龄，已拦截，没有入库" };
    }

    const now = new Date().toISOString();
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }
    const sourceSessionIds = Array.from(new Set(entries.flatMap(entry => entry.sourceSessionIds)));

    // ── 合并更新，而不是不断追加 ──
    // 旧写法每跑一次就 new 一条核心记忆：互相冲突的段落越堆越多，召回按时间排序又会把
    // 最新那条顶上去，"核心记忆"于是变成一摞自相矛盾的总结。现在只保留一条活跃版本并改写它。
    // isRecallableEntry 已含"未归档"，这里不用再判一次
    const activeCore = (await loadMemoryEntriesByType(characterId, "core"))
        .filter(entry => isRecallableEntry(entry));
    // 手工确认的核心记忆受保护：自动总结不得无依据覆盖。
    const manualCore = activeCore.find(entry => entry.metadata?.manual === true);
    if (manualCore && !options?.force) {
        logMemoryTask({
            task: "core-summary",
            characterId,
            switches: memorySwitchSnapshot(),
            action: "skip",
            outcome: "已存在手工确认的核心记忆，自动总结跳过（不覆盖）",
        });
        return { success: false, error: "已有手工确认的核心记忆，自动总结已跳过" };
    }
    const editableCore = activeCore
        .filter(entry => entry.metadata?.manual !== true)
        .sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)))[0];

    // 关系索引：取自**当前**正文——关系会变（在一起 / 分手），不能留着上一版的标签。
    const relationshipIndex = buildRelationshipIndex(summary);
    // 经历索引：**累积**（本轮的 + 上几轮留下的），否则每次重建都会把更早的经历索引冲掉。
    // 有上限：索引是拿来定位经历的，不是无限台账。
    const previousExperienceIds = Array.isArray(editableCore?.metadata?.experienceEntryIds)
        ? (editableCore!.metadata!.experienceEntryIds as unknown[]).map(String)
        : [];
    const experienceEntryIds = Array.from(new Set([...previousExperienceIds, ...entries.map(entry => entry.id)]))
        .slice(-200);

    const sharedMetadata = {
        summarizedLongTermEntries: entries.length,
        timeSpan: `${earliest} ~ ${latest}`,
        sourceSessionIds,
        relationshipIndex,
        experienceEntryIds,
        occurredAt: latest,
        status: "active",
        // 核心记忆是"你和用户的关系"——只在私聊里成立，不进群聊可传播上下文。
        scope: ["private"],
        // 人物卡的基础设定与"和用户相处的记忆"分开：卡只用于核对，不写进相处记忆。
        cardFactsSeparate: true,
    };

    let coreEntryId: string;
    if (editableCore) {
        const revision = (typeof editableCore.metadata?.revision === "number" ? editableCore.metadata.revision : 1) + 1;
        const revisions = Array.isArray(editableCore.metadata?.revisions) ? editableCore.metadata.revisions : [];
        coreEntryId = editableCore.id;
        await saveMemoryEntry({
            ...editableCore,
            content: summary,
            updatedAt: now,
            metadata: {
                ...editableCore.metadata,
                ...sharedMetadata,
                revision,
                // 旧版本留档（有上限）：回退与审计有据可查，但不会无限膨胀。
                revisions: [
                    ...revisions,
                    { at: editableCore.updatedAt ?? editableCore.createdAt, content: editableCore.content },
                ].slice(-3),
            },
        });
    } else {
        coreEntryId = `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await saveMemoryEntry({
            id: coreEntryId,
            characterId,
            sourceApp: dominantSource,
            type: "core",
            content: summary,
            importance: 0.95,
            createdAt: now,
            updatedAt: now,
            metadata: { ...sharedMetadata, revision: 1 },
        });
    }

    setLastCoreSummarizedTimestamp(characterId, latest);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    logMemoryTask({
        task: "core-summary",
        characterId,
        switches: memorySwitchSnapshot(),
        action: editableCore ? "merge" : "create",
        entryId: coreEntryId,
        outcome: `${entries.length} 条事实层长期记忆 → ${editableCore ? "合并更新" : "新建"} 1 条核心记忆，关系索引 ${relationshipIndex.length} 项`,
    });

    return { success: true, rebuiltCount: 1 };
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
