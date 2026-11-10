// lib/map-storage.ts
// RPG Map Mode — IndexedDB storage

import Dexie from "dexie";
import type { MapWorld, GameSave, CharacterAgent, StoryDirector, CharStats } from "./map-types";
import { formatPromptTimestamp } from "./prompt-time";
import { kvGet, kvSet, kvRemove, registerKvMigration, registerDynamicPrefix } from "./kv-db";
import { DEFAULT_ADVENTURE_BILINGUAL_PROMPT } from "./bilingual-prompt-defaults";
import { trackWrite } from "./pending-writes";

/** Roll 3d6×5 for each stat (CoC-style, range 15-90) */
function roll3d6x5(): number {
  return (Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1) * 5;
}
function rollStats(): CharStats {
  return { str: roll3d6x5(), con: roll3d6x5(), dex: roll3d6x5(), int: roll3d6x5(), per: roll3d6x5(), cha: roll3d6x5(), lck: roll3d6x5() };
}
/** Roll stats with personality-based bonuses (±10) */
function rollStatsFromPersonality(p: string): CharStats {
  const base = rollStats();
  const boost = (keywords: string[]) => keywords.some(k => p.includes(k)) ? 10 : 0;
  const nerf = (keywords: string[]) => keywords.some(k => p.includes(k)) ? -10 : 0;
  const clamp = (v: number) => Math.max(15, Math.min(90, v));
  return {
    str: clamp(base.str + boost(["强壮", "力量", "热血", "武"]) + nerf(["柔弱", "瘦小"])),
    con: clamp(base.con + boost(["坚韧", "耐力", "顽强"]) + nerf(["虚弱", "病"])),
    dex: clamp(base.dex + boost(["敏捷", "灵活", "身手"]) + nerf(["笨拙"])),
    int: clamp(base.int + boost(["聪明", "冷静", "理性", "智"]) + nerf(["单纯", "天真"])),
    per: clamp(base.per + boost(["敏锐", "观察", "直觉", "细心"]) + nerf(["迟钝", "粗心"])),
    cha: clamp(base.cha + boost(["魅力", "可爱", "社交", "迷人"]) + nerf(["内向", "冷漠"])),
    lck: clamp(base.lck + boost(["幸运", "运气"]) + nerf(["倒霉"])),
  };
}

class MapDatabase extends Dexie {
  worlds!: Dexie.Table<MapWorld, string>;
  saves!: Dexie.Table<GameSave, string>;
  themeBlobs!: Dexie.Table<{ id: string; worldId: string; bgImage: string | null; customFont: string | null }, string>;

  constructor() {
    super("AiPhoneMapDB");
    this.version(1).stores({
      worlds: "id, createdAt",
      saves: "id, worldId, timestamp",
    });
    this.version(2).stores({
      worlds: "id, createdAt",
      saves: "id, worldId, timestamp",
      themeBlobs: "id, worldId",
    });
  }
}

const mapDb = new MapDatabase();

let _worldsCache: MapWorld[] = [];
let _savesCache: GameSave[] = [];
let _hydrated = false;

export async function hydrateMapStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  try {
    _worldsCache = await mapDb.worlds.toArray();
    _savesCache = await mapDb.saves.toArray();
  } catch { /* first run */ }
  // Hydrate theme blobs from IDB into memory cache
  try { await hydrateThemeBlobs(); } catch { /* ignore */ }
  _hydrated = true;
}

// Auto-hydrate
if (typeof window !== "undefined") hydrateMapStorage();

// ── World CRUD ──

export function loadMapWorlds(): MapWorld[] {
  return [..._worldsCache].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getMapWorld(id: string): MapWorld | null {
  return _worldsCache.find(w => w.id === id) ?? null;
}

export function saveMapWorld(world: MapWorld): void {
  const idx = _worldsCache.findIndex(w => w.id === world.id);
  if (idx >= 0) _worldsCache[idx] = world;
  else _worldsCache.push(world);
  trackWrite(mapDb.worlds.put(world)).catch(() => undefined);
}

export function deleteMapWorld(id: string): void {
  _worldsCache = _worldsCache.filter(w => w.id !== id);
  _savesCache = _savesCache.filter(s => s.worldId !== id);
  trackWrite(mapDb.worlds.delete(id)).catch(() => undefined);
  trackWrite(mapDb.saves.where("worldId").equals(id).delete()).catch(() => undefined);
}

// ── Save CRUD ──

export function loadSavesForWorld(worldId: string): GameSave[] {
  return _savesCache
    .filter(s => s.worldId === worldId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function getLatestSave(worldId: string): GameSave | null {
  const saves = loadSavesForWorld(worldId);
  const save = saves[0] ?? null;
  if (save && !save.playerStats) {
    const patched = { ...save, playerStats: rollStats() };
    saveGame(patched);
    return patched;
  }
  return save;
}

export function saveGame(save: GameSave): void {
  const idx = _savesCache.findIndex(s => s.id === save.id);
  if (idx >= 0) _savesCache[idx] = save;
  else _savesCache.push(save);
  trackWrite(mapDb.saves.put(save)).catch(() => undefined);
}

export function deleteSave(id: string): void {
  _savesCache = _savesCache.filter(s => s.id !== id);
  trackWrite(mapDb.saves.delete(id)).catch(() => undefined);
}

// ── New Game State ──

export function createInitialSave(worldId: string, startNodeId: string): GameSave {
  const now = new Date().toISOString();
  return {
    id: `save_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    worldId,
    timestamp: now,
    currentNodeId: startNodeId,
    currentNodeType: "l1",
    discoveredNodes: [startNodeId],
    visitedNodes: [startNodeId],
    hp: 100,
    maxHp: 100,
    playerStats: rollStats(),
    agents: [],
    mainQuestStage: 0,
    usedEncounterIds: [],
    director: createInitialDirector(),
    gameDay: 1,
    gameTime: "morning",
    journal: [{
      id: `j_${Date.now()}`,
      timestamp: "第1天 · 清晨",
      realTime: now,
      locationName: "起点",
      text: "冒险开始了。",
      type: "discovery",
    }],
    keyChoices: [],
    searchedNodes: {},
  };
}

/** Add a character agent to a save */
export function addAgentToSave(save: GameSave, characterId: string, personality: string): GameSave {
  if (save.agents.some(a => a.characterId === characterId)) return save;
  const p = personality.toLowerCase();
  const agent: CharacterAgent = {
    characterId,
    currentNodeId: save.currentNodeId,  // starts at user's location
    currentNodeType: save.currentNodeType,
    discoveredNodes: [...save.discoveredNodes],
    visitedNodes: [save.currentNodeId],
    activeSideQuests: [],
    completedSideQuests: [],
    hp: 100,
    maxHp: 100,
    journal: [],
    affinity: 15,
    stats: rollStatsFromPersonality(p),
  };
  return { ...save, agents: [...save.agents, agent] };
}

/** Remove a character agent from a save */
export function removeAgentFromSave(save: GameSave, characterId: string): GameSave {
  return { ...save, agents: save.agents.filter(a => a.characterId !== characterId) };
}

// ── Projection for short-term memory ──

export type MapProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
};

/** Load map adventure projections — single-character worlds only (multi-character → shared memory) */
export function loadMapProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string },
): MapProjectionEntry[] {
  const projections: MapProjectionEntry[] = [];
  for (const save of _savesCache) {
    // Only include if this character is in the world AND it's a single-character world
    if (save.agents.length !== 1) continue;
    if (save.agents[0]?.characterId !== characterId) continue;
    const summary = loadAdventureSummary(save.worldId);
    if (!summary) continue;
    if (options?.afterTimestamp && summary.timestamp <= options.afterTimestamp) continue;
    projections.push({
      id: `map_summary_${save.worldId}`,
      timestamp: summary.timestamp,
      content: `[跑团游戏 ${formatPromptTimestamp(summary.timestamp)}] ${summary.text}`,
    });
  }
  return projections;
}

/** Load map adventure projections for shared memory — multi-character worlds only */
export function loadMapSharedProjectionEntries(
  characterIds: string[],
  options?: { afterTimestamp?: string },
): MapProjectionEntry[] {
  const projections: MapProjectionEntry[] = [];
  const charSet = new Set(characterIds);
  for (const save of _savesCache) {
    // Only include multi-character worlds where at least one of the characters participated
    if (save.agents.length <= 1) continue;
    if (!save.agents.some(a => charSet.has(a.characterId))) continue;
    const summary = loadAdventureSummary(save.worldId);
    if (!summary) continue;
    if (options?.afterTimestamp && summary.timestamp <= options.afterTimestamp) continue;
    projections.push({
      id: `map_shared_${save.worldId}`,
      timestamp: summary.timestamp,
      content: `[跑团游戏 ${formatPromptTimestamp(summary.timestamp)}] ${summary.text}`,
    });
  }
  return projections;
}

// ── Helpers ──

export function createInitialDirector(): StoryDirector {
  return {
    mainArc: { currentStage: 0, stageResults: [] },
    sideArcResults: {},
    keyItems: [],
    keyNpcsMet: [],
    worldChanges: [],
    plantedClues: [],
    unrevealedSecrets: [],
  };
}

export function generateWorldId(): string {
  return `world_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Adventure Interaction Config ──

const ADVENTURE_INTERACTION_CONFIG_KEY = "map_adventure_interaction_config_v1";

export type AdventureInteractionConfig = {
  bilingualTranslationEnabled: boolean;
  collapseBilingualTranslation: boolean;
  bilingualTranslationPrompt: string;
};

export const DEFAULT_ADVENTURE_INTERACTION_CONFIG: AdventureInteractionConfig = {
  bilingualTranslationEnabled: true,
  collapseBilingualTranslation: true,
  bilingualTranslationPrompt: DEFAULT_ADVENTURE_BILINGUAL_PROMPT,
};

export function loadAdventureInteractionConfig(): AdventureInteractionConfig {
  if (typeof window === "undefined") return DEFAULT_ADVENTURE_INTERACTION_CONFIG;
  try {
    const raw = kvGet(ADVENTURE_INTERACTION_CONFIG_KEY);
    if (!raw) return DEFAULT_ADVENTURE_INTERACTION_CONFIG;
    return { ...DEFAULT_ADVENTURE_INTERACTION_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_ADVENTURE_INTERACTION_CONFIG;
  }
}

export function saveAdventureInteractionConfig(config: AdventureInteractionConfig): void {
  if (typeof window === "undefined") return;
  kvSet(ADVENTURE_INTERACTION_CONFIG_KEY, JSON.stringify(config));
}

// ── DM Prompt Customization (localStorage) ──

export type DMPromptKey = "scene" | "resolve" | "worldGen" | "ending";

const DM_PROMPT_STORAGE_KEY = "map_dm_prompts";

export function loadDMPrompts(): Record<DMPromptKey, string> {
  if (typeof window === "undefined") return { scene: "", resolve: "", worldGen: "", ending: "" };
  try {
    const raw = kvGet(DM_PROMPT_STORAGE_KEY);
    if (raw) return { scene: "", resolve: "", worldGen: "", ending: "", ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { scene: "", resolve: "", worldGen: "", ending: "" };
}

export function saveDMPrompts(prompts: Record<DMPromptKey, string>): void {
  if (typeof window === "undefined") return;
  kvSet(DM_PROMPT_STORAGE_KEY, JSON.stringify(prompts));
}

// ── DM Token Budget Config ──

export type DMTokenConfig = {
  journalTokenBudget: number;    // max tokens for journal in DM context
  dialogueTokenBudget: number;   // max tokens for current event dialogue
};

const DM_TOKEN_CONFIG_KEY = "map_dm_token_config";
const DEFAULT_DM_TOKEN_CONFIG: DMTokenConfig = {
  journalTokenBudget: 100000,
  dialogueTokenBudget: 100000,
};

export function loadDMTokenConfig(): DMTokenConfig {
  if (typeof window === "undefined") return DEFAULT_DM_TOKEN_CONFIG;
  try {
    const raw = kvGet(DM_TOKEN_CONFIG_KEY);
    if (raw) return { ...DEFAULT_DM_TOKEN_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_DM_TOKEN_CONFIG;
}

export function saveDMTokenConfig(config: DMTokenConfig): void {
  if (typeof window === "undefined") return;
  kvSet(DM_TOKEN_CONFIG_KEY, JSON.stringify(config));
}

// ── World Theme (per world) ──
// Small config → localStorage; large blobs (customFont, legacy bgImage cleanup) → IndexedDB

export type WorldTheme = {
  colorScheme?: number;     // 0-5
  customFont?: string;      // data URL (loaded from IDB)
  customFontName?: string;  // display name
  lineHeightScale?: number; // 0.8-2.0, default 1
  fontScale?: number;       // 0.8-1.5, default 1
};

type WorldThemeConfig = Omit<WorldTheme, "customFont">;

const WORLD_THEME_PREFIX = "map_world_theme_";

// In-memory cache for blobs (loaded from IDB)
const _themeBlobCache: Record<string, { customFont?: string }> = {};

export function loadWorldTheme(worldId: string): WorldTheme {
  if (typeof window === "undefined") return {};
  try {
    const raw = kvGet(WORLD_THEME_PREFIX + worldId);
    const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    delete parsed.bgImage;
    delete parsed.customFont;
    const config = parsed as WorldThemeConfig;
    const blobs = _themeBlobCache[worldId] || {};
    return { ...config, customFont: blobs.customFont };
  } catch { /* ignore */ }
  return {};
}

export function saveWorldTheme(worldId: string, theme: WorldTheme): void {
  if (typeof window === "undefined") return;
  // Save small config to localStorage (without blobs)
  const { customFont, ...config } = theme;
  kvSet(WORLD_THEME_PREFIX + worldId, JSON.stringify(config));
  // Save blobs to IndexedDB (fire-and-forget)
  _themeBlobCache[worldId] = { customFont };
  mapDb.table("worlds").get(worldId).then(() => {
    // Store blobs in a separate IDB object store
    _saveThemeBlobs(worldId, customFont);
  }).catch(() => undefined);
}

// IDB blob storage
async function _saveThemeBlobs(worldId: string, customFont?: string): Promise<void> {
  try {
    const key = `theme_blob_${worldId}`;
    const data = { id: key, worldId, bgImage: null, customFont: customFont || null };
    await mapDb.table("themeBlobs").put(data);
  } catch { /* ignore */ }
}

export async function hydrateThemeBlobs(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const blobs = await mapDb.table("themeBlobs").toArray();
    for (const b of blobs) {
      _themeBlobCache[b.worldId] = { customFont: b.customFont || undefined };
    }
  } catch { /* first run — table may not exist */ }
}

// ── Adventure Summary Config ──

export type AdventureSummaryConfig = {
  interval: number;          // summarize every N journal entries (0 = disabled)
  prompt: string;            // custom summary prompt (empty = use default)
};

const ADVENTURE_SUMMARY_CONFIG_KEY = "map_adventure_summary_config";
const DEFAULT_ADVENTURE_SUMMARY_CONFIG: AdventureSummaryConfig = {
  interval: 20,
  prompt: "",
};

export function loadAdventureSummaryConfig(): AdventureSummaryConfig {
  if (typeof window === "undefined") return DEFAULT_ADVENTURE_SUMMARY_CONFIG;
  try {
    const raw = kvGet(ADVENTURE_SUMMARY_CONFIG_KEY);
    if (raw) return { ...DEFAULT_ADVENTURE_SUMMARY_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_ADVENTURE_SUMMARY_CONFIG;
}

export function saveAdventureSummaryConfig(config: AdventureSummaryConfig): void {
  if (typeof window === "undefined") return;
  kvSet(ADVENTURE_SUMMARY_CONFIG_KEY, JSON.stringify(config));
}

// ── Adventure Summary Storage (per world, single entry overwritten) ──

const ADVENTURE_SUMMARY_KEY_PREFIX = "map_adventure_summary_";
registerKvMigration(ADVENTURE_INTERACTION_CONFIG_KEY);
registerKvMigration(DM_PROMPT_STORAGE_KEY);
registerKvMigration(DM_TOKEN_CONFIG_KEY);
registerKvMigration(ADVENTURE_SUMMARY_CONFIG_KEY);
registerDynamicPrefix(WORLD_THEME_PREFIX);
registerDynamicPrefix(ADVENTURE_SUMMARY_KEY_PREFIX);

export type AdventureSummary = {
  text: string;
  timestamp: string;
  journalCount: number;    // how many journal entries this summary covers
  userName?: string;
};

export function loadAdventureSummary(worldId: string): AdventureSummary | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = kvGet(ADVENTURE_SUMMARY_KEY_PREFIX + worldId);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

export function saveAdventureSummary(worldId: string, summary: AdventureSummary): void {
  if (typeof window === "undefined") return;
  kvSet(ADVENTURE_SUMMARY_KEY_PREFIX + worldId, JSON.stringify(summary));
}
