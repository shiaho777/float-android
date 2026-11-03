import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// ── 查找(Find My) 存储层 ──────────────────────────────────
// 真实地图（Leaflet 瓦片）上的地点库 + 角色定位配置。
// 数据源独立于日程：日程产出"地点名"文本，这里把地点名落成坐标。

const PLACES_KEY = "ai_phone_findmy_places_v1";
const CHAR_CFG_KEY = "ai_phone_findmy_charcfg_v1";
const SETTINGS_KEY = "ai_phone_findmy_settings_v2";
registerKvMigration(PLACES_KEY);
registerKvMigration(CHAR_CFG_KEY);
registerKvMigration(SETTINGS_KEY);

// ── 地点 ──

export type MapPlace = {
  id: string;
  name: string;              // "健身房" / "小美的家" / "CBD写字楼"
  emoji: string;             // pin 和列表上的图标
  lat: number;
  lng: number;               // WGS-84；高德瓦片显示时由渲染层转 GCJ-02
  keywords: string[];        // 日程地点文本模糊匹配词（含 name 自动算）
  /** 绑定为某角色的"家"——无日程无 override 时落在这里 */
  boundCharacterId?: string;
  createdAt: string;
};

export type FindMyCharConfig = {
  characterId: string;
  /** 手动钉死的位置——优先级高于日程推演，清除后回落到日程 */
  overridePlaceId?: string;
  overrideNote?: string;     // 用户备注（"在出差"之类），会进提示词
};

export type FindMyTileProvider = "amap" | "tencent_sate" | "esri_street" | "esri_imagery";

export type FindMySettings = {
  tileProvider: FindMyTileProvider;
  /** 城市锚点：首次定位/搜索后记录，地图默认视野中心 */
  cityAnchor?: { lat: number; lng: number; label: string };
};

const DEFAULT_SETTINGS: FindMySettings = { tileProvider: "amap" };

// ── Places CRUD ──

function loadPlacesRaw(): MapPlace[] {
  const raw = kvGet(PLACES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(p => p && typeof p === "object"
      && typeof p.name === "string" && p.name.trim()
      && typeof p.lat === "number" && typeof p.lng === "number") as MapPlace[];
  } catch { return []; }
}

export function loadMapPlaces(): MapPlace[] {
  return loadPlacesRaw();
}

export function saveMapPlaces(places: MapPlace[]): void {
  kvSet(PLACES_KEY, JSON.stringify(places));
}

export function upsertMapPlace(place: MapPlace): MapPlace {
  const places = loadPlacesRaw();
  const idx = places.findIndex(p => p.id === place.id);
  const next = { ...place, name: place.name.trim() };
  if (idx >= 0) places[idx] = next; else places.push(next);
  saveMapPlaces(places);
  return next;
}

export function deleteMapPlace(placeId: string): void {
  saveMapPlaces(loadPlacesRaw().filter(p => p.id !== placeId));
  // 顺带清掉指向它的角色配置
  const cfgs = loadAllCharConfigs();
  let dirty = false;
  for (const c of cfgs) {
    if (c.overridePlaceId === placeId) { delete c.overridePlaceId; delete c.overrideNote; dirty = true; }
  }
  if (dirty) saveAllCharConfigs(cfgs);
}

export function getPlaceById(placeId: string): MapPlace | null {
  return loadPlacesRaw().find(p => p.id === placeId) ?? null;
}

/** 角色的"家"地点（boundCharacterId 匹配） */
export function getHomePlace(characterId: string): MapPlace | null {
  return loadPlacesRaw().find(p => p.boundCharacterId === characterId) ?? null;
}

// ── 地点名 → 地点 模糊匹配 ──
// 日程只产出文本（"健身房"/"公司"），匹配规则：地点 name 或任一 keyword
// 与查询文本互为包含（去空格小写）。多处命中取名字最短的（更精确）。

export function matchPlaceByName(locationText: string, places?: MapPlace[]): MapPlace | null {
  const q = locationText.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return null;
  const list = places ?? loadPlacesRaw();
  let best: MapPlace | null = null;
  let bestLen = Infinity;
  for (const p of list) {
    const terms = [p.name, ...(p.keywords || [])];
    for (const t of terms) {
      const k = (t || "").trim().toLowerCase().replace(/\s+/g, "");
      if (!k) continue;
      if (q.includes(k) || k.includes(q)) {
        if (k.length < bestLen) { best = p; bestLen = k.length; }
        break;
      }
    }
  }
  return best;
}

// ── 角色配置 ──

function loadAllCharConfigs(): FindMyCharConfig[] {
  const raw = kvGet(CHAR_CFG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(c => c && typeof c.characterId === "string") as FindMyCharConfig[];
  } catch { return []; }
}

function saveAllCharConfigs(cfgs: FindMyCharConfig[]): void {
  kvSet(CHAR_CFG_KEY, JSON.stringify(cfgs));
}

export function getCharFindMyConfig(characterId: string): FindMyCharConfig | null {
  return loadAllCharConfigs().find(c => c.characterId === characterId) ?? null;
}

export function setCharOverride(characterId: string, placeId: string | null, note?: string): void {
  const cfgs = loadAllCharConfigs();
  const idx = cfgs.findIndex(c => c.characterId === characterId);
  const cfg: FindMyCharConfig = idx >= 0 ? { ...cfgs[idx] } : { characterId };
  if (placeId) {
    cfg.overridePlaceId = placeId;
    cfg.overrideNote = note?.trim() || undefined;
  } else {
    delete cfg.overridePlaceId;
    delete cfg.overrideNote;
  }
  if (idx >= 0) cfgs[idx] = cfg; else cfgs.push(cfg);
  saveAllCharConfigs(cfgs);
}

// ── 设置 ──

export function loadFindMySettings(): FindMySettings {
  const raw = kvGet(SETTINGS_KEY);
  if (!raw) {
    // v1→v2 迁移：只搬城市锚点，瓦片源强制走新默认（旧默认 carto 在国内加载不出图）
    try {
      const legacy = kvGet("ai_phone_findmy_settings_v1");
      if (legacy) {
        const parsed = JSON.parse(legacy);
        if (parsed && typeof parsed === "object" && parsed.cityAnchor) {
          return { ...DEFAULT_SETTINGS, cityAnchor: parsed.cityAnchor };
        }
      }
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(raw);
    const s: FindMySettings = { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    if (!TILE_PROVIDERS[s.tileProvider]) s.tileProvider = DEFAULT_SETTINGS.tileProvider;
    return s;
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveFindMySettings(settings: FindMySettings): void {
  kvSet(SETTINGS_KEY, JSON.stringify(settings));
}

// ── 瓦片源 ──

export const TILE_PROVIDERS: Record<FindMyTileProvider, {
  label: string; url: string; subdomains: string; attribution: string;
  gcj02: boolean; maxNativeZoom: number; detectRetina?: boolean;
  /** 非标准 URL 模板（如需 {x>>4} 分层路径） */
  customUrl?: "tencent_sate";
}> = {
  amap: {
    label: "高德",
    url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
    subdomains: "1234",
    attribution: "© 高德地图",
    gcj02: true,
    maxNativeZoom: 18,   // 高德 style=8 栅格只到 z18，更深会 404 空白——靠 maxNativeZoom 放大
  },
  tencent_sate: {
    label: "腾讯卫星",
    url: "https://p{s}.map.gtimg.com", // 实际路径由 customUrl 工厂拼（分层目录结构）
    subdomains: "0123",
    attribution: "© 腾讯地图",
    gcj02: true,          // 腾讯同为 GCJ-02
    maxNativeZoom: 18,
    customUrl: "tencent_sate",
  },
  esri_street: {
    label: "Esri 街道(境外)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    subdomains: "0",
    attribution: "© Esri",
    gcj02: false,
    maxNativeZoom: 18,
  },
  esri_imagery: {
    label: "Esri 卫星(境外)",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    subdomains: "0",
    attribution: "© Esri, Maxar, Earthstar Geographics",
    gcj02: false,
    maxNativeZoom: 18,
  },
};

/** 加载连续失败时的自动降级目标（null = 不再降级，避免死循环） */
export const TILE_FALLBACK: Record<FindMyTileProvider, FindMyTileProvider | null> = {
  amap: null,
  tencent_sate: "amap",
  esri_street: null,
  esri_imagery: "esri_street",
};

/** 高德/腾讯瓦片实际覆盖范围粗判——境外会回 200 空白占位图，tileerror 抓不到。
 *  中国大陆框（含港澳台）内再抠掉日韩——日本九州纬度落在大陆框里。 */
export function coveredByCnTiles(lat: number, lng: number): boolean {
  const inChinaBox = lat >= 3.8 && lat <= 53.6 && lng >= 73.5 && lng <= 135.1;
  if (!inChinaBox) return false;
  const inJapan = lat >= 29.5 && lat <= 45.5 && lng >= 128.5 && lng <= 146;
  const inRyukyu = lat >= 23.5 && lat <= 28.8 && lng >= 123 && lng <= 132;
  const inKorea = lat >= 33 && lat <= 43.2 && lng >= 124.1 && lng <= 132;
  return !(inJapan || inRyukyu || inKorea);
}

// ── GCJ-02（火星坐标）转换 —— 仅高德瓦片需要 ──

const GCJ_A = 6378245.0;
const GCJ_EE = 0.006693421622965943;

function gcjTransformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function gcjTransformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

/** WGS-84 → GCJ-02。中国境外坐标原样返回（高德境外无偏移需求）。 */
export function wgs84ToGcj02(lat: number, lng: number): [number, number] {
  if (lat < 0.8293 || lat > 55.8271 || lng < 72.004 || lng > 137.8347) return [lat, lng];
  let dLat = gcjTransformLat(lng - 105.0, lat - 35.0);
  let dLng = gcjTransformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}
