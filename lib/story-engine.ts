import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequest, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, clockForCalendarOwner, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";

import { parseStoryResponse } from "./story-parser";
import { STORY_PARSER_VERSION } from "./story-parser";
import { loadStoryMessages, replaceStoryMessages, resolveActiveStorySchemes, type StoryCharacterSettings, type StoryMessage } from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";

const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary,story_status,story_theater";
const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking,story_theater";
const STORY_VOICE_FORMAT_PROMPT = `# 剧情正文格式
请使用统一的正文语义格式：
- 「对白」：仅包裹角色真正说出口的人声；每次说话分别包裹，不要在括号内重复角色名。
- *心声*：包裹角色没有说出口的内心想法。
- 【场景】：单独一行，用于地点、时间或场景过场。
- ~强调~：只强调需要突出的短语。
- “……”：只用于物品、动作、环境等非人声发出的声音，不作为角色对白。
- 对白标点唯一格式：无论用户或历史消息里的对话使用什么标点形式（“”、""、『』、''等），你输出的角色对白一律使用「」，不要模仿用户的标点。
旁白、动作以及用户的话不得写进「」；不要解释这些格式，也不要输出额外的语音清单。`;

export type StoryGenerationOptions = {
  sessionFoldTags?: string;
  sessionContextExcludedTags?: string;
  settings?: StoryCharacterSettings;
  floatingChatContext?: string;
  /** 多人剧情角色列表；第一个角色仍作为 API、预设和语音绑定的主角色。 */
  participantIds?: string[];
  storyMemory?: {
    independent?: boolean;
    inheritRecentMemory?: boolean;
    startedAt?: string;
  };
  signal?: AbortSignal;
};

function selectStoryPresetPrompts(preset: PresetConfig | null, selectedIds?: string[]): PresetConfig | null {
  if (!preset || selectedIds === undefined) return preset;
  const allowed = new Set(selectedIds);
  return {
    ...preset,
    prompts: preset.prompts.map((prompt) => prompt.marker ? prompt : { ...prompt, enabled: prompt.enabled && allowed.has(prompt.identifier) }),
    prompt_order: preset.prompt_order,
  };
}

function buildStorySettingsPrompt(settings: StoryCharacterSettings | undefined, userName: string): string {
  if (!settings) return "";
  // 字数收敛到 50–10000：用户存 0/负数按 50 生效，超过 10000 按 10000 生效
  const minChars = Math.max(50, Math.min(10000, settings.minChars ?? 800));
  const maxChars = Math.max(minChars, Math.min(10000, settings.maxChars ?? 1500));
  const perspective = settings.userPerspective === "third"
    ? "使用第三人称“TA”称呼用户"
    : settings.userPerspective === "username"
      ? `使用用户名“${userName}”称呼用户`
      : "使用第二人称“你”称呼用户";
  // 方案定义统一存于公用仓库，角色设置只带“启用哪一个”的 id
  const { proseStyle, status, theater } = resolveActiveStorySchemes(settings);
  return [
    "# 当前剧情 APP 专属生成设置",
    `正文长度以 ${minChars}—${maxChars} 字为目标；不得为了凑字数重复内容。`,
    perspective + "。",
    // 新建方案 prompt 留空时不注入（避免出现“文风方案【xxx】：”这样的空行）
    proseStyle?.prompt?.trim() ? `正文文风方案【${proseStyle.name}】（仅约束写作风格，不是尾部输出格式）：${proseStyle.prompt.trim()}` : (settings.proseStyle ? `文风：${settings.proseStyle}。` : ""),
    proseStyle?.prompt?.trim() ? "" : (settings.proseStylePrompt?.trim() || ""),
    settings.extraPrompt?.trim() || "",
    ...(settings.customPromptEntries || []).filter((item) => item.enabled && item.content.trim()).map((item) => `专属条目【${item.name || "未命名"}】：${item.content.trim()}`),
    status?.prompt?.trim() || "",
    theater?.prompt?.trim() || "",
  ].filter(Boolean).join("\n");
}

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  const tags = Array.from(new Set((excludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS).split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
  return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
  };
}

function resolveStoryConfigs(characterId: string): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> 绑定管理 -> 剧情 to assign one.`);
  }

  const apiConfig = loadApiConfigs().find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null;
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === characterId);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = storyOverrideRegexIds && storyOverrideRegexIds.length > 0
    ? storyOverrideRegexIds
    : activeSlot.regexIds || [];
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

export function getStoryRenderSignature(characterId: string): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterId);
  return {
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

export async function generateStoryCompletion(
  characterId: string,
  history: StoryMessage[],
  options?: StoryGenerationOptions,
): Promise<StoryGenerationResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset: resolvedPreset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId);
  const preset = selectStoryPresetPrompts(resolvedPreset, options?.settings?.enabledPresetPromptIds);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(
    characterId,
    history,
    preset,
    regexes,
    worldBooks,
    effectiveContextExcludedTags,
    options?.settings,
    options?.floatingChatContext,
    options?.participantIds,
    options?.storyMemory,
  );

  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "用户");

  const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
    characterName: character.name,
  }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });

  const parsed = parseStoryResponse(rawOutput, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature,
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
  settings?: StoryCharacterSettings,
  floatingChatContext?: string,
  participantIds?: string[],
  storyMemory?: StoryGenerationOptions["storyMemory"],
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const historyMessages = history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const memConfig = loadMemoryConfig();
  const independent = Boolean(storyMemory?.independent);
  const context = independent
    ? {
      recentBlocks: [],
      truncatedHistory: historyMessages,
      wbActivationContext: historyMessages.slice(-10).map((message) => message.content).join("\n"),
      unifiedRecentItems: [],
    }
    : prepareShortTermContext(characterId, "story", {
      userName: userIdentity?.name ?? "用户",
      history: historyMessages,
      afterTimestamp: storyMemory?.inheritRecentMemory === false ? storyMemory.startedAt : undefined,
    });
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = context;

  let memories: Awaited<ReturnType<typeof retrieveMemoriesForPrompt>> | null = null;
  let coreMemories: Awaited<ReturnType<typeof retrieveCoreMemoriesForPrompt>> | null = null;
  if (!independent) {
    [memories, coreMemories] = await Promise.all([
      retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
      retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
    ]);
  }

  const now = new Date();

  const messages = assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: buildCalendarScheduleMarker("character", characterId, clockForCalendarOwner("character", characterId, now).weekStartIso),
    currentSchedule: getCurrentCalendarScheduleForPrompt("character", characterId, now),
    coreMemories: coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks,
    unifiedRecentItems,
  });
  const settingsPrompt = buildStorySettingsPrompt(settings, userIdentity?.name ?? "用户");
  const participantCharacters = Array.from(new Set(participantIds || []))
    .map((id) => loadCharacters().find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (participantCharacters.length > 1) {
    const roster = participantCharacters.map((item, index) => {
      const profile = item.briefPersona?.trim() || item.personality?.trim() || item.persona?.trim();
      return `${index + 1}. ${item.name}${profile ? `：${profile}` : ""}`;
    }).join("\n");
    messages.push({
      role: "system",
      content: `# 多人见面剧情\n当前场景共有以下角色：\n${roster}\n请让每个角色保持各自人设、称呼和行动逻辑，按场景自然分配对白与反应；不要把多人合并成同一个说话者，也不要代替用户决定行动。`,
    });
  }
  if (independent) {
    messages.push({ role: "system", content: "# 独立剧情\n本分线不参考角色既有短期、核心或长期记忆，只根据角色设定和本分线已经发生的内容继续。" });
  }
  if (settingsPrompt) messages.push({ role: "system", content: settingsPrompt });
  if (settings?.floatingPhoneInContext && floatingChatContext?.trim()) {
    messages.push({ role: "system", content: `# 悬浮小手机最近线上聊天\n以下记录用于衔接线上与线下剧情，不要逐字复述：\n${floatingChatContext.trim()}` });
  }
  messages.push({ role: "system", content: STORY_VOICE_FORMAT_PROMPT });
  return messages;
}

export async function previewStoryPromptPayload(
  characterId: string,
  history: StoryMessage[],
  options?: { sessionContextExcludedTags?: string },
): Promise<StoryPreviewResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }
  const { apiConfig, preset, regexes, worldBooks } = resolveStoryConfigs(characterId);
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() || DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags);
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: character.name,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

export function rebuildStorySessionRenderCache(characterId: string, sessionId: string, options?: { sessionFoldTags?: string }): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterId);
  const { regexes, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() || DEFAULT_STORY_FOLD_TAGS;

  const character = loadCharacters().find((c) => c.id === characterId);
  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "用户");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText || message.storySummary,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
