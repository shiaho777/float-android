// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";

/**
 * 记忆注入的用法说明：告诉模型这些是"早就知道的事"，不是待播报的话题清单。
 *
 * 这是治"反复念叨同一批旧事"的最后一道闸——不管用户装的是哪份预设、
 * 有没有改过自己的提示词，只要注入记忆就带上这条约束。
 */
const CORE_MEMORY_HEADER = [
    "（以下是你早已知道的事——关系与身份的基本事实，作为背景认知保持稳定。）",
    "用法：除非本轮话题直接相关，不要主动重申，也不必反复确认。",
].join("\n");

const LONG_TERM_MEMORY_HEADER = [
    "（以下是你长期积累的记忆——你本来就\"知道\"的事，不是本轮要说的话题清单。）",
    "用法：只在与本轮对话直接相关时才提起，无关的条目直接忽略。",
    "讲过的事可以接着讲：对方主动问起、事情有了新进展、或者你能补充新的细节和感受时，",
    "自然接着说就好。要避免的只是**原样重播**——没有任何新内容地把同一件事再讲一遍。）",
].join("\n");

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles relevance ranking + token budget,
 * so this only formats the selected entries.
 *
 * forPrompt=false 用于「记忆不是喂给模型、而是交给自定义 APP 当数据」的场景，
 * 此时不能混进给模型看的用法说明。
 */
export function formatLongTermMemories(
    memories: MemoryEntry[],
    options?: { forPrompt?: boolean },
): string {
    if (memories.length === 0) return "";
    const body = memories.map(entry => `- ${entry.content}`).join("\n");
    return options?.forPrompt === false ? body : `${LONG_TERM_MEMORY_HEADER}\n${body}`;
}

export function formatCoreMemories(
    memories: MemoryEntry[],
    options?: { forPrompt?: boolean },
): string {
    if (memories.length === 0) return "";
    const body = memories.map(entry => `- ${entry.content}`).join("\n");
    return options?.forPrompt === false ? body : `${CORE_MEMORY_HEADER}\n${body}`;
}
