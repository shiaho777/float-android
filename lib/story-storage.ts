import Dexie from "dexie";
import { formatPromptTimestamp } from "./prompt-time";
import { trackWrite } from "./pending-writes";
import { hydrateKvDb, kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StoryUiPrefs = {
  hideBubble?: boolean;
  hideAvatar?: boolean;
  hideTimestamp?: boolean;
  theme?: string;
  /** 是否启用剧情页的角色绑定语音。 */
  voiceEnabled?: boolean;
  /** 当前角色剧情页独立壁纸（data URL 或可访问 URL）。 */
  wallpaper?: string;
  /** 当前剧情会话上传的字体文件（data URL）。 */
  customFontDataUrl?: string;
  /** 当前剧情会话使用的远程字体 URL。 */
  customFontUrl?: string;
  /** 上传字体的原始文件名，仅用于设置页展示。 */
  customFontName?: string;
  /** 是否在剧情输入栏显示自动阅读控制。 */
  autoReadingEnabled?: boolean;
  /** 自动阅读滚动速度，单位为像素/秒。 */
  autoReadingSpeed?: number;
  /** 是否在“续写”右侧显示快捷输入面板按钮。 */
  quickInputEnabled?: boolean;
  /** 当前角色启用的快捷输入方案（存于公用方案仓库），仅保存选择。 */
  activeQuickInputSchemeId?: string;
  /** @deprecated 旧版按角色保存的快捷输入选项；已迁移进公用方案仓库。 */
  quickInputOptions?: string[];
  /** @deprecated 旧版按角色保存的插入光标位置；已迁移进公用方案仓库。 */
  quickInputCursor?: "left" | "middle" | "right";
};

/** 快捷输入面板默认选项：成对引号 + 常用标点。 */
export const STORY_DEFAULT_QUICK_INPUT_OPTIONS = ["“”", "「」", "，", "？", "……"];

export type StoryTailScheme = {
  id: string;
  name: string;
  /** 写入生成提示词的输出格式/契约。 */
  prompt: string;
  /** 在沙盒 iframe 中运行的 HTML/CSS/JS 渲染模板。 */
  renderHtml?: string;
  /** 传给渲染模板的可编辑预览原文。 */
  preview: string;
};

// ── 剧情尾部内置方案（剧情设置页与小卷工具共用）──────────
// 渲染画布在沙盒 iframe 里运行，AI 输出原文经 window.STORY_RAW / {{RAW}} 注入。

export const STORY_DEFAULT_STATUS_RENDER = `<style>
:root{--bg:#fff;--text:#334155;--sub:#94a3b8;--line:#e2e8f0}
@media(prefers-color-scheme:dark){:root{--bg:#1c1c1e;--text:#e5e7eb;--sub:#94a3b8;--line:#334155}}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:13px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
.status{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:2px}
.item{min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}
.key{display:block;color:var(--sub);font-size:10px;margin-bottom:2px}.value{display:block;overflow-wrap:anywhere;white-space:pre-wrap}
</style>
<div id="status" class="status"></div>
<script>
const root=document.getElementById('status');
const rows=(window.STORY_RAW||'').split(/\\n+/).flatMap(line=>line.split(/\\s{2,}/)).map(v=>v.trim()).filter(Boolean);
for(const row of rows){const parts=row.split(/[｜|：:]/);const item=document.createElement('div');item.className='item';const key=document.createElement('span');key.className='key';key.textContent=parts.length>1?parts.shift().trim():'状态';const value=document.createElement('span');value.className='value';value.textContent=parts.join('｜').trim()||row;item.append(key,value);root.append(item)}
</script>`;

export const STORY_DEFAULT_THEATER_RENDER = `<style>
:root{--paper:#fffdf8;--text:#4b5563;--sub:#9a8f80;--line:#eadfce}
@media(prefers-color-scheme:dark){:root{--paper:#24211d;--text:#e7e1d8;--sub:#a89f94;--line:#4a433a}}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--text);font:13px/1.8 Georgia,"Songti SC",serif}
.theater{position:relative;padding:16px 17px;border:1px solid var(--line);border-radius:14px;background:var(--paper)}
.title{margin-bottom:7px;color:var(--sub);font:10px/1.2 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;letter-spacing:.22em}.text{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
<section class="theater"><div class="title">小剧场</div><div id="text" class="text"></div></section>
<script>document.getElementById('text').textContent=window.STORY_RAW||''</script>`;

export const STORY_DEFAULT_STATUS_SCHEME: StoryTailScheme = {
  id: "status-default",
  name: "关系温度卡",
  prompt: "在正文末尾输出 <story_status>，简洁记录当前时间、地点、关系温度和双方状态；内容会进入下一轮上下文。",
  renderHtml: STORY_DEFAULT_STATUS_RENDER,
  preview: "时间｜夜晚  地点｜窗边\n关系温度｜72%  状态｜靠近",
};

export const STORY_DEFAULT_STATUS_HTML_SCHEME: StoryTailScheme = {
  id: "status-html",
  name: "自定义 HTML 状态栏",
  prompt: "在正文末尾输出 <story_status>，依次记录时间、地点、关系与双方状态；只输出结构化纯文本，不要自行输出 HTML。内容会进入下一轮上下文。",
  renderHtml: STORY_DEFAULT_STATUS_RENDER,
  preview: "时间｜夜晚  地点｜窗边\n关系｜逐渐靠近  状态｜安静相伴",
};

export const STORY_DEFAULT_THEATER_SCHEME: StoryTailScheme = {
  id: "theater-default",
  name: "片尾彩蛋",
  prompt: "在正文末尾输出 <story_theater>，写一段不影响主线的短小片尾彩蛋；默认仅展示，不进入下一轮上下文。",
  renderHtml: STORY_DEFAULT_THEATER_RENDER,
  preview: "片尾彩蛋｜如果那一刻被拍成照片，大概会被珍藏很久。",
};

export const STORY_DEFAULT_FURRY_THEATER_SCHEME: StoryTailScheme = {
  id: "theater-furry",
  name: "毛茸茸派对小剧场",
  prompt: "在正文末尾输出 <story_theater>，写一段“毛茸茸派对”小剧场：假设角色和用户都是某一种毛茸茸的动物，基于刚刚发生的剧情，描写一段他们以动物形态互动的小故事；默认仅展示，不进入下一轮上下文。",
  renderHtml: STORY_DEFAULT_THEATER_RENDER,
  preview: "毛茸茸派对｜大尾巴扫了扫你的鼻尖，你们依偎在阳光下打着呼噜。",
};

/** 快捷输入面板方案：一组命名好的选项 + 插入光标位置，保存于公用方案仓库。 */
export type StoryQuickInputScheme = {
  id: string;
  name: string;
  /** 点按即插入输入框的选项列表。 */
  options: string[];
  /** 点按选项插入后，光标落在插入内容的左边/中间/右边。 */
  cursor?: "left" | "middle" | "right";
};

/** 公用方案仓库：文风/状态栏/小剧场/快捷输入方案的定义都全局共享，角色只保存“启用哪一个”的选择。 */
export type StorySchemeRepository = {
  proseStyleSchemes: StoryProseStyleScheme[];
  statusSchemes: StoryTailScheme[];
  theaterSchemes: StoryTailScheme[];
  quickInputSchemes: StoryQuickInputScheme[];
};

/** 文风方案内置默认（首次使用/仓库为空时注入公用仓库）。 */
export const STORY_DEFAULT_PROSE_STYLE_SCHEMES: StoryProseStyleScheme[] = [
  { id: "style-natural", name: "自然文风", prompt: "自然、连贯地推进场景，动作与对白比例均衡，不替用户决定心理和行动。" },
  { id: "style-delicate", name: "细腻慢热", prompt: "节奏舒缓，重视细小动作、感官变化和情绪递进，避免突然跳转关系。" },
  { id: "style-cinema", name: "电影感叙事", prompt: "使用清晰镜头感与场面调度推进剧情，语言克制，画面明确。" },
];

/** 快捷输入面板内置默认方案。 */
export const STORY_DEFAULT_QUICK_INPUT_SCHEME: StoryQuickInputScheme = {
  id: "quick-default",
  name: "默认符号",
  options: [...STORY_DEFAULT_QUICK_INPUT_OPTIONS],
  cursor: "middle",
};

function defaultStorySchemeRepository(): StorySchemeRepository {
  return {
    proseStyleSchemes: STORY_DEFAULT_PROSE_STYLE_SCHEMES.map((item) => ({ ...item })),
    statusSchemes: [STORY_DEFAULT_STATUS_SCHEME, STORY_DEFAULT_STATUS_HTML_SCHEME].map((item) => ({ ...item })),
    theaterSchemes: [STORY_DEFAULT_THEATER_SCHEME, STORY_DEFAULT_FURRY_THEATER_SCHEME].map((item) => ({ ...item })),
    quickInputSchemes: [{ ...STORY_DEFAULT_QUICK_INPUT_SCHEME, options: [...STORY_DEFAULT_QUICK_INPUT_SCHEME.options] }],
  };
}

/** 公用方案仓库的 KV 键；已登记进数据备份模块（创作与玩法），随导出备份走。 */
const STORY_SCHEME_REPO_KEY = "ai_phone_story_scheme_repo_v1";

/** 仓库事件：仓库内容变化（设置页/小卷工具写入）时广播，剧情页据此刷新。 */
export const STORY_SCHEME_REPO_EVENT = "story-scheme-repo-updated";

function sanitizeProseStyleScheme(raw: unknown): StoryProseStyleScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  // 新建方案时 prompt 留空是正常状态（等用户填写），不能因此丢弃整个方案。
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "未命名文风",
    prompt: typeof item.prompt === "string" ? item.prompt : "",
  };
}

function sanitizeTailScheme(raw: unknown): StoryTailScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "未命名方案",
    prompt: typeof item.prompt === "string" ? item.prompt : "",
    renderHtml: typeof item.renderHtml === "string" ? item.renderHtml : "",
    preview: typeof item.preview === "string" ? item.preview : "",
  };
}

function sanitizeQuickInputScheme(raw: unknown): StoryQuickInputScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (!Array.isArray(item.options)) return null;
  const options = item.options.filter((option): option is string => typeof option === "string");
  const cursor = item.cursor === "left" || item.cursor === "right" ? item.cursor : "middle";
  return {
    id: item.id.trim(),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "未命名方案",
    options,
    cursor,
  };
}

/** 读取公用方案仓库；列表缺失/为空时补默认方案，损坏数据自动剔除。 */
export function loadStorySchemeRepository(): StorySchemeRepository {
  const fallback = defaultStorySchemeRepository();
  let raw: unknown = null;
  try {
    const text = kvGet(STORY_SCHEME_REPO_KEY);
    if (text) raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return fallback;
  const item = raw as Record<string, unknown>;

  const proseStyleSchemes = Array.isArray(item.proseStyleSchemes)
    ? item.proseStyleSchemes.map(sanitizeProseStyleScheme).filter((s): s is StoryProseStyleScheme => s !== null)
    : [];
  const statusSchemes = Array.isArray(item.statusSchemes)
    ? item.statusSchemes.map(sanitizeTailScheme).filter((s): s is StoryTailScheme => s !== null)
    : [];
  const theaterSchemes = Array.isArray(item.theaterSchemes)
    ? item.theaterSchemes.map(sanitizeTailScheme).filter((s): s is StoryTailScheme => s !== null)
    : [];
  const quickInputSchemes = Array.isArray(item.quickInputSchemes)
    ? item.quickInputSchemes.map(sanitizeQuickInputScheme).filter((s): s is StoryQuickInputScheme => s !== null)
    : [];

  return {
    proseStyleSchemes: proseStyleSchemes.length ? proseStyleSchemes : fallback.proseStyleSchemes,
    statusSchemes: statusSchemes.length ? statusSchemes : fallback.statusSchemes,
    theaterSchemes: theaterSchemes.length ? theaterSchemes : fallback.theaterSchemes,
    quickInputSchemes: quickInputSchemes.length ? quickInputSchemes : fallback.quickInputSchemes,
  };
}

/** 保存公用方案仓库并广播变更事件。 */
export function saveStorySchemeRepository(repo: StorySchemeRepository): void {
  kvSet(STORY_SCHEME_REPO_KEY, JSON.stringify(repo));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STORY_SCHEME_REPO_EVENT));
  }
}

/** 读取公用仓库里的尾部方案；角色设置不再持有方案列表（迁移后仅剩启用选择）。 */
export function loadStoryTailSchemes(settings: StoryCharacterSettings | undefined): {
  statusSchemes: StoryTailScheme[];
  theaterSchemes: StoryTailScheme[];
} {
  const repo = loadStorySchemeRepository();
  // 兼容导入的旧备份：会话里还带着旧版方案列表时优先展示（hydrate 迁移会将其并入仓库）
  return {
    statusSchemes: settings?.statusSchemes?.length ? settings.statusSchemes : repo.statusSchemes,
    theaterSchemes: settings?.theaterSchemes?.length ? settings.theaterSchemes : repo.theaterSchemes,
  };
}

/** 解析某角色当前启用的文风/状态栏/小剧场方案（公用仓库 + 旧数据回退）。 */
export function resolveActiveStorySchemes(settings: StoryCharacterSettings | undefined): {
  proseStyle: StoryProseStyleScheme | null;
  status: StoryTailScheme | null;
  theater: StoryTailScheme | null;
} {
  const repo = loadStorySchemeRepository();
  const pickProse = settings?.proseStyleSchemes?.find((item) => item.id === settings?.activeProseStyleSchemeId) || null;
  const pickStatus = settings?.statusSchemes?.find((item) => item.id === settings?.activeStatusSchemeId) || null;
  const pickTheater = settings?.theaterSchemes?.find((item) => item.id === settings?.activeTheaterSchemeId) || null;
  // 启用的方案被删（如别的角色删掉了公用方案，本角色选择悬空）时回落首个方案，
  // 与设置页 normalizeSettings、resolveActiveQuickInputScheme 的回落语义一致，
  // 避免该角色的文风/尾部输出静默失效。
  return {
    proseStyle: repo.proseStyleSchemes.find((item) => item.id === settings?.activeProseStyleSchemeId) || pickProse || repo.proseStyleSchemes[0] || null,
    status: repo.statusSchemes.find((item) => item.id === settings?.activeStatusSchemeId) || pickStatus || repo.statusSchemes[0] || null,
    theater: repo.theaterSchemes.find((item) => item.id === settings?.activeTheaterSchemeId) || pickTheater || repo.theaterSchemes[0] || null,
  };
}

/** 解析某角色当前启用的快捷输入方案；旧版字段迁移前的兜底也在这里处理。 */
export function resolveActiveQuickInputScheme(prefs: StoryUiPrefs | undefined, repoInput?: StorySchemeRepository): StoryQuickInputScheme {
  const repo = repoInput ?? loadStorySchemeRepository();
  const selected = repo.quickInputSchemes.find((item) => item.id === prefs?.activeQuickInputSchemeId);
  if (selected) return selected;
  // 迁移前/旧备份兜底：用角色自己保存的选项匹配仓库里的同内容方案
  const legacyOptions = (prefs?.quickInputOptions ?? []).filter((item) => item.trim());
  if (legacyOptions.length) {
    const cursor = prefs?.quickInputCursor ?? "middle";
    const matched = repo.quickInputSchemes.find((item) => item.cursor === cursor && item.options.length === legacyOptions.length && item.options.every((option, index) => option === legacyOptions[index]));
    if (matched) return matched;
  }
  return repo.quickInputSchemes[0] || STORY_DEFAULT_QUICK_INPUT_SCHEME;
}

/** 剧情正文文风方案：只约束 AI 的写作方式，不定义任何尾部输出结构。 */
export type StoryProseStyleScheme = {
  id: string;
  name: string;
  prompt: string;
};

export type StoryPromptEntry = {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
};

export type StoryCharacterSettings = {
  presetName?: string;
  extraPrompt?: string;
  customPromptEntries?: StoryPromptEntry[];
  enabledPresetPromptIds?: string[];
  minChars?: number;
  maxChars?: number;
  userPerspective?: "second" | "third" | "username";
  proseStyle?: string;
  proseStylePrompt?: string;
  /** 当前角色启用的文风方案（存于公用方案仓库），仅保存选择。 */
  activeProseStyleSchemeId?: string;
  /** 当前角色启用的状态栏方案（存于公用方案仓库），仅保存选择。 */
  activeStatusSchemeId?: string;
  /** 当前角色启用的小剧场方案（存于公用方案仓库），仅保存选择。 */
  activeTheaterSchemeId?: string;
  /** @deprecated 旧版按角色保存的文风方案列表；已迁移进公用方案仓库。 */
  proseStyleSchemes?: StoryProseStyleScheme[];
  /** @deprecated 旧版按角色保存的状态栏方案列表；已迁移进公用方案仓库。 */
  statusSchemes?: StoryTailScheme[];
  /** @deprecated 旧版按角色保存的小剧场方案列表；已迁移进公用方案仓库。 */
  theaterSchemes?: StoryTailScheme[];
  floatingPhoneEnabled?: boolean;
  floatingPhoneInContext?: boolean;
};

export type StoryOwnerType = "single" | "group";

/** 多人见面组保存在 KV 中，具体剧情消息仍按 StorySession 分会话存储。 */
export type StoryGroup = {
  id: string;
  name: string;
  characterIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type StorySession = {
  id: string;
  characterId: string;
  title?: string;
  /** 旧数据缺省时自动迁移为 single。 */
  ownerType?: StoryOwnerType;
  /** single 时为角色 id；group 时为多人组 id。 */
  ownerId?: string;
  /** 多人剧情的全部参与角色；第一个角色作为 API/预设绑定的主角色。 */
  participantIds?: string[];
  /** 同一见面对象下的剧情分页；main 固定为第一节主线。 */
  branchId?: string;
  branchName?: string;
  branchOrder?: number;
  createdAt?: string;
  /** 新分线是否允许读取创建前的最近记忆；开启后由 UI 锁定，避免反复改变语义。 */
  inheritRecentMemory?: boolean;
  inheritRecentMemoryLocked?: boolean;
  /** 独立剧情不读取角色短期、核心和长期记忆。 */
  independentStory?: boolean;
  /** 小说目录页展示的自定义标签，保存在该故事的主线会话上。 */
  catalogTags?: string[];
  /** 从相册设置的剧情封面/头像（data URL）；通常保存在主线会话。 */
  storyAvatar?: string;
  /** 邀请或快捷新建后，首次进入时由角色自动开启剧情。 */
  autoStartPrompt?: string;
  autoStartRequestedAt?: string;
  /** 独立剧情结束后可显式并入角色记忆。 */
  endedAt?: string;
  includedInMemoryAt?: string;
  updatedAt: string;
  customCSS?: string;
  foldTags?: string;            // Comma-separated tag names to fold for this session.
  contextExcludedTags?: string; // Comma-separated tag names stripped before sending story history to the LLM.
  uiPrefs?: StoryUiPrefs;
  /** 剧情 APP 专属设置；每个角色的唯一会话各自独立保存。 */
  settings?: StoryCharacterSettings;
  lastMessageId?: string;
  lastMessagePreview?: string;
  lastMessageAt?: string;
};

export type StoryMessageRole = "user" | "assistant" | "system";

export type StoryMessage = {
  id: string;
  sessionId: string;
  role: StoryMessageRole;
  rawContent: string;
  renderedContent?: string;
  storySummary?: string;
  regexSignature?: string;
  parserVersion?: number;
  createdAt: string;
};

export type StoryProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
  /** 多人剧情的摘要会原样抄进每个参与者；个人记忆只留点到本人的句子。 */
  shared?: boolean;
};

class StoryDatabase extends Dexie {
  sessions!: Dexie.Table<StorySession, string>;
  messages!: Dexie.Table<StoryMessage, string>;

  constructor() {
    super("AiPhoneStoryDB");
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
    });
  }
}

const storyDb = new StoryDatabase();

const STORY_GROUPS_KEY = "ai_phone_story_groups_v1";
registerKvMigration(STORY_GROUPS_KEY);

let _hydrated = false;
let _sessionsCache: StorySession[] = [];
let _messagesCache: StoryMessage[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getStorySessionActivityTime(session: StorySession): number {
  const lastMessageTime = _messagesCache
    .filter((message) => message.sessionId === session.id)
    .reduce((latest, message) => Math.max(latest, parseTime(message.createdAt)), 0);
  return Math.max(lastMessageTime, parseTime(session.updatedAt));
}

function isPreferredStorySession(candidate: StorySession, current: StorySession): boolean {
  const candidateTime = getStorySessionActivityTime(candidate);
  const currentTime = getStorySessionActivityTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateUpdated = parseTime(candidate.updatedAt);
  const currentUpdated = parseTime(current.updatedAt);
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return candidate.id.localeCompare(current.id) > 0;
}

function normalizeStorySessions(sessions: StorySession[]): { items: StorySession[]; changed: boolean } {
  const normalized: StorySession[] = [];
  const indexByBranch = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    const id = session.id?.trim();
    const characterId = session.characterId?.trim();
    if (!id || !characterId) {
      changed = true;
      continue;
    }
    const ownerType: StoryOwnerType = session.ownerType === "group" ? "group" : "single";
    const ownerId = session.ownerId?.trim() || characterId;
    const branchId = session.branchId?.trim() || "main";
    const branchName = session.branchName?.trim() || (branchId === "main" ? "主线剧情" : session.title?.trim() || "分线剧情");
    const createdAt = session.createdAt || session.updatedAt || new Date().toISOString();
    const participantIds = ownerType === "group"
      ? Array.from(new Set((session.participantIds || [characterId]).map((value) => value.trim()).filter(Boolean)))
      : [characterId];
    const branchOrder = branchId === "main" ? 0 : Math.max(1, session.branchOrder ?? 1);
    const item: StorySession = {
      ...session,
      id,
      characterId,
      ownerType,
      ownerId,
      participantIds,
      branchId,
      branchName,
      branchOrder,
      createdAt,
    };
    if (
      id !== session.id || characterId !== session.characterId || ownerType !== session.ownerType
      || ownerId !== session.ownerId || branchId !== session.branchId || branchName !== session.branchName
      || createdAt !== session.createdAt || branchOrder !== session.branchOrder
      || participantIds.join("\u0000") !== (session.participantIds || []).join("\u0000")
    ) changed = true;
    const branchKey = `${ownerType}:${ownerId}:${branchId}`;
    const existingIndex = indexByBranch.get(branchKey);
    if (existingIndex === undefined) {
      indexByBranch.set(branchKey, normalized.length);
      normalized.push(item);
      continue;
    }

    changed = true;
    if (isPreferredStorySession(item, normalized[existingIndex])) {
      normalized[existingIndex] = item;
    }
  }

  return { items: normalized, changed };
}

function persistStorySessionsSnapshot(sessions: StorySession[]): void {
  storyDb.transaction("rw", storyDb.sessions, async () => {
    await storyDb.sessions.clear();
    await storyDb.sessions.bulkPut(sessions);
  }).catch(() => undefined);
}

// ── 旧版按角色保存的方案 → 公用方案仓库迁移 ──────────────────
// 旧数据里文风/状态栏/小剧场方案列表挂在每个角色的 settings 上、快捷输入
// 选项挂在 uiPrefs 上；现在统一并入公用仓库（去重后共享），角色侧只保留
// “启用哪一个”的 id 选择。导入旧备份后同样走这里再迁一次。
async function migrateLegacyStorySchemeData(): Promise<void> {
  const hasLegacy = _sessionsCache.some((session) => Boolean(
    session.settings?.proseStyleSchemes?.length
    || session.settings?.statusSchemes?.length
    || session.settings?.theaterSchemes?.length
    || session.uiPrefs?.quickInputOptions?.length,
  ));
  if (!hasLegacy) return;
  // 必须先等 kv 水合完成再读仓库，否则会把已有仓库误判为空、用默认值覆盖
  try { await hydrateKvDb(); } catch { /* 读取失败时按当前缓存继续 */ }

  const repo = loadStorySchemeRepository();
  let repoChanged = false;
  const tailKey = (item: StoryTailScheme) => `${item.name}∥${item.prompt}∥${item.renderHtml || ""}∥${item.preview || ""}`;
  const proseKey = (item: StoryProseStyleScheme) => `${item.name}∥${item.prompt}`;

  // 合并去重规则：内容完全相同 → 视为同一方案；id 空闲 → 沿用原 id；
  // id 已被占用但内容不同（该角色改过同名方案）→ 另存为新方案并重映射启用选择
  function makeMerger<T extends { id: string; name: string }>(
    existing: T[],
    contentKey: (item: T) => string,
    clone: (item: T, id: string, name: string) => T,
  ) {
    const seenIds = new Set(existing.map((item) => item.id));
    const seenContent = new Set(existing.map(contentKey));
    const seenNames = new Set(existing.map((item) => item.name));
    return (list: T[], idMap: Map<string, string>) => {
      for (const scheme of list) {
        const content = contentKey(scheme);
        if (seenContent.has(content)) continue;
        let id = scheme.id;
        let name = scheme.name;
        if (seenIds.has(id)) {
          // 同 id 不同内容：保留这份角色自定义，另立新方案
          id = `${id}-migrated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          let n = 2;
          while (seenNames.has(name)) { name = `${scheme.name} ${n}`; n += 1; }
          idMap.set(scheme.id, id);
        }
        seenIds.add(id);
        seenContent.add(content);
        seenNames.add(name);
        existing.push(clone(scheme, id, name));
        repoChanged = true;
      }
    };
  }

  const mergeProse = makeMerger(repo.proseStyleSchemes, proseKey, (item, id, name) => ({ id, name, prompt: item.prompt }));
  const mergeStatus = makeMerger(repo.statusSchemes, tailKey, (item, id, name) => ({ ...item, id, name }));
  const mergeTheater = makeMerger(repo.theaterSchemes, tailKey, (item, id, name) => ({ ...item, id, name }));

  const quickSigs = new Map<string, string>();
  for (const scheme of repo.quickInputSchemes) {
    quickSigs.set(`${scheme.cursor || "middle"}∥${scheme.options.join("\u0000")}`, scheme.id);
  }
  const quickNames = new Set(repo.quickInputSchemes.map((item) => item.name));

  for (const session of [..._sessionsCache]) {
    const settings = session.settings;
    const prefs = session.uiPrefs;
    let settingsChanged = false;
    let prefsChanged = false;
    let nextSettings = settings ? { ...settings } : undefined;
    let activeQuickInputSchemeId = prefs?.activeQuickInputSchemeId;

    if (settings?.proseStyleSchemes?.length) {
      const idMap = new Map<string, string>();
      mergeProse(settings.proseStyleSchemes, idMap);
      if (idMap.has(settings.activeProseStyleSchemeId || "")) {
        nextSettings = { ...nextSettings!, activeProseStyleSchemeId: idMap.get(settings.activeProseStyleSchemeId!) };
      }
      settingsChanged = true;
    }
    if (settings?.statusSchemes?.length) {
      const idMap = new Map<string, string>();
      mergeStatus(settings.statusSchemes, idMap);
      if (idMap.has(settings.activeStatusSchemeId || "")) {
        nextSettings = { ...nextSettings!, activeStatusSchemeId: idMap.get(settings.activeStatusSchemeId!) };
      }
      settingsChanged = true;
    }
    if (settings?.theaterSchemes?.length) {
      const idMap = new Map<string, string>();
      mergeTheater(settings.theaterSchemes, idMap);
      if (idMap.has(settings.activeTheaterSchemeId || "")) {
        nextSettings = { ...nextSettings!, activeTheaterSchemeId: idMap.get(settings.activeTheaterSchemeId!) };
      }
      settingsChanged = true;
    }

    if (prefs?.quickInputOptions?.length) {
      const options = prefs.quickInputOptions.filter((item) => item.trim());
      if (options.length) {
        const cursor = prefs.quickInputCursor ?? "middle";
        const sig = `${cursor}∥${options.join("\u0000")}`;
        const existingId = quickSigs.get(sig);
        if (existingId) {
          activeQuickInputSchemeId = existingId;
        } else {
          const id = `quick-migrated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          let name = "自定义符号";
          let n = 2;
          while (quickNames.has(name)) { name = `自定义符号 ${n}`; n += 1; }
          quickNames.add(name);
          repo.quickInputSchemes.push({ id, name, options, cursor });
          quickSigs.set(sig, id);
          repoChanged = true;
          activeQuickInputSchemeId = id;
        }
      }
      // 选项全空 = 使用默认选项，交给 resolveActiveQuickInputScheme 回落首个方案
      prefsChanged = true;
    } else if (prefs && (prefs.quickInputOptions !== undefined || prefs.quickInputCursor !== undefined)) {
      prefsChanged = true; // 显式清空过的旧字段也一并移除
    }

    if (!settingsChanged && !prefsChanged) continue;
    updateStorySession(session.id, {
      ...(settingsChanged ? { settings: { ...nextSettings, proseStyleSchemes: undefined, statusSchemes: undefined, theaterSchemes: undefined } } : {}),
      ...(prefsChanged ? { uiPrefs: { ...prefs, quickInputOptions: undefined, quickInputCursor: undefined, activeQuickInputSchemeId } } : {}),
      // 迁移是数据结构调整而非用户活动，保留原排序时间戳
      updatedAt: session.updatedAt,
    });
  }

  if (repoChanged) saveStorySchemeRepository(repo);
}

export async function hydrateStoryStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  // 剧情多人组与“上次停留分页”保存在 KV；先水合，避免首屏把已有组误判为空。
  try { await hydrateKvDb(); } catch { /* KV 失败不阻塞 IndexedDB 剧情消息 */ }
  const [sessions, messages] = await Promise.all([
    storyDb.sessions.toArray().catch(() => []),
    storyDb.messages.toArray().catch(() => []),
  ]);
  _messagesCache = messages;
  const normalized = normalizeStorySessions(sessions);
  _sessionsCache = normalized.items;
  if (normalized.changed) persistStorySessionsSnapshot(normalized.items);
  // 迁移失败不应阻塞剧情数据水合（旧结构数据下次启动会再尝试迁移）
  try {
    await migrateLegacyStorySchemeData();
  } catch (error) {
    console.warn("[StoryStorage] scheme migration failed:", error);
  }
  _hydrated = true;
}

export function loadStorySessions(): StorySession[] {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) _sessionsCache = normalized.items;
  // 空值安全：旧版本/异常导入的数据可能缺 updatedAt，排序不能让页面崩溃
  return [..._sessionsCache].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function loadStoryMessages(sessionId: string): StoryMessage[] {
  return _messagesCache
    .filter((message) => message.sessionId === sessionId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export type CreateStorySessionOptions = {
  ownerType?: StoryOwnerType;
  ownerId?: string;
  participantIds?: string[];
  branchId?: string;
  branchName?: string;
  branchOrder?: number;
  inheritRecentMemory?: boolean;
  independentStory?: boolean;
  baseSession?: StorySession;
};

export function getStorySessionOwnerKey(session: Pick<StorySession, "characterId" | "ownerType" | "ownerId">): string {
  const ownerType: StoryOwnerType = session.ownerType === "group" ? "group" : "single";
  return `${ownerType}:${session.ownerId || session.characterId}`;
}

export function loadStorySessionsForOwner(ownerType: StoryOwnerType, ownerId: string): StorySession[] {
  return loadStorySessions()
    .filter((session) => getStorySessionOwnerKey(session) === `${ownerType}:${ownerId}`)
    .sort((a, b) => (a.branchOrder ?? 0) - (b.branchOrder ?? 0) || (a.createdAt || "").localeCompare(b.createdAt || ""));
}

export function createOrGetStorySession(characterId: string, options: CreateStorySessionOptions = {}): StorySession {
  const normalized = normalizeStorySessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistStorySessionsSnapshot(normalized.items);
  }
  const ownerType: StoryOwnerType = options.ownerType === "group" ? "group" : "single";
  const ownerId = options.ownerId?.trim() || characterId;
  const branchId = options.branchId?.trim() || "main";
  const existing = _sessionsCache.find((session) => (
    getStorySessionOwnerKey(session) === `${ownerType}:${ownerId}`
    && (session.branchId || "main") === branchId
  ));
  if (existing) return existing;

  const now = new Date().toISOString();
  const base = options.baseSession;
  const ownerSessions = loadStorySessionsForOwner(ownerType, ownerId);
  const session: StorySession = {
    id: generateId("story_sess"),
    characterId,
    ownerType,
    ownerId,
    participantIds: ownerType === "group"
      ? Array.from(new Set((options.participantIds || [characterId]).filter(Boolean)))
      : [characterId],
    branchId,
    branchName: options.branchName?.trim() || (branchId === "main" ? "主线剧情" : `分线剧情 ${ownerSessions.length}`),
    branchOrder: branchId === "main" ? 0 : options.branchOrder ?? Math.max(0, ...ownerSessions.map((item) => item.branchOrder ?? 0)) + 1,
    inheritRecentMemory: branchId === "main" ? true : Boolean(options.inheritRecentMemory),
    inheritRecentMemoryLocked: branchId !== "main" && Boolean(options.inheritRecentMemory),
    independentStory: branchId === "main" ? false : Boolean(options.independentStory),
    createdAt: now,
    updatedAt: now,
    foldTags: base?.foldTags ?? "think,thinking,story_status,story_theater",
    contextExcludedTags: base?.contextExcludedTags ?? "think,thinking,story_theater",
    customCSS: base?.customCSS,
    settings: base?.settings ? { ...base.settings } : undefined,
    uiPrefs: base?.uiPrefs ? { ...base.uiPrefs } : {},
  };
  _sessionsCache.unshift(session);
  trackWrite(storyDb.sessions.put(session)).catch(() => undefined);
  return session;
}

export function deleteStorySessions(sessionIds: string[], options?: { allowMain?: boolean }): void {
  const requested = new Set(sessionIds);
  const deletable = _sessionsCache
    .filter((session) => requested.has(session.id) && (options?.allowMain || (session.branchId || "main") !== "main"))
    .map((session) => session.id);
  if (!deletable.length) return;
  const ids = new Set(deletable);
  const messageIds = _messagesCache.filter((message) => ids.has(message.sessionId)).map((message) => message.id);
  _sessionsCache = _sessionsCache.filter((session) => !ids.has(session.id));
  _messagesCache = _messagesCache.filter((message) => !ids.has(message.sessionId));
  storyDb.transaction("rw", storyDb.sessions, storyDb.messages, async () => {
    await storyDb.sessions.bulkDelete(deletable);
    if (messageIds.length) await storyDb.messages.bulkDelete(messageIds);
  }).catch(() => undefined);
}

function sanitizeStoryGroup(raw: unknown): StoryGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const characterIds = Array.isArray(item.characterIds)
    ? Array.from(new Set(item.characterIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())))
    : [];
  if (!id || characterIds.length < 2) return null;
  const now = new Date().toISOString();
  return {
    id,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "多人剧情",
    characterIds,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
  };
}

export function loadStoryGroups(): StoryGroup[] {
  try {
    const raw = JSON.parse(kvGet(STORY_GROUPS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeStoryGroup).filter((item): item is StoryGroup => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export function saveStoryGroups(groups: StoryGroup[]): void {
  kvSet(STORY_GROUPS_KEY, JSON.stringify(groups.map(sanitizeStoryGroup).filter(Boolean)));
}

export function createStoryGroup(characterIds: string[], name?: string): StoryGroup {
  const ids = Array.from(new Set(characterIds.filter(Boolean)));
  if (ids.length < 2) throw new Error("多人剧情至少需要选择两个角色");
  const now = new Date().toISOString();
  const group: StoryGroup = {
    id: generateId("story_group"),
    name: name?.trim() || "多人剧情",
    characterIds: ids,
    createdAt: now,
    updatedAt: now,
  };
  saveStoryGroups([group, ...loadStoryGroups()]);
  return group;
}

export function updateStoryGroup(groupId: string, updates: Partial<Pick<StoryGroup, "name" | "characterIds">>): StoryGroup | null {
  const groups = loadStoryGroups();
  const index = groups.findIndex((group) => group.id === groupId);
  if (index < 0) return null;
  const characterIds = updates.characterIds
    ? Array.from(new Set(updates.characterIds.filter(Boolean)))
    : groups[index].characterIds;
  if (characterIds.length < 2) return null;
  const next = {
    ...groups[index],
    ...updates,
    name: updates.name?.trim() || groups[index].name,
    characterIds,
    updatedAt: new Date().toISOString(),
  };
  groups[index] = next;
  saveStoryGroups(groups);
  return next;
}

export function deleteStoryGroup(groupId: string): void {
  saveStoryGroups(loadStoryGroups().filter((group) => group.id !== groupId));
  const sessionIds = _sessionsCache.filter((session) => getStorySessionOwnerKey(session) === `group:${groupId}`).map((session) => session.id);
  deleteStorySessions(sessionIds, { allowMain: true });
}

export function updateStorySession(sessionId: string, updates: Partial<StorySession>): StorySession | null {
  const idx = _sessionsCache.findIndex((session) => session.id === sessionId);
  if (idx === -1) return null;
  const next: StorySession = {
    ..._sessionsCache[idx],
    ...updates,
    uiPrefs: { ..._sessionsCache[idx].uiPrefs, ...updates.uiPrefs },
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  _sessionsCache[idx] = next;
  trackWrite(storyDb.sessions.put(next)).catch(() => undefined);
  return next;
}

export function pushStoryMessage(
  input: Omit<StoryMessage, "id" | "createdAt">
): StoryMessage {
  const message: StoryMessage = {
    ...input,
    id: generateId("story_msg"),
    createdAt: new Date().toISOString(),
  };
  _messagesCache.push(message);
  trackWrite(storyDb.messages.put(message)).catch(() => undefined);

  const previewSource = message.renderedContent || message.rawContent;
  const preview = previewSource.replace(/\s+/g, " ").trim().slice(0, 64);
  updateStorySession(message.sessionId, {
    lastMessageId: message.id,
    lastMessagePreview: preview,
    lastMessageAt: message.createdAt,
    updatedAt: message.createdAt,
  });

  return message;
}

/** 把指定分页设为剧情 APP 下次打开的目标页，可由聊天邀请等跨 APP 流程调用。 */
export function saveStoryLaunchTarget(session: StorySession): void {
  const ownerType: StoryOwnerType = session.ownerType === "group" ? "group" : "single";
  const ownerId = session.ownerId || session.characterId;
  const ownerKey = `${ownerType}:${ownerId}`;
  let pageMap: Record<string, string> = {};
  try {
    const parsed = JSON.parse(kvGet("story-active-page-map-v1") || "{}");
    if (parsed && typeof parsed === "object") pageMap = parsed as Record<string, string>;
  } catch { /* 损坏的旧值直接重建 */ }
  kvSet("story-active-page-map-v1", JSON.stringify({ ...pageMap, [ownerKey]: session.id }));
  kvSet("story-last-active-target-v1", JSON.stringify({ ownerType, ownerId }));
  kvSet("story-last-active-character-id", session.characterId);
}

/** Delete a single story message */
export function deleteStoryMessage(messageId: string): void {
    _messagesCache = _messagesCache.filter(m => m.id !== messageId);
    trackWrite(storyDb.messages.delete(messageId)).catch(() => undefined);
}

/** Delete a message and all messages after it (by createdAt in same session) */
export function deleteStoryMessagesFrom(sessionId: string, messageId: string): void {
    const msg = _messagesCache.find(m => m.id === messageId);
    if (!msg) return;
    const idsToDelete = _messagesCache
        .filter(m => m.sessionId === sessionId && m.createdAt >= msg.createdAt)
        .map(m => m.id);
    _messagesCache = _messagesCache.filter(m => !idsToDelete.includes(m.id));
    trackWrite(storyDb.messages.bulkDelete(idsToDelete)).catch(() => undefined);
}

/** Edit a story message's rawContent (renderedContent will be rebuilt by cache invalidation) */
export function editStoryMessage(messageId: string, newRawContent: string): void {
    const idx = _messagesCache.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    _messagesCache[idx] = {
        ..._messagesCache[idx],
        rawContent: newRawContent,
        renderedContent: undefined,
        regexSignature: undefined,
        parserVersion: undefined,
    };
    trackWrite(storyDb.messages.put(_messagesCache[idx])).catch(() => undefined);
}

export function replaceStoryMessages(sessionId: string, messages: StoryMessage[]): void {
  _messagesCache = _messagesCache.filter((message) => message.sessionId !== sessionId);
  _messagesCache.push(...messages);
  storyDb.messages.where("sessionId").equals(sessionId).delete()
    .then(() => storyDb.messages.bulkPut(messages))
    .catch(() => undefined);
}

function compactProjectionText(text: string, maxLen = 160): string {
  const plain = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_`-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadStoryProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string; userName?: string; charName?: string }
): StoryProjectionEntry[] {
  const sessions = _sessionsCache.filter((item) => {
    const participants = item.participantIds?.length ? item.participantIds : [item.characterId];
    if (!participants.includes(characterId)) return false;
    return !item.independentStory || Boolean(item.includedInMemoryAt);
  });
  if (!sessions.length) return [];
  const sharedSessionIds = new Set(sessions
    .filter(session => (session.participantIds?.length ? session.participantIds.length : 1) > 1)
    .map(session => session.id));
  const messages = sessions.flatMap((session) => loadStoryMessages(session.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const projections: StoryProjectionEntry[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    if (current.role !== "assistant") continue;
    if (options?.afterTimestamp && current.createdAt <= options.afterTimestamp) continue;

    if (!current.storySummary) continue;
    const summaryText = compactProjectionText(current.storySummary, 500);
    if (!summaryText) continue;

    const ts = formatPromptTimestamp(current.createdAt);
    projections.push({
      id: `story_projection_${current.id}`,
      timestamp: current.createdAt,
      content: `[事件 ${ts}] ${summaryText}`,
      shared: sharedSessionIds.has(current.sessionId),
    });
  }

  return projections;
}
