// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

/** Generative Agents 式记忆分层：
 *  episode     单个关键事件（"下午和X打球输了"），links 指回所属 summary
 *  summary     叙事压缩（旧数据的缺省形态）
 *  reflection  跨记忆高层推理，links 指向证据条目
 *  trait_shift 性格漂移记录，links 指向触发它的 reflection/episode */
export type MemoryKind = "episode" | "summary" | "reflection" | "trait_shift";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    /**
     * 事实与证据关联契约。全部可缺省——缺省就是旧数据的行为，无需迁移：
     *   eventId      同一经历的稳定标识：一条 summary 与它派生的 episode 共享同一个
     *                eventId/batchKey，因此**不能当成两份独立证据**。
     *   batchKey     总结批次的幂等键（由时间窗推导）。重试时按键去重，不会重复入库。
     *   sourceKind   谁讲的：user_said / character_said / imported / system
     *   speakerId    讲述者的 characterId（用户讲述时缺省）
     *   subjectIds   这条事实涉及谁（"用户去过日本"的主体是用户，不是听说的角色）
     *   contentKind  经历 / 偏好 / 计划 / 梦境 / 假设 / 反思——梦与计划不得写成已发生
     *   occurredAt   事件**发生**时间（可空：无明确依据就留空，不许推算补齐）
     *   status       active / superseded / needs_review / invalid（缺省 = active）
     *   supersedes   本条目替代了哪些旧条目
     *   knownTo      知情者；scope 允许传播范围（private = 不进群聊上下文）
     *   revision     修订版本，每次内容被改写 +1
     *   derivedFrom  别名：由哪些条目派生（与顶层 links 同义，links 为准）
     *   pinned / manual / archived / generatedBy  见 memory-types 顶部既有说明
     */
    metadata?: Record<string, unknown>;
    /** 记忆分层；旧条目无此字段，按 "summary" 处理 */
    kind?: MemoryKind;
    /** 1-10，LLM 评的重要性/poignancy；旧条目按 importance*10 折算 */
    salience?: number;
    /** derivedFrom：本条目由哪些条目支撑（episode→summary、reflection→证据） */
    links?: string[];
    /** 注入记账不放在这里：那是每轮都会变的旁路状态，写进记录会带来整条覆盖
     *  与并发写覆盖的风险，改为按 id 存在 kv（见 memory-storage 的注入记账段）。 */
};

export function memoryKindOf(entry: Pick<MemoryEntry, "kind">): MemoryKind {
    return entry.kind ?? "summary";
}

export function effectiveSalience(entry: Pick<MemoryEntry, "salience" | "importance">): number {
    const raw = typeof entry.salience === "number" && Number.isFinite(entry.salience)
        ? entry.salience
        : entry.importance * 10;
    return Math.min(10, Math.max(1, Math.round(raw)));
}

/** reflection / trait_shift 属于**推断层**：没有自己的原始证据，不能当事实用。 */
export function isInferenceKind(entry: Pick<MemoryEntry, "kind">): boolean {
    const kind = memoryKindOf(entry);
    return kind === "reflection" || kind === "trait_shift";
}

/** 事实条目：episode / summary（含旧数据无 kind 的缺省 summary）。 */
export function isFactEntry(entry: Pick<MemoryEntry, "kind">): boolean {
    return !isInferenceKind(entry);
}

/** 固定保留：容量清理豁免，并在长期注入预算里占一份保留额度。 */
export function isPinnedEntry(entry: Pick<MemoryEntry, "metadata">): boolean {
    return entry.metadata?.pinned === true;
}

/** 已归档：容量清理只标记不删除，召回时排除。 */
export function isArchivedEntry(entry: Pick<MemoryEntry, "metadata">): boolean {
    return entry.metadata?.archived === true;
}

/** 受保护条目：核心记忆、固定保留、手工确认，一律排除在自动删除之外。 */
export function isProtectedEntry(entry: Pick<MemoryEntry, "type" | "metadata">): boolean {
    return entry.type === "core"
        || entry.metadata?.pinned === true
        || entry.metadata?.manual === true
        || entry.metadata?.protected === true;
}

// ── 事实与证据关联（批次二） ──

/** 谁讲的。用户转述的事不能变成角色的亲历。 */
export type MemorySourceKind = "user_said" | "character_said" | "imported" | "system";

/**
 * 这条内容是什么性质。梦、计划、假设**不是**已发生的事——
 * 单独标出来，提示词与核心总结都能据此拒绝把它们写成现实。
 */
export type MemoryContentKind = "experience" | "preference" | "plan" | "dream" | "hypothesis" | "reflection";

/** 有效 / 未核验 / 已替代 / 待重算 / 已作废。缺省（旧数据）= active。 */
export type MemoryStatus = "active" | "unverified" | "superseded" | "needs_review" | "invalid";

/** 允许传播范围。private 的内容不进群聊可传播上下文。 */
export type MemoryScope = "private" | "group";

/** 注入场合：私聊（不限制）或群聊（只给允许在群里传播的条目）。 */
export type MemorySurface = "private" | "group";

export function memoryStatusOf(entry: Pick<MemoryEntry, "metadata">): MemoryStatus {
    const raw = entry.metadata?.status;
    if (raw === "unverified" || raw === "superseded" || raw === "needs_review" || raw === "invalid") return raw;
    return "active";
}

/**
 * 这条记忆的允许传播范围。缺省 = 仅私聊。
 *
 * 为什么缺省是最严的：旧数据没有来源记录，无法证明它是在群里公开说过的。
 * "没记录"不能当成"可以随便传"——宁可不在群里自动提起，也不要泄露私聊。
 */
export function memoryScopeOf(entry: Pick<MemoryEntry, "metadata">): MemoryScope[] {
    const raw = entry.metadata?.scope;
    if (Array.isArray(raw)) {
        const scopes = raw.filter((value): value is MemoryScope => value === "private" || value === "group");
        if (scopes.length > 0) return scopes;
    }
    return ["private"];
}

/** 这条记忆能不能在指定场合被注入。私聊不限制；群聊只放行 scope 含 group 的。 */
export function isMemoryVisibleOn(entry: Pick<MemoryEntry, "metadata">, surface: MemorySurface): boolean {
    if (surface === "private") return true;
    return memoryScopeOf(entry).includes("group");
}

export function memoryContentKindOf(entry: Pick<MemoryEntry, "metadata">): MemoryContentKind {
    const raw = entry.metadata?.contentKind;
    if (raw === "preference" || raw === "plan" || raw === "dream" || raw === "hypothesis" || raw === "reflection") return raw;
    return raw === "experience" ? "experience" : "experience";
}

/**
 * 事件发生时间。没有明确依据就退回写入时间——**不留空到把排序弄乱**，
 * 但召回排序用这个值，导入的旧事不会因为"刚写入"被当成刚发生。
 */
export function memoryOccurredAtOf(entry: Pick<MemoryEntry, "metadata" | "createdAt">): string {
    const occurredAt = entry.metadata?.occurredAt;
    return typeof occurredAt === "string" && occurredAt.trim() ? occurredAt : entry.createdAt;
}

/**
 * 同一经历的稳定标识。缺省退回条目自己的 id —— 于是没有 eventId 的旧条目
 * 各自算一个独立事件，不会被错误地折叠到一起。
 */
export function memoryEventIdOf(entry: Pick<MemoryEntry, "id" | "metadata">): string {
    const eventId = entry.metadata?.eventId;
    return typeof eventId === "string" && eventId.trim() ? eventId : entry.id;
}

/** 总结批次的幂等键；同一批次的 summary 与它的 episode 共享它。 */
export function memoryBatchKeyOf(entry: Pick<MemoryEntry, "metadata">): string | null {
    const batchKey = entry.metadata?.batchKey;
    return typeof batchKey === "string" && batchKey.trim() ? batchKey : null;
}

/**
 * 能否被事实召回：未归档 + 状态为有效或未核验 + 事实层。
 * reflection / trait_shift 是推断，不在此列（见 isFactEntry）。
 *
 * 「未核验」是迁移给旧条目打的标：它没有证据编号，但内容本身仍然成立，
 * 所以照常参与召回，只是被明确标记出来（迁移不伪造证据）。
 */
export function isRecallableEntry(entry: Pick<MemoryEntry, "kind" | "metadata">): boolean {
    if (isArchivedEntry(entry)) return false;
    const status = memoryStatusOf(entry);
    return (status === "active" || status === "unverified") && isFactEntry(entry);
}

/**
 * 注入记账条目：长期记忆被注入提示词的累计次数与最近时间。
 *
 * 记账不写进记忆记录本身——那会让每次生成都整条覆盖刷新、重写 embedding 大字段，
 * 还可能覆盖并发编辑、复活已删除的条目——而是按 id 存在 kv 里的小记录中。
 */
export type MemorySurfacedRecord = {
    /** 被注入过的次数 */
    count: number;
    /** 最近一次被注入的时间（ISO）；空串 = 从未提起 */
    at: string;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    /**
     * 空闲整理是否允许生成"反思"（跨多条记忆得出的新结论，kind=reflection）。默认关。
     *
     * 反思是**推断**而不是事实：它没有自己的原始证据，却会被召回和核心总结当成事实用，
     * 于是"推测逐渐变成事实"。默认关闭后，只有用户在设置里显式打开才会跑；而且无论开关
     * 如何，reflection / trait_shift 都不再进入事实召回与核心总结（见 memory-service、
     * core-memory-builder）——它们是可恢复的旁证，不是事实来源。
     */
    autoReflectionEnabled: boolean;
    /** 空闲整理是否允许改写性格并注入下次聊天。默认关：反思可以有，性格覆盖层不自动长。 */
    autoPersonaDriftEnabled: boolean;
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    /**
     * 记忆检索日志：本地环形缓存，记录每轮召回了哪些记忆、分数怎么来的、谁没入选、
     * 以及各后台任务执行时的开关状态。默认开；只写本机 kv、有限容量、不含 API 密钥。
     * 可在记忆设置里关闭，或导出脱敏诊断文件。
     */
    memoryRecallLogEnabled: boolean;
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    /** 配置自身的结构版本：注入预算是按"版本"迁移的，不看值相等。
     *  旧版本存的配置没有这个字段（含备份还原回来的），下一次读取会被迁移并回写；
     *  应用自己写过的配置一定带当前版本号，所以用户手调的值永不被迁移覆盖。 */
    budgetSchemaVersion?: number;
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/**
 * v3 总结模板：在 v2 基础上要求每条 EPISODE 回指**支持它的事件编号**。
 *
 * 为什么要编号回指：v2 里 episode 与 summary 共享同一批 sourceMessageIds，
 * 于是"整批消息无差别挂给所有条目"——一条 episode 说不出自己凭什么成立，
 * 修正时也无法沿证据找到该连带失效的派生条目。有了编号，每条记忆才有自己的证据。
 *
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT_V3 = `你是一个记忆整理助手。根据以下事件记录，为{{char}}整理记忆。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录（每条前面是编号）：
{{events}}

严格按以下格式输出（不要输出任何其他内容）：

SUMMARY:
<一段简洁的事实性总结，第三人称，只写{{char}}亲身参与的事，以及用户直接告诉{{char}}或直接发生在{{char}}身上的事。保留名字、承诺、情感变化、关系里程碑、用户分享的生日/偏好/习惯。朋友圈只保留{{char}}自己发的、别人直接回应{{char}}的内容。不要把其他角色自己的生活写成{{char}}的经历。100-200字>

EPISODES:
EPISODE|<重要性1-10>|<一句话。必须能看出{{char}}本人参与；整句只有别人名字时不要写>|EVIDENCE:<支持这一条的事件编号，逗号分隔，至少一个>
EPISODE|<重要性1-10>|<另一个事件>|EVIDENCE:<编号>
（每行一条，最多8条，宁缺毋滥；只挑真正值得单独记住的时刻）

写作约束：
- 事件是"梦""计划""假设"时，必须写明是梦 / 计划 / 假设，不能写成已经发生的事。
- 没有明确依据的日期、年龄、动机不要补写。
- 人称约定：所有输出都必须用第三人称——用"用户"指代用户、用"{{char}}"指代角色；写"用户告诉了{{char}}自己的生日"而不是"我的生日"或"TA的生日"。

重要性评分标准：日常琐事=1-3，有意义的互动=4-7，关系里程碑/强烈情绪事件=8-10`;

/**
 * 旧版 v2 默认模板。用户若从未改过总结提示词，库存的就是这一段。
 * 升级判断用它做全等比较，不要再把它写进新的总结请求。
 */
export const LEGACY_SUMMARIZATION_PROMPT_V2 = `你是一个记忆整理助手。根据以下事件记录，为{{char}}整理记忆。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

严格按以下格式输出（不要输出任何其他内容）：

SUMMARY:
<一段简洁的事实性总结，第三人称描述{{char}}和用户之间的互动，保留关键事实：名字、承诺、情感变化、关系里程碑、用户分享的生日/偏好/习惯，保留朋友圈等非聊天事件关键信息，100-200字>

EPISODES:
EPISODE|<重要性1-10>|<一句话描述一个值得独立记住的事件>
EPISODE|<重要性1-10>|<另一个事件>
（每行一条，最多8条，宁缺毋滥；只挑真正值得单独记住的时刻）

人称约定：所有输出（SUMMARY 与每条 EPISODE）都必须用第三人称——用"用户"指代用户、用"{{char}}"指代角色；写"用户告诉了{{char}}自己的生日"而不是"我的生日"或"TA的生日"。

重要性评分标准：日常琐事=1-3，有意义的互动=4-7，关系里程碑/强烈情绪事件=8-10`;

/**
 * v2 总结模板：除叙事摘要外，要求输出结构化 episode 列表。
 * 每行 EPISODE|<重要性1-10>|<一句话事件> —— 重要性反映"对{{char}}来说
 * 这段经历多难忘/多影响关系"（日常琐事=1-3，有意义的互动=4-7，
 * 关系里程碑/强烈情绪事件=8-10）。
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT_V2 = `你是一个记忆整理助手。根据以下事件记录，为{{char}}整理记忆。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

严格按以下格式输出（不要输出任何其他内容）：

SUMMARY:
<一段简洁的事实性总结，第三人称，只写{{char}}亲身参与的事，以及用户直接告诉{{char}}或直接发生在{{char}}身上的事。保留名字、承诺、情感变化、关系里程碑、用户分享的生日/偏好/习惯。朋友圈只保留{{char}}自己发的、别人直接回应{{char}}的内容。不要把其他角色自己的生活写成{{char}}的经历。100-200字>

EPISODES:
EPISODE|<重要性1-10>|<一句话。必须能看出{{char}}本人参与；整句只有别人名字时不要写>
EPISODE|<重要性1-10>|<另一个事件>
（每行一条，最多8条，宁缺毋滥；只挑真正值得单独记住的时刻）

人称约定：所有输出（SUMMARY 与每条 EPISODE）都必须用第三人称——用"用户"指代用户、用"{{char}}"指代角色；写"用户告诉了{{char}}自己的生日"而不是"我的生日"或"TA的生日"。

重要性评分标准：日常琐事=1-3，有意义的互动=4-7，关系里程碑/强烈情绪事件=8-10`;

/**
 * Stored default before the exclusion list was labeled. Those lines were
 * being followed as things to write, including speculative content.
 */
export const LEGACY_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}, {{cardFacts}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

人物卡（只用于核对，不要把卡里有、但长期记忆原文没有的经历写进来）：
{{cardFacts}}

要写入：
- 最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）

不要写入：
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测出来的内容
- 长期记忆原文里没有的年龄、起始岁数、起始年份、日期
- 把持续时间写成起始年龄。原文是「坚持了十一年」「十一年的习惯」时，只能写持续了十一年，不能写成「从十一岁开始」
- 和人物卡对不上的推算。卡上写了当前年龄时，不要写一个加上持续年数就会超过这个年龄的起始岁数

写法：
- 用第三人称，只写长期记忆原文里已经出现的事实
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

/** 注入预算的配置结构版本（loadMemoryConfig 按它决定是否需要一次性迁移）。 */
export const MEMORY_BUDGET_SCHEMA_VERSION = 1;

/**
 * 注入预算默认值。
 *
 * 历史教训：这三个值曾经都是 100000 —— 等于"不设限"。后果是记忆召回里
 * "总量没超预算就全量返回"的捷径永远成立，相关性/新鲜度排序全部作废，
 * 同一个角色每轮拿到的是同一坨陈年旧事，于是变成"每天都重复说同样的话"。
 * 默认值必须收敛到"真实能被讲完"的量级，排序才有意义。
 *
 * （短期预算只影响提示词里的近期上下文池，不影响记忆总结的取材范围：
 *   总结走 memory-summarizer 的时间水位线，跟这个预算无关。）
 */
export const DEFAULT_MEMORY_BUDGET = {
    shortTermTokenBudget: 16000,
    coreMemoryTokenBudget: 1200,
    longTermTokenBudget: 3000,
} as const;

/** 旧的"不限量"默认值：迁移时用来识别从未被用户调整过的存量配置。 */
export const LEGACY_UNBOUNDED_MEMORY_BUDGET = 100000;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    autoReflectionEnabled: false,
    autoPersonaDriftEnabled: false,
    vectorRecallEnabled: true,
    memoryRecallLogEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: DEFAULT_MEMORY_BUDGET.shortTermTokenBudget,
    coreMemoryTokenBudget: DEFAULT_MEMORY_BUDGET.coreMemoryTokenBudget,
    longTermTokenBudget: DEFAULT_MEMORY_BUDGET.longTermTokenBudget,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT_V3,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
