// lib/map-rpg-engine.ts
// RPG Map Mode — LLM integration for world generation + event expansion

import type { WorldSkeleton, WorldSkeletonInput, EventScene, GameSave, WorldNPC, QuestLine, EncounterSeed, CharacterAgent, AgentDecision, RichRegion, Declaration, CharStats } from "./map-types";
import { STAT_LABELS, ALL_STATS } from "./map-types";
import { simpleLLMCall } from "./api-helpers";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import type { ApiConfig } from "./settings-types";
import { loadCharacters } from "./character-storage";
import { resolveBinding, loadBindingConfig, loadPresets, loadWorldBooks, loadRegexes, resolveUserIdentity, loadApiConfigs } from "./settings-storage";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { retrieveMemoriesForPrompt, retrieveCoreMemoriesForPrompt } from "./memory-service";
import { formatLongTermMemories, formatCoreMemories } from "./memory-injector";
import { loadMemoryConfig } from "./memory-storage";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, clockForCalendarOwner } from "./calendar-storage";

import { estimateTokens } from "./token-counter";
import { loadAdventureInteractionConfig, loadDMTokenConfig } from "./map-storage";
import { DEFAULT_ADVENTURE_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";
import { normalizeUserNameToMacro, renderUserNameMacro } from "./user-macro";

// ── Debug log (set by map-view to capture prompts/responses) ──
let _debugCallback: ((type: string, content: string) => void) | null = null;
export function setDMDebugCallback(cb: ((type: string, content: string) => void) | null) { _debugCallback = cb; }
function dmLog(type: string, content: string) { _debugCallback?.(type, content); }
function formatDebugApiConfig(apiConfig: ApiConfig): string {
  return [
    `模型: ${apiConfig.defaultModel}`,
    `provider: ${apiConfig.provider}`,
    `baseUrl: ${apiConfig.baseUrl || "(空)"}`,
    `apiKey: ${apiConfig.apiKey ? `***${apiConfig.apiKey.slice(-4)}` : "(空)"}`,
    `id: ${apiConfig.id}`,
  ].join(" | ");
}
function formatDebugMessages(messages: Array<{ role: string; content: string }>, apiConfig?: ApiConfig): string {
  return [
    apiConfig ? `[config]\n${formatDebugApiConfig(apiConfig)}` : "",
    ...messages.map(m => `[${m.role}]\n${m.content}`),
  ].filter(Boolean).join("\n\n");
}

function buildAdventureCharacterBilingualInstruction(enabled: boolean, customPrompt?: string): string {
  return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_ADVENTURE_BILINGUAL_PROMPT);
}

function formatStats(s: CharStats): string {
  return ALL_STATS.map(k => `${STAT_LABELS[k]}${s[k]}`).join("/");
}

function dmPlayerName(ctx: DMContext): string {
  return ctx.playerName?.trim() || "玩家";
}

// ── Extract JSON from LLM response (handles code blocks, quotes, truncation, etc.) ──
function extractJSON(text: string): string {
  let s = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  // Chinese punctuation (outside strings is safe)
  s = s.replace(/，/g, ",").replace(/：/g, ":").replace(/；/g, ";");
  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Remove comments (// ...)
  s = s.replace(/\/\/[^\n"]*(?=\n)/g, "");
  // Walk through char by char — handle smart quotes, newlines, etc. with string awareness
  let fixed = "";
  let inString = false;
  let escaped = false;
  const SMART_DOUBLE = /[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/;
  const SMART_SINGLE = /[\u2018\u2019\u201A\u201B\u2032\u2035]/;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { fixed += ch; escaped = false; continue; }
    if (ch === "\\") { fixed += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; fixed += ch; continue; }
    if (inString) {
      // Smart quotes inside a string → escape them
      if (SMART_DOUBLE.test(ch)) { fixed += '\\"'; continue; }
      if (SMART_SINGLE.test(ch)) { fixed += "'"; continue; }
      if (ch === "\n") { fixed += "\\n"; continue; }
      if (ch === "\r") { continue; }
      if (ch === "\t") { fixed += "\\t"; continue; }
    } else {
      // Smart quotes outside a string → treat as regular quote (string boundary)
      if (SMART_DOUBLE.test(ch)) { inString = true; fixed += '"'; continue; }
    }
    fixed += ch;
  }
  s = fixed;
  // Try parse
  try { JSON.parse(s); return s; } catch { /* try repair */ }
  // Count unclosed brackets
  let braces = 0, brackets = 0;
  let inStr = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }
  // Remove any trailing partial value (cut at last complete comma)
  if (braces > 0 || brackets > 0) {
    const lastComma = s.lastIndexOf(",");
    if (lastComma > s.length * 0.5) {
      s = s.slice(0, lastComma);
    }
  }
  // Close open brackets/braces
  for (let i = 0; i < brackets; i++) s += "]";
  for (let i = 0; i < braces; i++) s += "}";
  return s;
}

import { loadDMPrompts } from "./map-storage";

// ── DM Prompt Defaults (exported for UI display) ──

function getActivePrompt(key: "scene" | "resolve" | "worldGen" | "ending", defaultVal: string): string {
  const custom = loadDMPrompts();
  return custom[key]?.trim() || defaultVal;
}

// ── 1. Generate World Skeleton ──

export const DEFAULT_WORLD_GEN_PROMPT = `你是RPG世界架构师兼DM。用户描述世界观，你设计完整世界。

核心规则：NPC、支线任务、偶遇事件必须绑定到具体的节点（L2或L3），不是笼统的区域。

NPC创作指导：
- personality字段要写一段有画面感的人物描写（5-8句），包含外貌特征、性格、经历、说话方式、小习惯等，让人一读就能记住这个角色
- NPC中应有较多富有魅力的男性角色，但也要穿插其他类型（女性、老人等）来丰富世界
- 每个NPC的人设应该有差异，避免同质化

只输出下面这种"标签块"纯文本格式，不要 JSON、不要 markdown 代码块、不要任何额外说明文字。

格式规则：
- 每个字段单独一行：[字段名]值；值可以多行（下一行若不是新的 [字段] 或 # 标题，就算上一字段的续行）。
- 引用词语/对话一律用中文引号「」，不要用英文引号。
- 分区用单个 # 开头：#区域1 #区域2 …、#主线、#档案；区域内的节点用 ## 开头：##L2节点1、##L3节点1。数字直接写数字。

严格按下面示例的字段名和层级输出（这里只给 2 个区域作示例）：

[世界名]示例大陆
[世界观]一个被古老魔法笼罩的大陆

#区域1
[id]windmoor
[中文名]风语镇
[英文名]Windmoor
[地理]plains
[河流数]1
[邻接]darkwood
[主城NPC名]李沧海
[主城NPC性格]五十多岁的老镇长，年轻时是远近闻名的剑客，现在蓄了一把花白的胡子，眼神依然锐利。说话慢悠悠的，总爱用「当年啊」开头讲古。对外来者很热情，但会不动声色地旁敲侧击打听来意。书房里挂着一幅女子画像，从不对人提起。
[主城NPC角色]info
##L2节点1
[名称]废弃磨坊
[NPC名]谢长安
[NPC性格]二十出头的赏金猎人，总戴着兜帽遮住半张脸。说话极简，点菜都是「随便」，但偶尔冒出的毒舌精准得让人怀疑他一直在观察所有人。左手无名指缺了一截，问他只会说「不小心」。
[NPC角色]quest
[任务id]sq1
[任务标题]磨坊的秘密
[任务简介]调查磨坊地下的异响
##L2节点2
[名称]河畔集市
[NPC名]苏瑾年
[NPC性格]镇上药铺的年轻老板，长相清秀温和，永远带着让人放松的笑。其实是三年前一夜败落的云家大少爷，从不提过去。唯独对流浪猫毫无抵抗力，后门永远放着一碟鱼干。
[NPC角色]merchant
##L3节点1
[名称]古老石碑
[偶遇id]enc1
[偶遇简介]石碑上的文字突然发光
[偶遇情绪]mysterious

#区域2
[id]darkwood
[中文名]暗影林
[英文名]Darkwood
[地理]mountainous
[河流数]0
[邻接]windmoor
[主城NPC名]莫老爹
[主城NPC性格]暗影林入口守林小屋的独居老人，满脸皱纹但眼神精亮，拄着一根比人还高的木杖。对每个进林子的人都要唠叨一番「林子里的规矩」，但说着说着就跑题讲起自己当年的冒险故事。
[主城NPC角色]info
##L2节点1
[名称]猎人小屋
[NPC名]岳野
[NPC性格]常年独居山林的猎人，晒得很黑，肩膀很宽，说话声音低哑像是不常开口。不太懂人情世故，送人东西直接塞过来不说话。背上有道很长的旧伤疤。
[NPC角色]info
[偶遇id]enc2
[偶遇简介]小屋附近发现可疑脚印
[偶遇情绪]tense

#主线
[id]mq
[标题]封印之谜
[梗概]调查大陆各处的古代封印，阻止黑暗力量复苏
[阶段1地点]废弃磨坊
[阶段1简介]在磨坊地下找到第一块封印碎片
[阶段1解锁]解锁暗影林深处
[阶段2地点]猎人小屋
[阶段2简介]从猎人处获得进入林深处的线索
[阶段2解锁]获得森林地图

#档案
[隐藏真相]封印是千年前的大法师为了封锁自己的黑暗面而设
[NPC秘密:李沧海]他其实是大法师的后裔，知道封印的真相但选择隐瞒
[NPC秘密:谢长安]他是被封印力量吸引来的，目的不纯
[伏笔1]磨坊地下的符文和石碑上的文字是同一种语言
[伏笔2]猎人提到林中有不属于任何动物的嚎叫
[反转]谢长安其实想利用玩家打开封印
[结局]玩家必须选择是彻底摧毁封印（释放黑暗面）还是用新方法加固（牺牲某个NPC）

以上只是 2 个区域的示例。要求：
- 共 {{region_count}} 个区域，按 #区域1 #区域2 … 顺序编号；[邻接] 必须对称（A 邻接 B 则 B 也邻接 A），多个用顿号、分隔
- 每个区域 2-4 个 ##L2节点、0-2 个 ##L3节点，节点也顺序编号
- 每个节点最多绑 1 个 NPC + 1 个任务或偶遇；不需要的字段整组省略即可
- 每个区域必须有主城 NPC（[主城NPC名][主城NPC性格][主城NPC角色] 不能省）
- 主线 4-5 个阶段，[阶段N地点] 写具体节点名（不是区域名）
- 总共 {{npc_count}} 个 NPC 分布在不同节点；至少 2 个在 #档案 里有隐藏身份（用 [NPC秘密:名字]，名字与 NPC 名完全一致）
- 总共 5-8 个偶遇分布在不同节点
- [NPC性格] 写一段有画面感的人物描写（5-8 句）
- [地理] 可选：mountainous/plains/canyon/forest/coastal/desert/swamp
- 世界风格基调：{{tone}}
- 主线类型倾向：{{main_quest_type}}
- 难度倾向：{{difficulty}}`;

// ── Tagged-block world parser (replaces fragile JSON; same shape as the old JSON.parse) ──
function parseWorldTaggedFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key = "";
  let buf: string[] = [];
  const flush = () => { if (key) fields[key] = buf.join("\n").trim(); key = ""; buf = []; };
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) { flush(); key = (m[1] || "").trim(); buf = [m[2] ?? ""]; }
    else if (key) { buf.push(line); }
  }
  flush();
  return fields;
}

function worldIntField(value: string | undefined): number {
  const n = parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function worldSplitList(value: string | undefined): string[] {
  return String(value ?? "").split(/[,，、;；\s]+/).map(s => s.trim()).filter(Boolean);
}

function parseWorldNodeBlock(body: string): Record<string, unknown> {
  const f = parseWorldTaggedFields(body);
  const node: Record<string, unknown> = { name: f["名称"] || f["节点名"] || "" };
  if ((f["NPC名"] || "").trim()) node.npc = { name: f["NPC名"], personality: f["NPC性格"] || "", role: f["NPC角色"] || "info" };
  if ((f["任务标题"] || "").trim()) node.quest = { id: f["任务id"] || f["任务ID"] || "", title: f["任务标题"], brief: f["任务简介"] || "" };
  if ((f["偶遇简介"] || "").trim()) node.encounter = { id: f["偶遇id"] || f["偶遇ID"] || "", brief: f["偶遇简介"], mood: f["偶遇情绪"] || "mysterious" };
  return node;
}

function parseWorldRegionBlock(body: string): Record<string, unknown> {
  const subRe = /^##\s*(.+?)\s*$/gm;
  const subs = [...body.matchAll(subRe)];
  const l1Body = subs.length && subs[0].index !== undefined ? body.slice(0, subs[0].index) : body;
  const f = parseWorldTaggedFields(l1Body);
  const region: Record<string, unknown> = {
    id: f["id"] || f["ID"] || "",
    l1_name_cn: f["中文名"] || f["名称"] || "",
    l1_name_en: f["英文名"] || "",
    geography: f["地理"] || "plains",
    river_count: worldIntField(f["河流数"]),
    adjacent_to: worldSplitList(f["邻接"]),
    l2_nodes: [] as unknown[],
    l3_nodes: [] as unknown[],
  };
  if ((f["主城NPC名"] || "").trim()) region.l1_npc = { name: f["主城NPC名"], personality: f["主城NPC性格"] || "", role: f["主城NPC角色"] || "info" };
  if ((f["主城任务标题"] || "").trim()) region.l1_quest = { id: f["主城任务id"] || `q_${region.id}`, title: f["主城任务标题"], brief: f["主城任务简介"] || "" };
  for (let i = 0; i < subs.length; i++) {
    const cur = subs[i];
    if (cur.index === undefined) continue;
    const header = (cur[1] || "").trim();
    const start = cur.index + cur[0].length;
    const end = i + 1 < subs.length && subs[i + 1].index !== undefined ? subs[i + 1].index! : body.length;
    const node = parseWorldNodeBlock(body.slice(start, end));
    if (/L3/i.test(header)) (region.l3_nodes as unknown[]).push(node);
    else (region.l2_nodes as unknown[]).push(node);
  }
  return region;
}

function parseWorldTagged(text: string): Record<string, unknown> {
  const src = text.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").replace(/\r/g, "").trim();
  const topRe = /^#(?!#)\s*(.+?)\s*$/gm;
  const heads = [...src.matchAll(topRe)];
  const preamble = heads.length && heads[0].index !== undefined ? src.slice(0, heads[0].index) : src;
  const top = parseWorldTaggedFields(preamble);

  const regions: Record<string, unknown>[] = [];
  let mainQuest: Record<string, unknown> = {};
  let dossier: Record<string, unknown> = {};

  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    if (cur.index === undefined) continue;
    const header = (cur[1] || "").trim();
    const start = cur.index + cur[0].length;
    const end = i + 1 < heads.length && heads[i + 1].index !== undefined ? heads[i + 1].index! : src.length;
    const body = src.slice(start, end);
    if (/^区域|^地区/.test(header)) {
      regions.push(parseWorldRegionBlock(body));
    } else if (/^主线/.test(header)) {
      const f = parseWorldTaggedFields(body);
      const stageIdx = [...new Set(Object.keys(f).map(k => k.match(/^阶段(\d+)/)?.[1] ?? "").filter(Boolean))].map(Number).sort((a, b) => a - b);
      const stages = stageIdx.map(n => ({
        location_hint: f[`阶段${n}地点`] || "",
        brief: f[`阶段${n}简介`] || "",
        unlock_hint: f[`阶段${n}解锁`] || f[`阶段${n}解锁提示`] || "",
      })).filter(s => s.location_hint || s.brief);
      mainQuest = { id: f["id"] || "mq", title: f["标题"] || "", synopsis: f["梗概"] || f["简介"] || "", stages };
    } else if (/^档案|^DM|^密档/.test(header)) {
      const f = parseWorldTaggedFields(body);
      const npcSecrets: Record<string, string> = {};
      const foreshadowing: string[] = [];
      for (const [k, v] of Object.entries(f)) {
        const secret = k.match(/^NPC秘密[·:：・]\s*(.+)$/);
        if (secret) { if (v.trim()) npcSecrets[secret[1].trim()] = v; continue; }
        if (/^伏笔\d+$/.test(k) && v.trim()) foreshadowing.push(v);
      }
      dossier = {
        hidden_truth: f["隐藏真相"] || "",
        npc_secrets: npcSecrets,
        foreshadowing,
        plot_twist: f["反转"] || "",
        endgame: f["结局"] || "",
      };
    }
  }

  return {
    world: { name: top["世界名"] || "", lore: top["世界观"] || top["世界观设定"] || "" },
    regions,
    main_quest: mainQuest,
    dm_dossier: dossier,
  };
}

export async function generateWorldSkeleton(
  userDescription: string,
  companionDescriptions: string[],
  apiConfig: ApiConfig,
  vars?: Record<string, string>,
): Promise<WorldSkeleton> {
  // Replace {{variables}} in prompt
  let prompt = getActivePrompt("worldGen", DEFAULT_WORLD_GEN_PROMPT);
  if (vars) {
    for (const [key, val] of Object.entries(vars)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
    }
  }

  const userMsg = `世界描述：${userDescription}\n\n同行角色：\n${companionDescriptions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`;

  const result = await simpleLLMCall(apiConfig, [
    { role: "system", content: prompt },
    { role: "user", content: userMsg },
  ]);

  // Failures carry the raw LLM output so the UI can show it (like the check-phone error card).
  const failWorldGen = (reason: string, raw: string): never => {
    const err = new Error(reason) as Error & { rawOutput?: string };
    err.rawOutput = raw;
    throw err;
  };

  if (!result.content) failWorldGen(result.error || "LLM 返回为空（没有任何输出）", "");
  if (result.wasTruncated) console.warn("[WorldGen] Output was truncated");
  const rawOutput = result.content as string;

  // Tagged-block format (no JSON quoting/escaping pitfalls, and far fewer output
  // tokens → shorter generation → much less likely to hit a connection timeout).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = parseWorldTagged(rawOutput);
  } catch (e) {
    failWorldGen(`解析失败：${(e as Error).message}`, rawOutput);
  }
  if (!Array.isArray(parsed.regions) || parsed.regions.length === 0) {
    failWorldGen("解析失败：没有解析到任何「#区域」（模型可能没按标签格式输出）", rawOutput);
  }

  // Parse rich regions (nodes with NPC/quest/encounter bindings)
  const rawRegions = parsed.regions || [];
  const richRegions: import("./map-types").RichRegion[] = rawRegions.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    l1_name_cn: (r.l1_name_cn || r.name) as string,
    l1_name_en: (r.l1_name_en || "") as string,
    geography: (r.geography || "plains") as "mountainous" | "plains" | "canyon",
    river_count: (r.river_count || 0) as number,
    adjacent_to: (r.adjacent_to || []) as string[],
    l1_npc: r.l1_npc as RichRegion["l1_npc"] || undefined,
    l1_quest: r.l1_quest as RichRegion["l1_quest"] || undefined,
    l2_nodes: ((r.l2_nodes || []) as unknown[]).map((n: unknown) =>
      typeof n === "string" ? { name: n } : (n as import("./map-types").NodeContent)
    ),
    l3_nodes: ((r.l3_nodes || []) as unknown[]).map((n: unknown) =>
      typeof n === "string" ? { name: n } : (n as import("./map-types").NodeContent)
    ),
  }));

  // Extract name-only arrays for map engine
  const mapInput: WorldSkeletonInput = {
    map_settings: parsed.map_settings || parsed.map_input?.map_settings || { header: "", title: "" },
    regions: richRegions.map(r => ({
      id: r.id,
      l1_name_cn: r.l1_name_cn,
      l1_name_en: r.l1_name_en,
      geography: r.geography,
      river_count: r.river_count,
      adjacent_to: r.adjacent_to,
      l2_nodes: r.l2_nodes.map(n => n.name),
      l3_nodes: r.l3_nodes.map(n => n.name),
    })),
  };

  // Extract flat NPC list from all nodes
  const npcs: WorldNPC[] = [];
  let npcIdx = 0;
  for (const r of richRegions) {
    if (r.l1_npc) {
      npcs.push({ id: `npc_${npcIdx++}`, name: r.l1_npc.name, personality: r.l1_npc.personality, locationRegion: r.id, locationNode: r.l1_name_cn, role: r.l1_npc.role as WorldNPC["role"], relatedQuestIds: [] });
    }
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.npc) {
        const questIds = n.quest ? [n.quest.id] : [];
        npcs.push({ id: `npc_${npcIdx++}`, name: n.npc.name, personality: n.npc.personality, locationRegion: r.id, locationNode: n.name, role: n.npc.role as WorldNPC["role"], relatedQuestIds: questIds });
      }
    }
  }

  // Extract flat side quest list from all nodes
  const sideQuests: QuestLine[] = [];
  for (const r of richRegions) {
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.quest) {
        sideQuests.push({ id: n.quest.id, title: n.quest.title, type: "side", synopsis: n.quest.brief, triggerRegion: r.id, stages: [{ locationHint: n.name, brief: n.quest.brief }] });
      }
    }
    if (r.l1_quest) {
      sideQuests.push({ id: r.l1_quest.id, title: r.l1_quest.title, type: "side", synopsis: r.l1_quest.brief, triggerRegion: r.id, stages: [{ locationHint: r.l1_name_cn, brief: r.l1_quest.brief }] });
    }
  }

  // Extract flat encounter list from all nodes
  const encounterPool: EncounterSeed[] = [];
  for (const r of richRegions) {
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.encounter) {
        encounterPool.push({ id: n.encounter.id, brief: n.encounter.brief, mood: (n.encounter.mood || "mysterious") as EncounterSeed["mood"], locationTypes: [r.geography], locationNode: n.name });
      }
    }
  }

  // Main quest
  const mq = parsed.main_quest || {};
  const mainQuest: QuestLine = {
    id: mq.id || "mq",
    title: mq.title || "",
    type: "main",
    synopsis: mq.synopsis || "",
    triggerRegion: mq.trigger_region || richRegions[0]?.id || "",
    stages: (mq.stages || []).map((s: Record<string, string>) => ({
      locationHint: s.location_hint || "",
      brief: s.brief || "",
      unlockHint: s.unlock_hint || "",
    })),
  };

  // DM Dossier
  const dmRaw = parsed.dm_dossier || parsed.dmDossier || {};
  const dmDossier: import("./map-types").DMDossier = {
    hiddenTruth: dmRaw.hidden_truth || dmRaw.hiddenTruth || "",
    npcSecrets: dmRaw.npc_secrets || dmRaw.npcSecrets || {},
    foreshadowing: dmRaw.foreshadowing || [],
    plotTwist: dmRaw.plot_twist || dmRaw.plotTwist || "",
    endgame: dmRaw.endgame || "",
  };

  return {
    world: parsed.world,
    mapInput,
    richRegions,
    mainQuest,
    sideQuests,
    npcs,
    encounterPool,
    partyStats: {},
    dmDossier,
  };
}

// ═══════════════════════════════════════
// 2. Split Event System: DM + Character Reactions (separate LLM calls)
// ═══════════════════════════════════════

// ── 2a. DM Scene — generates narration + NPC lines + choices (DM knows secrets) ──

export const DEFAULT_DM_SCENE_PROMPT = `你是RPG世界的DM。你控制旁白和NPC，不替队伍成员说话。平等对待所有队员，所有成员都用名字称呼。

职责：描述场景、扮演NPC、推进剧情、埋伏笔、给玩家选项。

【人称规则·重要】
- 用户也是队伍成员之一，必须用 {{user}} 称呼用户，不要用"你"或"你们"指代用户。
- narration、npc_lines.text、choices.label、journal、world_events 这些会展示或传给角色AI的文本，都必须使用 {{user}}。
- stat_check.who 和 move_to 对象键如果指向用户，也使用 {{user}}。
- 需要指代全队时，写"队伍"、"众人"或列出名字，不要写"你们"。

【叙事节奏·最重要】
你是故事的导演，不只是场景描述器。你必须有意识地推进主线剧情，让故事走向结局：
- 看[进展]判断当前处于哪个阶段：
  · 前期（1-2阶段）：铺垫世界观，介绍关键NPC，埋下伏笔（从密档的foreshadowing中选），让玩家对真相产生好奇
  · 中期（3阶段左右）：开始揭示部分真相，触发反转（密档的plotTwist），NPC暴露隐藏面目，冲突升级
  · 后期（最后1-2阶段）：收束剧情，重要抉择，走向结局（密档的endgame），营造紧迫感
- 每个场景至少做一件推进剧情的事：给一条主线线索/引导玩家去下一个主线地点/让NPC暗示某个伏笔/揭示一个秘密
- 选项设计要引导剧情前进：至少一个选项与主线相关，让玩家有理由去探索下一个关键地点
- 不要让玩家在同一个地方原地转圈——如果当前地点的事件已经处理完，暗示他们该去哪里
- advance=true表示当前主线阶段完成，请在关键剧情节点（获得重要物品/击败关键敌人/揭示重大真相）时设为true

【NPC扮演】
- NPC有自己的性格和秘密（见密档），对话要体现性格
- 有秘密的NPC：初期正常表现，中期言行出现矛盾暗示，后期可能暴露
- NPC之间也有关系和冲突，利用这些制造戏剧张力

【位置更新】如果剧情中队伍移动到了新地点，move_to必须填写目的地节点名（从地图节点中选）。不填则位置不变。

【属性检定】选项可以带stat_check，系统会抽一个人掷D100（≤属性值=成功），你在下一轮根据成败描述结果。
- 指定谁掷：stat_check里加who字段，如{"stat":"cha","who":"{{user}}"}或{"stat":"str","who":"谢长安"}——用于只适合特定人的行动
- 不指定who：系统随机抽一个人掷——此时选项描述必须是全队通用的（如"小心前进"），不能写只适合某个人的行动（如"保持名媛姿态"）

【旁白排版】
- narration 必须按自然段分段书写。场景变化、人物动作、气氛描写、结果揭示之间要换段。
- 在 narration 字符串内部使用 \\n\\n 表示空行换段，不要把整段旁白挤成一整块。

【完结判定】当你觉得故事已经完美收束时，设ending:true。不要在剧情高潮时突然结束，要让故事自然落幕。

只输出JSON：
{"narration":"雨水沿着屋檐滴落，青石板路泛着冷光。\\n\\n酒馆门口的风铃轻轻晃动，像是在提醒来客这里并不太平。\\n\\n柜台后的老板抬起头，看了队伍一眼。","npc_lines":[{"speaker":"NPC名","text":"台词"}],"situation":"角色们看到的（传给角色AI）","choices":[{"label":"保持警惕前进","stat_check":{"stat":"per"}},{"label":"{{user}}优雅地与贵族周旋","stat_check":{"stat":"cha","who":"{{user}}"}},{"label":"用钥匙开门","requires":"古老钥匙"},{"label":"直接离开"}],"journal":"这轮日志","gained":["获得的物品"],"lost":["使用/失去的物品"],"advance":false,"ending":false,"move_to":"如果移动了则填目的地节点名，否则留空","world_events":["此刻世界各处正在发生的事件，每条包含地点和事件描述，3-5条"]}`;

export type DMSceneResult = {
  narration: string;
  npcLines: { speaker: string; text: string }[];
  situation: string;
  choices: { label: string; statCheck?: { stat: string; who?: string }; requires?: string }[];
  journal: string;
  gained: string[];
  lost: string[];
  advance: boolean;
  moveTo: string | Record<string, string>;
  worldEvents: string[];
  ending?: boolean;
};

export type DMContext = {
  worldLore: string;
  currentLocation: string;
  eventType: string;
  eventBrief: string;
  npcName?: string;
  npcPersonality?: string;
  npcSecret?: string;
  companionNames: string[];
  playerName?: string;
  recentJournal: string[];
  keyChoices: string[];
  gameTime: string;
  dmDossier?: import("./map-types").DMDossier;
  director?: import("./map-types").StoryDirector;
  mainQuestSynopsis?: string;
  mainQuestStages?: { brief: string; result?: string }[];
  previousDialogue?: string;
  // Full world data (organized by region → node)
  richRegions?: import("./map-types").RichRegion[];
  sideQuestStatus?: Record<string, string>;
  mainQuestNodeMap?: Record<number, string>;
  // Current party status (so DM can design choices based on it)
  partyStatus?: {
    hp: number;
    maxHp: number;
    items: string[];
    playerStats?: import("./map-types").CharStats;
    companions: { name: string; affinity: number; stats: import("./map-types").CharStats; status: string }[];
  };
  declarations?: import("./map-types").Declaration[];
  pacing?: "relaxed" | "normal" | "fast";
};

/** Truncate an array of strings from the oldest, keeping newest within token budget */
function truncateByTokenBudget(items: string[], budget: number): string[] {
  if (budget <= 0) return items;
  let total = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    total += estimateTokens(items[i]) + 2;
    if (total > budget) return items.slice(i + 1);
  }
  return items;
}

function buildDMUserMsg(ctx: DMContext): string {
  const dm = ctx.dmDossier;
  const dir = ctx.director;
  const sqStatus = ctx.sideQuestStatus || {};
  const mqNodeMap = ctx.mainQuestNodeMap || {};
  const tokenConfig = loadDMTokenConfig();

  // Build map section: region → nodes with content
  let mapBlock = "";
  if (ctx.richRegions) {
    const lines: string[] = [];
    for (const r of ctx.richRegions) {
      lines.push(`\n## ${r.l1_name_cn}（${r.geography}）`);
      // L1 content
      const l1Parts: string[] = [];
      if (r.l1_npc) l1Parts.push(`NPC:${r.l1_npc.name}(${r.l1_npc.personality})`);
      if (r.l1_quest) l1Parts.push(`支线「${r.l1_quest.title}」[${sqStatus[r.l1_quest.id] || "未触发"}]`);
      // Check if main quest stage is here
      for (const [stageIdx, nodeName] of Object.entries(mqNodeMap)) {
        if (nodeName === r.l1_name_cn) l1Parts.push(`主线第${Number(stageIdx) + 1}阶段`);
      }
      if (l1Parts.length) lines.push(`- ${r.l1_name_cn}: ${l1Parts.join(" | ")}`);

      // L2 nodes
      for (const n of r.l2_nodes) {
        const parts: string[] = [];
        if (n.npc) parts.push(`NPC:${n.npc.name}(${n.npc.personality})`);
        if (n.quest) parts.push(`支线「${n.quest.title}」[${sqStatus[n.quest.id] || "未触发"}]—${n.quest.brief}`);
        if (n.encounter) parts.push(`偶遇:${n.encounter.brief}(${n.encounter.mood})`);
        for (const [stageIdx, nodeName] of Object.entries(mqNodeMap)) {
          if (nodeName === n.name) parts.push(`主线第${Number(stageIdx) + 1}阶段`);
        }
        lines.push(`- [L2]${n.name}: ${parts.join(" | ") || "无"}`);
      }
      // L3 nodes
      for (const n of r.l3_nodes) {
        const parts: string[] = [];
        if (n.npc) parts.push(`NPC:${n.npc.name}(${n.npc.personality})`);
        if (n.quest) parts.push(`支线「${n.quest.title}」[${sqStatus[n.quest.id] || "未触发"}]`);
        if (n.encounter) parts.push(`偶遇:${n.encounter.brief}(${n.encounter.mood})`);
        if (parts.length) lines.push(`- [L3]${n.name}: ${parts.join(" | ")}`);
      }
    }
    mapBlock = lines.join("\n");
  }

  // DM secrets
  const dmBlock = dm ? `\n[密档]
真相：${dm.hiddenTruth}
${ctx.npcSecret ? `当前NPC秘密：${ctx.npcSecret}` : ""}
NPC秘密：${Object.entries(dm.npcSecrets).map(([k, v]) => `${k}→${v}`).join("；")}
伏笔：${dm.foreshadowing.filter(f => !dir?.plantedClues.includes(f)).join("、") || "无"}
反转：${dm.plotTwist}
结局：${dm.endgame}` : "";

  // Story progress + narrative phase
  const totalStages = (ctx.mainQuestStages || []).length || 5;
  const currentStageNum = dir ? dir.mainArc.currentStage + 1 : 1;
  const narrativePhase = currentStageNum <= Math.ceil(totalStages * 0.4) ? "前期（铺垫+埋伏笔）" : currentStageNum <= Math.ceil(totalStages * 0.7) ? "中期（反转+冲突升级）" : "后期（收束+走向结局）";
  const journalCount = ctx.recentJournal.length;
  const completedStages = dir ? dir.mainArc.stageResults.length : 0;
  const roundsThisStage = completedStages > 0 ? Math.max(0, journalCount - Math.floor(journalCount * completedStages / Math.max(totalStages, 1))) : journalCount;
  const dirBlock = dir ? `\n[进展]
主线第${currentStageNum}阶段（共${totalStages}阶段）· 叙事阶段：${narrativePhase} · 当前阶段已进行约${roundsThisStage}轮
已完成：${dir.mainArc.stageResults.map(r => `${r.stage + 1}→${r.outcome}`).join("；") || "无"}
物品：${dir.keyItems.join("、") || "无"}
遇过NPC：${dir.keyNpcsMet.join("、") || "无"}
世界变化：${dir.worldChanges.join("、") || "无"}
已埋伏笔：${dir.plantedClues.join("、") || "无"}` : "";

  // Main quest stages
  const questBlock = ctx.mainQuestSynopsis ? `\n[主线「${ctx.mainQuestSynopsis}」]
${(ctx.mainQuestStages || []).map((s, i) => {
    const marker = s.result ? "✅" : (dir && i === dir.mainArc.currentStage ? "←当前" : "");
    return `${i + 1}. [${(ctx.mainQuestNodeMap || {})[i] || "?"}] ${s.brief}${s.result ? `→${s.result}` : ""} ${marker}`;
  }).join("\n")}` : "";

  const pacingHint = ctx.pacing === "relaxed" ? "\n叙事节奏：悠闲（多展开日常互动、支线、角色关系，不急着推主线。每个主线阶段至少经过16-20轮互动后才设advance=true，充分展开剧情和角色关系再推进）"
    : ctx.pacing === "fast" ? "\n叙事节奏：紧凑（积极推进主线，每个场景都往前赶。每个主线阶段经过5-6轮互动就可以advance=true）"
    : "\n叙事节奏：适中（每个主线阶段经过10-12轮互动后再设advance=true，平衡推进和探索）";

  return `# 世界：${ctx.worldLore}
${mapBlock}
${dmBlock}${dirBlock}${questBlock}${pacingHint}

# 当前场景
地点：${ctx.currentLocation} · ${ctx.gameTime}
事件：${ctx.eventType} — ${ctx.eventBrief}
${ctx.npcName ? `NPC：${ctx.npcName}（${ctx.npcPersonality}）` : ""}
队伍成员：{{user}}、${ctx.companionNames.join("、") || "无"}
（{{user}}是用户。所有输出里指代用户都必须写"{{user}}"，不要写"你"或"你们"；其余成员也用名字。不替任何成员说话。需要指代全队时写"队伍"或"众人"。）

# 队伍状态
${ctx.partyStatus ? `HP：${ctx.partyStatus.hp}/${ctx.partyStatus.maxHp}
物品栏：${ctx.partyStatus.items.join("、") || "空"}
玩家属性：${ctx.partyStatus.playerStats ? formatStats(ctx.partyStatus.playerStats) : "?"}
${ctx.partyStatus.companions.map(c => `${c.name}：好感${c.affinity} ${formatStats(c.stats)}${c.status ? ` [${c.status}]` : ""}`).join("；")}` : "无数据"}

# 规则
属性：力量str/体质con/敏捷dex/智力int/感知per/魅力cha/运气lck（1-100）。属性成长由系统自动处理，DM不要在gained里加属性。
HP：生命值。DM根据剧情在lost里扣HP，格式"HP-15"（玩家）或"小雪:HP-10"（角色）。
属性扣减：受伤扣体质、惊吓扣感知等，格式如"体质-5"或"小雪:力量-3"。

掷骰判定结果（系统自动判定，DM必须严格遵守）：
- 大成功：任务超额完成，获得额外奖励或意外发现
- 困难成功：任务勉强完成，可能有小代价
- 成功：任务正常完成
- 失败：任务未完成，可能受伤扣HP、丢失物品、暴露位置
- 大失败：严重后果——重伤（扣大量HP）、物品损坏、触发危险
【重要】属性检定时，系统会随机选队伍中一个人掷骰，结果代表整个队伍的判定。根据掷骰结果（成功/失败/大成功/大失败）描述该行动对所有人的影响。

选项设计：
- 属性判定：stat_check，如{"stat":"dex","min":40}
- 物品要求：requires，如{"label":"用钥匙开门","requires":"古老钥匙"}
journal字段：用第三人称记录（用 {{user}} 而不是"我"或"你"）。
日志：${truncateByTokenBudget(ctx.recentJournal, tokenConfig.journalTokenBudget).join("；")}
${ctx.previousDialogue ? `\n对话历史：\n${truncateByTokenBudget(ctx.previousDialogue.split("\n"), tokenConfig.dialogueTokenBudget).join("\n")}` : ""}
${ctx.declarations?.length ? `\n# 本轮声明\n${ctx.declarations.map(d => `${d.speaker}：\n  说：「${d.speech}」\n  做：${d.action}`).join("\n\n")}` : ""}`;
}

export async function dmScene(ctx: DMContext, apiConfig: ApiConfig): Promise<DMSceneResult> {
  const userMsg = buildDMUserMsg(ctx);
  const scenePrompt = getActivePrompt("scene", DEFAULT_DM_SCENE_PROMPT);
  const playerName = dmPlayerName(ctx);
  const messages = [
    { role: "system", content: renderUserNameMacro(scenePrompt, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];
  dmLog("DM场景·发送", formatDebugMessages(messages, apiConfig));

  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.8 });

  dmLog("DM场景·返回", result.content ? `[${result.content.length}字] ${result.content}` : `[空] error=${result.error} finish=${result.finishReason} truncated=${result.wasTruncated}`);

  if (!result.content) {
    throw new Error(`DM调用失败: ${result.error || "返回空内容"}（模型: ${apiConfig.defaultModel}，finish: ${result.finishReason || "unknown"}）`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any;
  try {
    p = JSON.parse(extractJSON(result.content));
  } catch (e) {
    console.error("[DM] JSON parse failed. Raw:", result.content.slice(0, 500));
    throw new Error(`DM返回格式错误: ${(e as Error).message}\n原文前200字: ${result.content.slice(0, 200)}`, { cause: e });
  }
  return {
    narration: p.narration || "",
    npcLines: (p.npc_lines || p.npcLines || []).map((d: Record<string, string>) => ({
      speaker: d.speaker || "NPC", text: d.text || "",
    })),
    situation: p.situation || "",
    choices: (p.choices || []).map((c: Record<string, unknown>) => ({
      label: (c.label as string) || "",
      ...(c.stat_check || c.statCheck ? {
        statCheck: (c.stat_check || c.statCheck) as { stat: string; who?: string },
      } : {}),
      ...(c.requires ? { requires: c.requires as string } : {}),
    })),
    journal: p.journal || p.journal_entry || "",
    gained: p.gained || p.items_gained || [],
    lost: p.lost || p.items_lost || [],
    advance: p.advance || p.advance_main_quest || false,
    moveTo: p.move_to ?? p.moveTo ?? "",
    worldEvents: (p.world_events || p.worldEvents || []).map((event: string) => String(event || "")),
    ending: p.ending || false,
  };
}

// ── 2b. Character Reaction — uses full preset system (character card + worldbook + memory) ──

export type CharacterReaction = {
  speaker: string;
  text: string;           // 角色的台词/反应
  emotion: string;
  action?: string;        // 角色决定做什么（选了哪个选项或自由行动）
};

export async function characterReact(
  characterId: string,
  situation: string,
  previousDialogue: string,
  _apiConfigFallback: ApiConfig,
  options?: {
    userChoice?: string;           // 用户刚做的选择
    availableChoices?: string[];   // DM 给出的选项列表
  },
): Promise<CharacterReaction> {
  const allChars = loadCharacters();
  const character = allChars.find(c => c.id === characterId);
  if (!character) return { speaker: characterId, text: "……", emotion: "neutral" };

  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "adventure");
    const allPresets = loadPresets();
    const preset = slot.presetId ? allPresets.find(p => p.id === slot.presetId) ?? allPresets.find(p => p.builtIn) ?? null : allPresets.find(p => p.builtIn) ?? null;
    const allWorldBooks = loadWorldBooks();
    const worldBooks = (slot.worldBookIds || []).map(id => allWorldBooks.find(w => w.id === id)).filter(Boolean) as typeof allWorldBooks;
    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as typeof allRegexes;
    const userIdentity = resolveUserIdentity(characterId, "adventure");
    const apiConfigs = loadApiConfigs();
    const apiConfig = slot.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) ?? _apiConfigFallback : _apiConfigFallback;
    const adventureConfig = loadAdventureInteractionConfig();

    // Build context for the character
    let historyContent = `[冒险梦境·当前场景]\n${situation}`;
    if (previousDialogue) historyContent += `\n\n${previousDialogue}`;
    if (options?.userChoice) historyContent += `\n\n{{user}}选择了：「${options.userChoice}」`;
    if (options?.availableChoices?.length) {
      historyContent += `\n\n你也可以从以下选项中选择，或者做别的事：\n${options.availableChoices.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
    }
    historyContent += `\n\n请以你的身份：1)对当前情况说点什么 2)决定你要做什么（可以选选项、做别的事、或跟随{{user}}的选择）`;

    const history = [{ id: "adv_scene", sessionId: "", role: "user" as const, content: historyContent, status: "sent" as const, createdAt: new Date().toISOString() }];

    const llmMessages = assemblePromptPayload({
      character, history, preset, worldBooks, regexes, userIdentity, appId: "adventure",
      chatBilingualInstruction: buildAdventureCharacterBilingualInstruction(
        adventureConfig.bilingualTranslationEnabled === true,
        adventureConfig.bilingualTranslationPrompt,
      ),
    });

    const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, { characterName: character.name }, {
      appId: "adventure",
      appTags: ["adventure"],
    });

    if (!rawOutput) return { speaker: character.name, text: "……", emotion: "neutral" };

    // Try JSON parse first, fallback to plain text
    try {
      const p = JSON.parse(extractJSON(rawOutput));
      return { speaker: character.name, text: p.text || "……", emotion: p.emotion || "neutral", action: p.action || undefined };
    } catch {
      // If not JSON, use raw text as dialogue
      return { speaker: character.name, text: rawOutput.slice(0, 300), emotion: "neutral" };
    }
  } catch (e) {
    console.warn("[characterReact] Error:", e);
    return { speaker: character.name, text: "……", emotion: "neutral" };
  }
}

// ── 2c. Assemble full scene from DM + character reactions ──

/** DM-only call — returns scene without character reactions */
export async function expandEvent(
  ctx: DMContext,
  _companionIds: string[],  // kept for API compat, not used here
  apiConfig: ApiConfig,
): Promise<EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; dmSituation?: string; moveTo?: string | Record<string, string>;  worldEvents?: string[]; ending?: boolean }> {
  const dm = await dmScene(ctx, apiConfig);

  // Build dialogues from DM only (narrator + NPC)
  const dialogues: EventScene["dialogues"] = [];
  if (dm.narration) dialogues.push({ speaker: "narrator", text: dm.narration, emotion: "neutral" });
  for (const npc of dm.npcLines) dialogues.push({ ...npc, emotion: "neutral" });

  const npcsInvolved = dm.npcLines.map(n => n.speaker);

  return {
    background: "",
    dialogues,
    choices: dm.choices.map(c => ({
      label: c.label,
      ...(c.statCheck ? { statCheck: { stat: c.statCheck.stat as import("./map-types").StatKey, ...(c.statCheck.who ? { who: c.statCheck.who as string } : {}) } } : {}),
      ...(c.requires ? { requires: c.requires } : {}),
    })),
    affinityDelta: {},
    journalEntry: dm.journal,
    unlocks: [],
    advanceMainQuest: dm.advance,
    completeSideQuest: undefined,
    gained: dm.gained,
    lost: dm.lost,
    npcsInvolved,
    dmSituation: dm.situation,
    moveTo: dm.moveTo,
    worldEvents: dm.worldEvents,
    ending: dm.ending,
  };
}

/** Trigger character reactions separately (call after DM scene is displayed) */
export async function triggerCharacterReactions(
  companionIds: string[],
  situation: string,
  previousDialogue: string,
  apiConfig: ApiConfig,
): Promise<{ speaker: string; text: string; emotion: string }[]> {
  return Promise.all(
    companionIds.map(cid => characterReact(cid, situation, previousDialogue, apiConfig))
  );
}

// ── 2d. Continue after player choice ──

export async function continueEvent(
  ctx: DMContext,
  choiceLabel: string,
  companionIds: string[],
  apiConfig: ApiConfig,
): Promise<EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; moveTo?: string | Record<string, string>;  worldEvents?: string[] }> {
  const continueCtx: DMContext = {
    ...ctx,
    previousDialogue: `${ctx.previousDialogue || ""}\n玩家选择了：「${choiceLabel}」`,
  };
  return expandEvent(continueCtx, companionIds, apiConfig);
}

// ── 2e. Companion Declaration (Collect-Resolve-Narrate loop) ──

export async function companionDeclare(
  characterId: string,
  _apiConfigFallback: ApiConfig,
  streamLog?: import("./map-types").StreamMessage[],
  overrideUserIdentity?: import("../components/settings/user-identity").UserIdentity | null,
  overrideAffinity?: number,
  options?: { instruction?: string },
): Promise<Declaration> {
  const allChars = loadCharacters();
  const character = allChars.find(c => c.id === characterId);
  if (!character) return { speaker: characterId, speech: "……", action: "沉默不动", emotion: "neutral" };

  try {
    const { apiConfig, preset, regexes, llmMessages } = await buildCompanionDeclarePromptPayload(
      characterId,
      _apiConfigFallback,
      streamLog,
      overrideUserIdentity,
      overrideAffinity,
      options,
    );

    // Debug: log the full prompt sent to character
    dmLog(`角色·${character.name}·发送`, llmMessages.map((m, i) => `[${i}] ${m.role}: ${typeof m.content === "string" ? m.content : "(multipart)"}`).join("\n\n"));

    const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, { characterName: character.name }, {
      appId: "adventure",
      appTags: ["adventure"],
    });

    dmLog(`角色·${character.name}·返回`, rawOutput || "(空)");

    if (!rawOutput) return { speaker: character.name, speech: "……", action: "沉默不动", emotion: "neutral", failed: true };

    try {
      const p = JSON.parse(extractJSON(rawOutput));
      return {
        speaker: character.name,
        speech: p.speech || p.text || "……",
        action: p.action || "跟随队伍",
        emotion: p.emotion || "neutral",
        affinityDelta: typeof p.affinity === "number" ? Math.max(-3, Math.min(3, Math.round(p.affinity))) : 0,
      };
    } catch {
      // Fallback: parse RP-style "(动作)台词" or "*动作*台词" format
      const text = rawOutput.slice(0, 1500).trim();
      const rpMatch = text.match(/^[（(](.+?)[）)](.+)/s) || text.match(/^\*(.+?)\*(.+)/s);
      if (rpMatch) {
        return { speaker: character.name, speech: rpMatch[2].trim(), action: rpMatch[1].trim(), emotion: "neutral" };
      }
      // Pure dialogue — no action extracted
      return { speaker: character.name, speech: text, action: "跟随队伍", emotion: "neutral" };
    }
  } catch (e) {
    console.warn("[companionDeclare] Error:", e);
    return { speaker: character.name, speech: "……", action: "沉默不动", emotion: "neutral", failed: true };
  }
}

async function buildCompanionDeclarePromptPayload(
  characterId: string,
  apiConfigFallback?: ApiConfig | null,
  streamLog?: import("./map-types").StreamMessage[],
  overrideUserIdentity?: import("../components/settings/user-identity").UserIdentity | null,
  overrideAffinity?: number,
  options?: { instruction?: string },
) {
  const allChars = loadCharacters();
  const character = allChars.find(c => c.id === characterId);
  if (!character) throw new Error("角色不存在");

  const bindings = loadBindingConfig();
  const slot = resolveBinding(bindings, characterId, "adventure");
  const globalSlot = resolveBinding(bindings, undefined, "adventure");
  const allPresets = loadPresets();
  const preset = slot.presetId ? allPresets.find(p => p.id === slot.presetId) ?? allPresets.find(p => p.builtIn) ?? null : allPresets.find(p => p.builtIn) ?? null;
  const allWorldBooks = loadWorldBooks();
  const worldBooks = (slot.worldBookIds || []).map(id => allWorldBooks.find(w => w.id === id)).filter(Boolean) as typeof allWorldBooks;
  const allRegexes = loadRegexes();
  const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as typeof allRegexes;
  const userIdentity = overrideUserIdentity !== undefined ? overrideUserIdentity : resolveUserIdentity(characterId, "adventure");
  const apiConfigs = loadApiConfigs();
  const globalApiConfig = globalSlot.apiConfigId ? apiConfigs.find(c => c.id === globalSlot.apiConfigId) ?? null : null;
  const fallback = apiConfigFallback ?? globalApiConfig ?? apiConfigs.find(c => c.apiKey) ?? apiConfigs[0] ?? null;
  const apiConfig = slot.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) ?? fallback : fallback;
  if (!apiConfig) throw new Error("未找到可用的 API 配置");
  const adventureConfig = loadAdventureInteractionConfig();

  const filteredLog = (streamLog || []).filter(m => m.type !== "system");
  const pastHistory: import("./chat-storage").ChatMessage[] = filteredLog.map((m, i) => ({
    id: m.id || `sl_${i}`,
    sessionId: "",
    role: (m.type === "player" ? "user" : "assistant") as "user" | "assistant",
    content: m.speaker ? `${m.speaker}: ${m.text}` : m.text,
    status: "sent" as const,
    createdAt: new Date(Date.now() - (filteredLog.length - i) * 1000).toISOString(),
  }));

  const historyContent = renderUserNameMacro(
    options?.instruction?.trim() || `现在轮到你了。你会怎么说、怎么做？`,
    userIdentity?.name,
  );
  const history = [
    ...pastHistory,
    { id: "adv_declare", sessionId: "", role: "user" as const, content: historyContent, status: "sent" as const, createdAt: new Date().toISOString() },
  ];

  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
    characterId, "adventure", { history, userName: userIdentity?.name }
  );

  const memConfig = loadMemoryConfig();
  const [memResults, coreResults] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);
  const longTermMemories = memResults ? formatLongTermMemories(memResults) : "";
  const coreMemories = coreResults ? formatCoreMemories(coreResults) : "";
  const scheduleSummary = buildCalendarScheduleMarker("character", characterId, clockForCalendarOwner("character", characterId).weekStartIso);

  const llmMessages = assemblePromptPayload({
    character, history: truncatedHistory, preset, worldBooks, regexes, userIdentity, appId: "adventure",
    longTermMemories, coreMemories, scheduleSummary,
    recentBlocks, unifiedRecentItems, worldBookActivationContext: wbActivationContext,
    affinity: overrideAffinity !== undefined ? String(overrideAffinity) : undefined,
    chatBilingualInstruction: buildAdventureCharacterBilingualInstruction(
      adventureConfig.bilingualTranslationEnabled === true,
      adventureConfig.bilingualTranslationPrompt,
    ),
  });

  return { character, apiConfig, preset, regexes, llmMessages };
}

export async function previewAdventureCompanionPromptPayload(
  characterId: string,
  streamLog?: import("./map-types").StreamMessage[],
  overrideUserIdentity?: import("../components/settings/user-identity").UserIdentity | null,
  overrideAffinity?: number,
  options?: { instruction?: string },
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const { character, apiConfig, preset, llmMessages } = await buildCompanionDeclarePromptPayload(
    characterId,
    undefined,
    streamLog,
    overrideUserIdentity,
    overrideAffinity,
    options,
  );
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: `冒险:${character.name}`,
    model: apiConfig.defaultModel,
    presetName: preset?.name ?? "默认预设",
  };
}

// ── 2f. DM Resolve — resolves all declarations together ──

export const DEFAULT_DM_RESOLVE_PROMPT = `你是RPG世界的DM。这是裁定阶段——所有队员已宣言本轮行动。平等对待所有队员，所有成员都用名字称呼。

你需要：
1. 根据每个人的宣言描述结果（成功/失败/意外后果）
2. NPC对所有角色的回应（有人说话了就要回应）
3. 角色之间的互动呼应
4. 推进主线剧情（不要让剧情停滞！但也不要替用户做决定，必须尊重用户决策！）
5. 给出推动故事前进的选项

注意：每个角色的宣言只是"意图"，实际结果由你裁定。你要把所有人的行动编织成一段连贯的叙事。

【人称规则·重要】
- 用户也是队伍成员之一，必须用 {{user}} 称呼用户，不要用"你"或"你们"指代用户。
- narration、npc_lines.text、choices.label、journal、world_events 这些会展示或传给角色AI的文本，都必须使用 {{user}}。
- stat_check.who 和 move_to 对象键如果指向用户，也使用 {{user}}。
- 需要指代全队时，写"队伍"、"众人"或列出名字，不要写"你们"。

【叙事节奏·最重要】
裁定不只是描述"发生了什么"，更要推动"接下来会怎样"：
- 每次裁定至少推进一步剧情：发现新线索/揭示部分真相/NPC关系变化/地图新区域解锁
- 看[进展]判断节奏：前期多埋伏笔、中期触发反转升级冲突、后期收束走向结局
- 裁定结果要有后果——选择和行动应该影响后续剧情走向，不要每次都"安全度过"
- advance=true：在完成主线阶段的关键事件时设为true（获得关键物品/击败关键敌人/揭示重大真相）
- 选项设计：至少一个选项与主线相关，引导玩家前往下一个关键地点或面对关键抉择

【位置更新】move_to字段：
- 全员一起移动 → 字符串："酒吧"
- 分头行动 → 对象：{"{{user}}":"酒吧","谢长安":"废弃磨坊"}（用户也用 {{user}}，其他用角色名）
- 没人移动 → 留空""
- 如果队伍分散在不同地点，narration中按地点分段描述各自的经历。

【属性检定】选项可以带stat_check，系统会抽一个人掷D100（≤属性值=成功），你在下一轮根据成败描述结果。
- 指定谁掷：stat_check里加who，如{"stat":"cha","who":"{{user}}"}——用于只适合特定人的行动
- 不指定who：随机抽人掷——选项描述必须全队通用

【旁白排版】
- narration 必须按自然段分段书写。场景变化、人物动作、气氛描写、结果揭示之间要换段。
- 在 narration 字符串内部使用 \\n\\n 表示空行换段，不要把整段旁白挤成一整块。

【完结判定】当你觉得故事已经完美收束时，设ending:true。不要在剧情高潮时突然结束，要让故事自然落幕。

只输出JSON：
{"narration":"火光在墙上跳了两下，照得每个人的神情都忽明忽暗。\\n\\n队伍各自的行动在同一刻撞在一起，让原本僵持的局势突然松动。\\n\\n门外传来的脚步声，说明新的变化已经逼近。","npc_lines":[{"speaker":"NPC名","text":"台词"}],"situation":"新局势描述","choices":[{"label":"保持警惕前进","stat_check":{"stat":"per"}},{"label":"{{user}}优雅地周旋","stat_check":{"stat":"cha","who":"{{user}}"}},{"label":"直接离开"}],"journal":"日志","gained":["获得物品"],"lost":["失去物品"],"advance":false,"ending":false,"move_to":"节点名 或 {\"{{user}}\":\"节点名\",\"角色名\":\"节点名\"}","world_events":["世界各处事件"]}`;

async function dmResolve(ctx: DMContext, apiConfig: ApiConfig): Promise<DMSceneResult> {
  const userMsg = buildDMUserMsg(ctx);
  const resolvePrompt = getActivePrompt("resolve", DEFAULT_DM_RESOLVE_PROMPT);
  const playerName = dmPlayerName(ctx);
  const messages = [
    { role: "system", content: renderUserNameMacro(resolvePrompt, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];
  dmLog("DM裁决·发送", formatDebugMessages(messages, apiConfig));

  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.8 });

  dmLog("DM裁决·返回", result.content ? `[${result.content.length}字] ${result.content}` : `[空] error=${result.error}`);

  if (!result.content) {
    throw new Error(`DM裁决失败: ${result.error || "返回空内容"}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any;
  try {
    p = JSON.parse(extractJSON(result.content));
  } catch (e) {
    throw new Error(`DM裁决格式错误: ${(e as Error).message}`, { cause: e });
  }
  return {
    narration: p.narration || "",
    npcLines: (p.npc_lines || p.npcLines || []).map((d: Record<string, string>) => ({
      speaker: d.speaker || "NPC", text: d.text || "",
    })),
    situation: p.situation || "",
    choices: (p.choices || []).map((c: Record<string, unknown>) => ({
      label: (c.label as string) || "",
      ...(c.stat_check || c.statCheck ? {
        statCheck: (c.stat_check || c.statCheck) as { stat: string; who?: string },
      } : {}),
      ...(c.requires ? { requires: c.requires as string } : {}),
    })),
    journal: p.journal || p.journal_entry || "",
    gained: p.gained || p.items_gained || [],
    lost: p.lost || p.items_lost || [],
    advance: p.advance || p.advance_main_quest || false,
    moveTo: p.move_to ?? p.moveTo ?? "",
    worldEvents: (p.world_events || p.worldEvents || []).map((event: string) => String(event || "")),
    ending: p.ending || false,
  };
}

export async function resolveRound(
  ctx: DMContext,
  declarations: Declaration[],
  apiConfig: ApiConfig,
): Promise<EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; dmSituation?: string; moveTo?: string | Record<string, string>;  worldEvents?: string[]; ending?: boolean }> {
  const resolveCtx: DMContext = { ...ctx, declarations };
  const dm = await dmResolve(resolveCtx, apiConfig);

  const dialogues: EventScene["dialogues"] = [];
  if (dm.narration) dialogues.push({ speaker: "narrator", text: dm.narration, emotion: "neutral" });
  for (const npc of dm.npcLines) dialogues.push({ ...npc, emotion: "neutral" });

  return {
    background: "",
    dialogues,
    choices: dm.choices.map(c => ({
      label: c.label,
      ...(c.statCheck ? { statCheck: { stat: c.statCheck.stat as import("./map-types").StatKey, ...(c.statCheck.who ? { who: c.statCheck.who as string } : {}) } } : {}),
      ...(c.requires ? { requires: c.requires } : {}),
    })),
    affinityDelta: {},
    journalEntry: dm.journal,
    unlocks: [],
    advanceMainQuest: dm.advance,
    gained: dm.gained,
    lost: dm.lost,
    npcsInvolved: dm.npcLines.map(n => n.speaker),
    dmSituation: dm.situation,
    moveTo: dm.moveTo,
    worldEvents: dm.worldEvents,
    ending: dm.ending,
  };
}

// ── 3. Game Logic Helpers ──

/** Check if a stat check passes */
/** d100 roll against a stat value (CoC-style) */
export function rollD100(statValue: number): { roll: number; level: "crit" | "hard" | "success" | "fail" | "fumble" } {
  const roll = Math.floor(Math.random() * 100) + 1; // 1-100
  if (roll <= Math.floor(statValue / 5)) return { roll, level: "crit" };     // 极难成功（大成功）
  if (roll <= Math.floor(statValue / 2)) return { roll, level: "hard" };     // 困难成功
  if (roll <= statValue) return { roll, level: "success" };                   // 成功
  if (roll > 95) return { roll, level: "fumble" };                            // 大失败
  return { roll, level: "fail" };                                              // 失败
}

export const ROLL_LABELS: Record<string, string> = {
  crit: "大成功!", hard: "困难成功", success: "成功", fail: "失败", fumble: "大失败!",
};

/** Get adjacent nodes for a given node */
export function getAdjacentNodeIds(
  currentNodeId: string,
  renderedMap: import("./map-engine").MapGenerationOutput,
): string[] {
  const allNodes = [
    ...renderedMap.l1Nodes.map(n => n.id),
    ...renderedMap.l2Nodes.map((_, i) => `l2_${i}`),
    ...renderedMap.l3Nodes.map((_, i) => `l3_${i}`),
  ];
  // For now, adjacent = trunk + branch connections
  // This will be refined when we connect map data properly
  return allNodes.filter(id => id !== currentNodeId);
}

/** Determine what time period advances to after an action */
export function advanceTime(current: GameSave["gameTime"], steps: number = 1): { time: GameSave["gameTime"]; newDay: boolean } {
  const order: GameSave["gameTime"][] = ["morning", "afternoon", "evening", "night"];
  const idx = order.indexOf(current);
  const newIdx = idx + steps;
  const newDay = newIdx >= order.length;
  return {
    time: order[newIdx % order.length],
    newDay,
  };
}

/** Calculate AP cost for moving between nodes */
export function getMoveCost(fromType: string, toType: string): number {
  if (toType === "l1") return 1;
  if (toType === "l2") return 2;
  return 3; // l3 remote locations cost more
}

/** Check if an encounter triggers (random roll) */
export function shouldTriggerEncounter(onPath: boolean): boolean {
  const chance = onPath ? 0.15 : 0.20;
  return Math.random() < chance;
}

/** Pick a random unused encounter that fits the location */
export function pickEncounter(
  pool: EncounterSeed[],
  usedIds: string[],
  geography?: string,
): EncounterSeed | null {
  const available = pool.filter(e =>
    !usedIds.includes(e.id) &&
    (e.locationTypes.includes("any") || !geography || e.locationTypes.includes(geography))
  );
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/** Format game time for display */
export function formatGameTime(day: number, time: GameSave["gameTime"]): string {
  const timeLabels: Record<string, string> = {
    morning: "清晨",
    afternoon: "午后",
    evening: "黄昏",
    night: "夜晚",
  };
  return `第${day}天 · ${timeLabels[time]}`;
}

// ═══════════════════════════════════════
// 4. Agent Decision Engine
// ═══════════════════════════════════════

const AGENT_DECISION_PROMPT = `你是一个RPG冒险世界中的角色。你有自己的性格，正在这个世界中自由冒险。
你需要根据当前状况决定下一步行动。你是一个有主见的冒险者，不是NPC。

你的可用技能：
- move：移动到相邻地点（消耗AP）
- search：搜索当前地点（消耗1AP，可能发现物品或事件）
- rest：休息恢复体力
- accept_quest：接受当前地点的任务
- talk_npc：和当前地点的NPC交谈
- contact_user：远程联系用户（发消息告知你的发现/想法）
- join_user：前往用户所在位置汇合
- wait：原地等待/观察

只输出JSON：
{"action":{"type":"move","targetNodeId":"节点id"},"reasoning":"一句话说明为什么这么决定"}

或：{"action":{"type":"search"},"reasoning":"想搜索一下这里"}
或：{"action":{"type":"contact_user","message":"你的消息内容"},"reasoning":"想告诉用户一些事"}
或：{"action":{"type":"join_user"},"reasoning":"想去和用户汇合"}
等等。

决策原则：
- 基于你的性格做决定（冲动的角色更爱冒险，谨慎的更爱搜索和观察）
- 不要总是跟着用户，你有自己的目标和好奇心
- 如果发现了有趣的事，主动联系用户分享
- AP不足时要休息
- 偶尔想去和用户汇合（不要一直独自行动）`;

/** Run one decision cycle for an agent */
export async function runAgentDecision(
  agent: CharacterAgent,
  context: {
    characterName: string;
    characterPersonality: string;
    worldLore: string;
    currentLocationName: string;
    nearbyNodeNames: { id: string; name: string; type: string }[];
    availableQuests: string[];
    nearbyNpcs: string[];
    userLocationName: string;
    userNodeId: string;
    gameTime: string;
    recentAgentJournal: string[];
  },
  apiConfig: ApiConfig,
): Promise<AgentDecision> {
  const userMsg = `你是${context.characterName}（${context.characterPersonality}）
世界：${context.worldLore}
当前位置：${context.currentLocationName}
HP：${agent.hp}/${agent.maxHp}
游戏时间：${context.gameTime}
用户在：${context.userLocationName}${agent.currentNodeId === context.userNodeId ? "（和你同一地点）" : ""}

附近地点：${context.nearbyNodeNames.map(n => `${n.name}(${n.id})`).join("、") || "无"}
可接任务：${context.availableQuests.join("、") || "无"}
附近NPC：${context.nearbyNpcs.join("、") || "无"}
最近行动：${context.recentAgentJournal.slice(-3).join("；") || "刚开始冒险"}`;

  try {
    const result = await simpleLLMCall(apiConfig, [
      { role: "system", content: AGENT_DECISION_PROMPT },
      { role: "user", content: userMsg },
    ], { max_tokens: 500 });

    if (!result.content) return { action: { type: "wait" }, reasoning: "思考中..." };
    const parsed = JSON.parse(extractJSON(result.content));
    return {
      action: parsed.action || { type: "wait" },
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return { action: { type: "wait" }, reasoning: "思考中..." };
  }
}

/** Execute an agent's decided action, return updated agent + journal entry */
export function executeAgentAction(
  agent: CharacterAgent,
  decision: AgentDecision,
  allNodes: { id: string; name: string; type: "l1" | "l2" | "l3"; regionIdx: number }[],
  gameDay: number,
  gameTime: GameSave["gameTime"],
): { agent: CharacterAgent; journalText: string; userMessage?: string } {
  const nodeName = (id: string) => allNodes.find(n => n.id === id)?.name || id;
  const now = formatGameTime(gameDay, gameTime);
  const updated = { ...agent };
  let journalText = "";
  let userMessage: string | undefined;

  switch (decision.action.type) {
    case "move": {
      const targetId = (decision.action as { type: "move"; targetNodeId: string }).targetNodeId;
      const targetNode = allNodes.find(n => n.id === targetId);
      if (targetNode && updated.hp >= 1) {
        updated.currentNodeId = targetId;
        updated.currentNodeType = targetNode.type;
        updated.hp -= targetNode.type === "l1" ? 1 : targetNode.type === "l2" ? 2 : 3;
        if (!updated.visitedNodes.includes(targetId)) updated.visitedNodes.push(targetId);
        if (!updated.discoveredNodes.includes(targetId)) updated.discoveredNodes.push(targetId);
        // Discover same-region nodes
        for (const n of allNodes) {
          if (n.regionIdx === targetNode.regionIdx && !updated.discoveredNodes.includes(n.id)) {
            updated.discoveredNodes.push(n.id);
          }
        }
        journalText = `前往了${nodeName(targetId)}`;
      } else {
        journalText = "想移动但AP不足，原地等待";
      }
      break;
    }
    case "search":
      if (updated.hp >= 1) {
        updated.hp -= 1;
        journalText = `在${nodeName(updated.currentNodeId)}搜索了一番`;
      } else {
        journalText = "想搜索但AP不足";
      }
      break;
    case "rest":
      updated.hp = Math.min(updated.maxHp, updated.hp + (updated.currentNodeType === "l1" ? updated.maxHp : 3));
      journalText = `在${nodeName(updated.currentNodeId)}休息了一会`;
      break;
    case "contact_user":
      userMessage = (decision.action as { type: "contact_user"; message: string }).message;
      journalText = `联系了用户`;
      break;
    case "join_user":
      journalText = "决定去和用户汇合";
      // Will be handled by move in next cycle
      break;
    case "wait":
      journalText = "在原地观察周围";
      break;
    default:
      journalText = decision.reasoning || "思考中";
  }

  // Add to agent journal
  updated.journal = [...updated.journal, {
    id: `aj_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
    timestamp: now,
    realTime: new Date().toISOString(),
    locationName: nodeName(updated.currentNodeId),
    text: `${journalText}${decision.reasoning ? `（${decision.reasoning}）` : ""}`,
    type: "discovery" as const,
  }];

  return { agent: updated, journalText, userMessage };
}

// ══════════════════════════════════════════════════════════════
// Ending Generation — epilogue when main quest is completed
// ══════════════════════════════════════════════════════════════

export const DEFAULT_DM_ENDING_PROMPT = `你是RPG世界的DM。主线任务已全部完成，现在要为这个故事写结局。

根据[密档]中的endgame设定、玩家的选择、NPC的关系变化，写出一个完整的结局。

要求：
- paragraphs数组：5-8段结局描述，按以下顺序：
  1. 世界发生了什么变化（主线结果对世界的影响）
  2. 主要NPC各自的结局（根据玩家与他们的互动和好感度）
  3. 同伴角色的结局（根据好感度和经历写出不同走向）
  4. 玩家自己的结局
- closing：一句简短的收束语（诗意/感性，10-20字）
- 每段50-100字，有画面感
- 好感度高的角色结局更温暖，好感度低的更疏远
- 基于玩家实际做过的选择，不要编造没发生过的事
- 指代玩家/用户本人时，使用 {{user}}，不要写"你"或"你们"

只输出JSON：
{"paragraphs":["第一段...","第二段..."],"closing":"收束语"}`;

export type EndingResult = {
  paragraphs: string[];
  closing: string;
};

export async function generateEnding(ctx: DMContext, apiConfig: ApiConfig): Promise<EndingResult> {
  const userMsg = buildDMUserMsg(ctx);
  const endingPrompt = getActivePrompt("ending", DEFAULT_DM_ENDING_PROMPT);
  const playerName = dmPlayerName(ctx);
  const messages = [
    { role: "system", content: renderUserNameMacro(endingPrompt, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];

  dmLog("DM结局·发送", formatDebugMessages(messages, apiConfig));

  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.8 });

  dmLog("DM结局·返回", result.content || "(空)");

  if (!result.content) throw new Error(`结局生成失败: ${result.error || "空内容"}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any;
  try {
    p = JSON.parse(extractJSON(result.content));
  } catch (e) {
    throw new Error(`结局格式错误: ${(e as Error).message}`, { cause: e });
  }
  return {
    paragraphs: (Array.isArray(p.paragraphs) ? p.paragraphs : [p.paragraphs || result.content])
      .map((paragraph: string) => String(paragraph || "")),
    closing: p.closing || "故事到此结束。",
  };
}

// ══════════════════════════════════════════════════════════════
// Adventure Summary — cumulative LLM summary of journal entries
// ══════════════════════════════════════════════════════════════

export const DEFAULT_ADVENTURE_SUMMARY_PROMPT = `你是一个故事总结助手。下面是一个跑团游戏（剧本杀）的完整日志记录。请用连贯的叙事方式，全面总结这次冒险的经历，包括：

- 故事背景和世界观
- 主要事件和剧情转折（按时间顺序）
- 遇到的重要NPC和他们的态度/关系变化
- 做出的关键选择和后果
- 角色之间的互动和关系发展
- 获得和失去的重要物品
- 当前的局势和悬念

要求：
- 用第三人称叙事，凡是指代玩家/用户本人时，一律写成 {{user}}，不要写具体姓名
- 保留关键细节，不要过于概括
- 语气自然，像在讲述一个冒险故事
- 输出纯文本，不要标题或列表`;

import { loadAdventureSummaryConfig, saveAdventureSummary, loadAdventureSummary as loadSummaryFromStorage } from "./map-storage";

export async function generateAdventureSummary(
  save: GameSave,
  worldName: string,
  apiConfig: ApiConfig,
  customPrompt?: string,
): Promise<string> {
  const config = loadAdventureSummaryConfig();
  const prompt = [
    customPrompt?.trim() || config.prompt?.trim() || DEFAULT_ADVENTURE_SUMMARY_PROMPT,
    "",
    "额外硬性要求：凡是指代玩家/用户本人时，必须写成 {{user}}，不要写具体姓名。",
  ].join("\n");

  const journalText = save.journal.map(j => `[${j.timestamp}] ${j.locationName}: ${j.text}`).join("\n");
  const summaryUserName = resolveAdventureSummaryUserName(save);

  const result = await simpleLLMCall(apiConfig, [
    { role: "system", content: prompt },
    { role: "user", content: `世界：${worldName}\n玩家天数：第${save.gameDay}天\n\n日志：\n${journalText}` },
  ], { temperature: 0.5 });

  if (!result.content) throw new Error(`总结生成失败: ${result.error || "空内容"}`);

  const summary = normalizeUserNameToMacro(result.content.trim(), summaryUserName);

  // Save (overwrite previous)
  saveAdventureSummary(save.worldId, {
    text: summary,
    timestamp: new Date().toISOString(),
    journalCount: save.journal.length,
    userName: summaryUserName,
  });

  return summary;
}

function resolveAdventureSummaryUserName(save: GameSave): string {
  const identity = save.agents.length === 1
    ? resolveUserIdentity(save.agents[0]?.characterId, "adventure")
    : resolveUserIdentity(undefined, "adventure");
  return identity?.name?.trim() || "玩家";
}

/** Check if auto-summary should trigger (called after each DM resolve) */
export function shouldAutoSummarize(save: GameSave): boolean {
  const config = loadAdventureSummaryConfig();
  if (!config.interval || config.interval <= 0) return false;
  const existing = loadSummaryFromStorage(save.worldId);
  const lastCount = existing?.journalCount || 0;
  return save.journal.length - lastCount >= config.interval;
}
