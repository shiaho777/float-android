import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT, LEGACY_CORE_MEMORY_PROMPT, isArchivedEntry, isFactEntry } from "./memory-types";
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

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    // 核心记忆只能由**事实层**支撑：reflection / trait_shift 是推断（没有自己的原始证据），
    // 把它们总结进核心正是"推测逐渐变成事实"的直接通道。归档条目同样排除。
    const allLongTermEntries = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(entry => isFactEntry(entry) && !isArchivedEntry(entry));

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

    const coreEntry: MemoryEntry = {
        id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: summary,
        importance: 0.95,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedLongTermEntries: entries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(coreEntry);

    setLastCoreSummarizedTimestamp(characterId, latest);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    logMemoryTask({
        task: "core-summary",
        characterId,
        switches: memorySwitchSnapshot(),
        action: "create",
        entryId: coreEntry.id,
        outcome: `${entries.length} 条事实层长期记忆 → 1 条核心记忆`,
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
