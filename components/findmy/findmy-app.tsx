"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  ChevronLeft, Crosshair, MapPin, Plus, RefreshCw, Settings2,
  Home, MapPinned, MessageCircle, X, Search, Trash2, Check,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters, CHARACTERS_UPDATED_EVENT } from "@/lib/character-storage";
import { createOrGetSession } from "@/lib/chat-storage";
import {
  loadMapPlaces, upsertMapPlace, deleteMapPlace,
  loadFindMySettings, saveFindMySettings, setCharOverride,
  TILE_PROVIDERS, TILE_FALLBACK, coveredByCnTiles, wgs84ToGcj02,
  type MapPlace, type FindMyTileProvider, type FindMySettings,
} from "@/lib/findmy-storage";
import {
  resolveAllPresences, type CharacterPresence,
} from "@/lib/presence-engine";
import "@/styles/findmy.css";

// ── helpers ──

function openChatWithCharacter(characterId: string) {
  const session = createOrGetSession(characterId);
  window.dispatchEvent(new CustomEvent("open-app", {
    detail: { appId: "chat", sessionId: session.id },
  }));
}

function avatarHtml(char: Character, size = "100%"): string {
  if (char.avatar) {
    return `<img src="${char.avatar}" alt="" style="width:${size};height:${size};object-fit:cover;border-radius:50%;" draggable="false"/>`;
  }
  return `<span class="fm-pin-initial">${(char.name || "?").slice(0, 1)}</span>`;
}

function buildPinIcon(char: Character, presence: CharacterPresence | null, selected: boolean): L.DivIcon {
  const badge = presence ? `<span class="fm-pin-badge">${presence.place.emoji || "📍"}</span>` : "";
  const off = presence ? "" : " fm-pin-offgrid";
  return L.divIcon({
    className: "fm-pin-wrap",
    html: `<div class="fm-pin${selected ? " fm-pin-selected" : ""}${off}">
      <span class="fm-pin-ring"></span>
      <span class="fm-pin-avatar">${avatarHtml(char)}</span>
      ${badge}
      <span class="fm-pin-name">${char.name}</span>
    </div>`,
    iconSize: [64, 78],
    iconAnchor: [32, 46],
  });
}

function buildPlaceIcon(place: MapPlace): L.DivIcon {
  return L.divIcon({
    className: "fm-place-wrap",
    html: `<div class="fm-place"><span class="fm-place-emoji">${place.emoji || "📍"}</span><span class="fm-place-name">${place.name}</span></div>`,
    iconSize: [80, 24],
    iconAnchor: [14, 12],
  });
}

function buildMeIcon(): L.DivIcon {
  return L.divIcon({
    className: "fm-me-wrap",
    html: `<div class="fm-me"><span class="fm-me-halo"></span><span class="fm-me-dot"></span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

type Modal =
  | { kind: "place"; lat: number; lng: number; place?: MapPlace; presetName?: string; bindCharId?: string }
  | { kind: "char"; characterId: string }
  | { kind: "settings" }
  | { kind: "pickPlace"; characterId: string }   // 选地点当 override
  | { kind: "pickHome"; characterId: string }    // 选地点当 TA 的家
  | null;

const DEFAULT_VIEW: [number, number] = [39.9042, 116.4074]; // 北京兜底
const MAP_MAX_ZOOM = 19;

/** nominatim display_name 末段（国名）判定为"国内图源可覆盖"的集合 */
const CN_COUNTRIES = new Set([
  "中国", "中华人民共和国",
  "台湾", "台湾省", "臺灣", "臺灣省",
  "香港", "香港特别行政区", "香港特別行政區",
  "澳门", "澳門", "澳门特别行政区", "澳門特別行政區",
]);

/** 腾讯卫星图分层路径：{z}/{x>>4}/{y>>4}/{x}_{y}.jpg —— Y 轴是 TMS 编号（与 OSM 相反） */
const TencentSateLayer = L.TileLayer.extend({
  getTileUrl(this: L.TileLayer, coords: L.Coords): string {
    const subs = this.options.subdomains ?? "0123";
    const arr = Array.isArray(subs) ? subs : subs.split("");
    const s = arr[Math.abs(coords.x + coords.y) % arr.length];
    const y = (1 << coords.z) - 1 - coords.y;  // TMS flip：不翻则每块瓦片都是别处地图
    return `https://p${s}.map.gtimg.com/sateTiles/${coords.z}/${coords.x >> 4}/${y >> 4}/${coords.x}_${y}.jpg`;
  },
});

/** 瓦片层工厂：maxNativeZoom 兜底空白缩放 + 移动性能参数 */
function buildTileLayer(p: typeof TILE_PROVIDERS[FindMyTileProvider], onTileError: () => void): L.TileLayer {
  const TileClass = p.customUrl === "tencent_sate" ? TencentSateLayer : L.TileLayer;
  const layer = new TileClass(p.url, {
    subdomains: p.subdomains,
    maxZoom: MAP_MAX_ZOOM,
    maxNativeZoom: p.maxNativeZoom,   // 超过此级自动放大已有瓦片，不再请求（防 z>18 高德空白）
    minZoom: 3,
    keepBuffer: 4,                    // 默认2→4：回拖视野时瓦片还在内存，不重拉
    updateWhenZooming: false,         // 缩放动画期间不拉中间级瓦片（省一半请求）
    updateWhenIdle: true,             // 拖动停止才补新瓦片，拖动过程零请求
    noWrap: true,                     // 不横向重复拼接世界，省无效瓦片
    detectRetina: p.detectRetina ?? false,
    attribution: p.attribution,
  });
  layer.on("tileerror", onTileError);
  return layer;
}

export default function FindMyApp({ onClose }: { onClose: () => void }) {
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const pinLayerRef = useRef<L.LayerGroup | null>(null);
  const placeLayerRef = useRef<L.LayerGroup | null>(null);
  const meMarkerRef = useRef<L.Marker | null>(null);
  const addModeRef = useRef(false);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [presences, setPresences] = useState<Map<string, CharacterPresence>>(new Map());
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [settings, setSettings] = useState(() => loadFindMySettings());
  const [modal, setModal] = useState<Modal>(null);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [mePos, setMePos] = useState<[number, number] | null>(null);
  const [locating, setLocating] = useState(false);
  const [cityQuery, setCityQuery] = useState("");
  const [cityResults, setCityResults] = useState<{ lat: number; lng: number; label: string; country: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState("");
  const [noCoverage, setNoCoverage] = useState(false);

  const provider = TILE_PROVIDERS[settings.tileProvider] ?? TILE_PROVIDERS.amap;

  const toDisplay = useCallback((lat: number, lng: number): [number, number] => {
    return provider.gcj02 ? wgs84ToGcj02(lat, lng) : [lat, lng];
  }, [provider.gcj02]);
  const fromDisplay = useCallback((lat: number, lng: number): [number, number] => {
    // 显示坐标→存储坐标：GCJ-02 反向偏移（一次迭代足够精度）
    if (!provider.gcj02) return [lat, lng];
    const [gLat, gLng] = wgs84ToGcj02(lat, lng);
    return [lat - (gLat - lat), lng - (gLng - lng)];
  }, [provider.gcj02]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2400);
  }, []);

  /** 瓦片连续加载失败 → 沿 TILE_FALLBACK 链降级（注意：境外空白占位图是 http200，抓不到这里） */
  const makeTileErrorHandler = useCallback(() => {
    let errCount = 0;
    return () => {
      if (++errCount < 6) return;
      const s = loadFindMySettings();
      const target = TILE_FALLBACK[s.tileProvider] ?? null;
      if (!target) return;
      const next = { ...s, tileProvider: target };
      saveFindMySettings(next);
      setSettings(next);
      flash(`瓦片源不通，已切换到${TILE_PROVIDERS[target].label}`);
    };
  }, [flash]);

  /** 当前视野中心是否在国内图源（gcj02 源 = 高德/腾讯）的覆盖外 */
  const checkCoverage = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const s = loadFindMySettings();
    const p = TILE_PROVIDERS[s.tileProvider];
    const c = map.getCenter();
    setNoCoverage(!!p?.gcj02 && !coveredByCnTiles(c.lat, c.lng));
  }, []);

  const switchToEsri = useCallback(() => {
    const s = loadFindMySettings();
    const next: FindMySettings = { ...s, tileProvider: "esri_street" };
    saveFindMySettings(next);
    setSettings(next);
    flash("已切到 Esri 境外源（瓦片加载较慢）");
  }, [flash]);

  // ── 数据加载 ──
  const refresh = useCallback(() => {
    const chars = loadCharacters();
    setCharacters(chars);
    setPresences(resolveAllPresences(chars.map(c => c.id)));
    setPlaces(loadMapPlaces());
    setSettings(loadFindMySettings());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);
  // 角色为空时密集重试：kv 从 IndexedDB 异步回填，App 可能先于 hydration 挂载
  useEffect(() => {
    if (characters.length > 0) return;
    const t = window.setInterval(refresh, 1500);
    const stop = window.setTimeout(() => window.clearInterval(t), 20_000);
    return () => { window.clearInterval(t); window.clearTimeout(stop); };
  }, [characters.length, refresh]);
  // 角色库写入时即时刷新（别处新建角色同步出现）
  useEffect(() => {
    const onUpdate = () => refresh();
    window.addEventListener(CHARACTERS_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(CHARACTERS_UPDATED_EVENT, onUpdate);
  }, [refresh]);

  // ── 地图初始化 ──
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return;
    const s = loadFindMySettings();
    const p = TILE_PROVIDERS[s.tileProvider] ?? TILE_PROVIDERS.amap;
    const center: [number, number] = s.cityAnchor
      ? (p.gcj02 ? wgs84ToGcj02(s.cityAnchor.lat, s.cityAnchor.lng) : [s.cityAnchor.lat, s.cityAnchor.lng])
      : DEFAULT_VIEW;
    const map = L.map(mapElRef.current, {
      center, zoom: s.cityAnchor ? 13 : 5,
      minZoom: 3, maxZoom: MAP_MAX_ZOOM,
      zoomControl: false, attributionControl: false,
      zoomSnap: 0.5,                    // 允许半级缩放——视野对角色卡的贴合更顺
      wheelPxPerZoomLevel: 90,          // 滚轮缩放更缓，减少中间级瓦片请求
    });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);
    tileRef.current = buildTileLayer(p, makeTileErrorHandler()).addTo(map);
    pinLayerRef.current = L.layerGroup().addTo(map);
    placeLayerRef.current = L.layerGroup().addTo(map);
    map.on("click", () => {
      if (addModeRef.current) return; // 选点模式：点击由确认键接管
      setSelectedCharId(null);
    });
    map.on("moveend", checkCoverage);
    mapRef.current = map;
    checkCoverage();
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 瓦片源切换
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tileRef.current?.remove();
    tileRef.current = buildTileLayer(provider, makeTileErrorHandler()).addTo(map);
    renderPins();
    renderPlaces();
    checkCoverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.tileProvider]);

  // ── 图钉渲染 ──
  const renderPins = useCallback(() => {
    const layer = pinLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const char of characters) {
      const presence = presences.get(char.id) ?? null;
      if (!presence) continue;
      const [lat, lng] = toDisplay(presence.place.lat, presence.place.lng);
      const marker = L.marker([lat, lng], {
        icon: buildPinIcon(char, presence, char.id === selectedCharId),
        zIndexOffset: char.id === selectedCharId ? 1000 : 0,
      });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e.originalEvent);
        setSelectedCharId(char.id);
      });
      marker.addTo(layer);
    }
  }, [characters, presences, selectedCharId, toDisplay]);

  const renderPlaces = useCallback(() => {
    const layer = placeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const place of places) {
      const [lat, lng] = toDisplay(place.lat, place.lng);
      const marker = L.marker([lat, lng], { icon: buildPlaceIcon(place), interactive: true });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e.originalEvent);
        setModal({ kind: "place", lat: place.lat, lng: place.lng, place });
      });
      marker.addTo(layer);
    }
  }, [places, toDisplay]);

  useEffect(() => { renderPins(); }, [renderPins]);
  useEffect(() => { renderPlaces(); }, [renderPlaces]);
  useEffect(() => { addModeRef.current = addMode; }, [addMode]);

  // 我的位置
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    meMarkerRef.current?.remove();
    meMarkerRef.current = null;
    if (mePos) {
      meMarkerRef.current = L.marker(toDisplay(mePos[0], mePos[1]), { icon: buildMeIcon(), zIndexOffset: -500 }).addTo(map);
    }
  }, [mePos, toDisplay]);

  // ── 行为 ──
  const locateMe = useCallback(async () => {
    setLocating(true);
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 8000 });
      const wgs: [number, number] = [pos.coords.latitude, pos.coords.longitude];
      setMePos(wgs);
      const s = loadFindMySettings();
      const next = { ...s, cityAnchor: { lat: wgs[0], lng: wgs[1], label: "我的位置" } };
      saveFindMySettings(next);
      setSettings(next);
      mapRef.current?.flyTo(toDisplay(wgs[0], wgs[1]), 14, { duration: 1.2 });
    } catch {
      flash("定位失败——可以用搜索或长按地图定城市");
    } finally { setLocating(false); }
  }, [flash, toDisplay]);

  const searchCity = useCallback(async () => {
    const q = cityQuery.trim();
    if (!q) return;
    setSearching(true);
    setCityResults([]);
    try {
      const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=zh&q=${encodeURIComponent(q)}`);
      const rows = await resp.json() as { lat: string; lon: string; display_name: string }[];
      setCityResults(rows.map(r => ({
        lat: Number(r.lat), lng: Number(r.lon),
        label: r.display_name.split(",")[0],
        country: r.display_name.split(",").pop()?.trim() ?? "",
      })));
    } catch { flash("城市搜索需要网络"); }
    finally { setSearching(false); }
  }, [cityQuery, flash]);

  const pickCity = useCallback((r: { lat: number; lng: number; label: string; country: string }) => {
    const s = loadFindMySettings();
    const next: FindMySettings = { ...s, cityAnchor: { lat: r.lat, lng: r.lng, label: r.label } };
    // 国内图源（gcj02）境外只有空白占位图——按国别自动切 Esri；回国内自动切回高德
    const isCn = CN_COUNTRIES.has(r.country) || (!r.country && coveredByCnTiles(r.lat, r.lng));
    const curGcj02 = TILE_PROVIDERS[s.tileProvider]?.gcj02 ?? true;
    let msg = `已把「${r.label}」设为这座城`;
    if (!isCn && curGcj02) {
      next.tileProvider = "esri_street";
      msg += " · 高德/腾讯境外无数据，已切 Esri（加载较慢）";
    } else if (isCn && !curGcj02) {
      next.tileProvider = "amap";
      msg += " · 已切回高德";
    }
    saveFindMySettings(next);
    setSettings(next);
    // flyTo 要用"切换后"的坐标系做偏移
    const np = TILE_PROVIDERS[next.tileProvider ?? "amap"];
    mapRef.current?.flyTo(np.gcj02 ? wgs84ToGcj02(r.lat, r.lng) : [r.lat, r.lng], 13, { duration: 1.4 });
    setCityResults([]);
    setCityQuery("");
    flash(msg);
  }, [flash]);

  const focusCharacter = useCallback((charId: string) => {
    setSelectedCharId(charId);
    const p = presences.get(charId);
    if (p) mapRef.current?.flyTo(toDisplay(p.place.lat, p.place.lng), Math.max(mapRef.current.getZoom(), 14), { duration: 0.9 });
  }, [presences, toDisplay]);

  const confirmAddPlace = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const [wLat, wLng] = fromDisplay(c.lat, c.lng);
    setAddMode(false);
    setModal({ kind: "place", lat: wLat, lng: wLng, bindCharId: selectedCharId ?? undefined });
  }, [fromDisplay, selectedCharId]);

  // 快捷补标：日程里的未解析地点 → 直接开标注模式，名字预填
  const quickPinUnresolved = useCallback((charId: string, locationText: string) => {
    setSelectedCharId(charId);
    setAddMode(true);
    pendingPresetRef.current = { name: locationText, bindCharId: charId };
  }, []);
  const pendingPresetRef = useRef<{ name: string; bindCharId: string } | null>(null);

  // ── 派生 ──
  const selectedChar = useMemo(() => characters.find(c => c.id === selectedCharId) ?? null, [characters, selectedCharId]);
  const selectedPresence = selectedCharId ? presences.get(selectedCharId) ?? null : null;
  const locatedCount = presences.size;

  return (
    <div className="fm-app">
      <div className="fm-header">
        <button className="fm-back" onClick={onClose}><ChevronLeft size={18} /></button>
        <h1>查 找<span className="fm-title-en">FIND MY</span></h1>
        <div className="fm-header-actions">
          <button className="fm-icon-btn" onClick={() => { refresh(); flash("已刷新"); }} title="刷新"><RefreshCw size={16} /></button>
          <button className="fm-icon-btn" onClick={() => setModal({ kind: "settings" })} title="设置"><Settings2 size={16} /></button>
        </div>
      </div>

      <div className="fm-map-shell">
        <div ref={mapElRef} className="fm-map" data-addmode={addMode ? "true" : undefined} />

        {addMode && (
          <div className="fm-addmode">
            <div className="fm-addmode-pin"><MapPin size={30} /></div>
            <div className="fm-addmode-bar">
              <button className="fm-btn ghost" onClick={() => { setAddMode(false); pendingPresetRef.current = null; }}>取消</button>
              <span className="fm-addmode-tip">移动地图，把图钉对准地点</span>
              <button className="fm-btn primary" onClick={confirmAddPlace}><Check size={14} /> 在这标注</button>
            </div>
          </div>
        )}

        <div className="fm-fabs">
          <button className="fm-fab" onClick={locateMe} disabled={locating} title="定位到我">
            <Crosshair size={17} className={locating ? "fm-spin" : undefined} />
          </button>
          <button className="fm-fab" data-active={addMode ? "true" : undefined} onClick={() => setAddMode(v => !v)} title="标注地点">
            <Plus size={18} />
          </button>
        </div>

        {noCoverage && (
          <button className="fm-uncover" onClick={switchToEsri}>
            「{provider.label}」在这个区域没有地图数据 — 点我切到 Esri 境外源
          </button>
        )}

        {notice && <div className="fm-toast">{notice}</div>}
      </div>

      {/* 选中角色卡 */}
      {selectedChar && (
        <div className="fm-charcard">
          <div className="fm-charcard-head">
            <span className="fm-charcard-avatar" dangerouslySetInnerHTML={{ __html: avatarHtml(selectedChar) }} />
            <div className="fm-charcard-title">
              <b>{selectedChar.name}</b>
              <span className="fm-charcard-sub">
                {selectedPresence
                  ? <>{selectedPresence.source === "schedule" ? "日程定位" : selectedPresence.source === "override" ? "手动标记" : "在家"} · {formatPresenceLabel(selectedPresence)}</>
                  : "还没有位置——设为家或标注日程地点"}
              </span>
            </div>
            <button className="fm-icon-btn" onClick={() => setSelectedCharId(null)}><X size={15} /></button>
          </div>
          {selectedPresence?.unresolvedLocationText && (
            <button className="fm-unresolved" onClick={() => quickPinUnresolved(selectedChar.id, selectedPresence.unresolvedLocationText!)}>
              <MapPinned size={13} /> 日程里的「{selectedPresence.unresolvedLocationText}」还没位置，点我在图上标注
            </button>
          )}
          <div className="fm-charcard-actions">
            <button className="fm-chip-btn" onClick={() => setModal({ kind: "pickHome", characterId: selectedChar.id })}>
              <Home size={13} /> 设为家
            </button>
            <button className="fm-chip-btn" onClick={() => setModal({ kind: "pickPlace", characterId: selectedChar.id })}>
              <MapPinned size={13} /> 钉到地点
            </button>
            <button className="fm-chip-btn accent" onClick={() => openChatWithCharacter(selectedChar.id)}>
              <MessageCircle size={13} /> 找TA
            </button>
          </div>
        </div>
      )}

      {/* 底部角色列表 */}
      {!selectedChar && (
        <div className="fm-people">
          <div className="fm-people-title">
            <span>角色 · {locatedCount}/{characters.length} 已定位</span>
            {!settings.cityAnchor && (
              <button className="fm-people-hint-btn" onClick={() => setModal({ kind: "settings" })}>
                先定位或搜索一座城 →
              </button>
            )}
          </div>
          <div className="fm-people-scroll">
            {characters.map(c => {
              const p = presences.get(c.id);
              return (
                <button key={c.id} className="fm-person" onClick={() => focusCharacter(c.id)}>
                  <span className="fm-person-avatar" dangerouslySetInnerHTML={{ __html: avatarHtml(c) }} />
                  <span className="fm-person-name">{c.name}</span>
                  <span className="fm-person-loc">
                    {p ? `${p.place.emoji || "📍"} ${p.place.name}` : "未定位"}
                    {p?.unresolvedLocationText ? " ⚠" : ""}
                  </span>
                </button>
              );
            })}
            {characters.length === 0 && (
              <button className="fm-people-empty-btn" onClick={() => window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "characters" } }))}>
                还没有角色——点我去「角色」创建
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {modal?.kind === "place" && (
        <PlaceModal
          key={modal.place?.id ?? "new"}
          modal={modal}
          characters={characters}
          presetName={pendingPresetRef.current?.name}
          presetBind={pendingPresetRef.current?.bindCharId}
          onClose={() => { setModal(null); pendingPresetRef.current = null; }}
          onSaved={(p) => {
            upsertMapPlace(p);
            pendingPresetRef.current = null;
            setModal(null);
            refresh();
            flash(`「${p.name}」已标注`);
          }}
          onDelete={modal.place ? () => {
            deleteMapPlace(modal.place!.id);
            setModal(null); refresh(); flash("已删除地点");
          } : undefined}
        />
      )}

      {modal?.kind === "pickPlace" && (
        <PlacePickerModal
          title="把 TA 钉在哪个地点？"
          places={places}
          emptyHint="还没有地点——先关闭这里，点右下角 + 在图上标注"
          onPick={(p) => {
            setCharOverride(modal.characterId, p.id);
            setModal(null); refresh(); flash(`已钉到「${p.name}」`);
          }}
          onClear={presences.get(modal.characterId)?.source === "override" ? () => {
            setCharOverride(modal.characterId, null);
            setModal(null); refresh(); flash("已恢复日程定位");
          } : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === "pickHome" && (
        <PlacePickerModal
          title="哪个是 TA 的家？"
          places={places}
          emptyHint="还没有地点——先关闭这里，点右下角 + 把 TA 家标在图上"
          onPick={(p) => {
            upsertMapPlace({ ...p, boundCharacterId: modal.characterId });
            setModal(null); refresh(); flash(`「${p.name}」已是 TA 的家`);
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === "settings" && (
        <div className="fm-modal-mask" onClick={() => setModal(null)}>
          <div className="fm-modal" onClick={e => e.stopPropagation()}>
            <div className="fm-modal-head"><b>地图设置</b><button className="fm-icon-btn" onClick={() => setModal(null)}><X size={15} /></button></div>
            <div className="fm-field">
              <label>地图样式</label>
              <div className="fm-provider-row">
                {(Object.keys(TILE_PROVIDERS) as FindMyTileProvider[]).map(k => (
                  <button key={k} className="fm-chip-btn" data-active={settings.tileProvider === k ? "true" : undefined}
                    onClick={() => {
                      const next = { ...settings, tileProvider: k };
                      saveFindMySettings(next); setSettings(next);
                    }}>
                    {TILE_PROVIDERS[k].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="fm-field">
              <label>这座城市 {settings.cityAnchor ? `· ${settings.cityAnchor.label}` : ""}</label>
              <div className="fm-city-row">
                <input value={cityQuery} onChange={e => setCityQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") searchCity(); }}
                  placeholder="搜索城市（如：上海 / Tokyo）" />
                <button className="fm-chip-btn" onClick={searchCity} disabled={searching}>
                  <Search size={13} /> {searching ? "…" : "搜索"}
                </button>
                <button className="fm-chip-btn" onClick={locateMe} disabled={locating}>
                  <Crosshair size={13} /> 定位
                </button>
              </div>
              {cityResults.length > 0 && (
                <div className="fm-city-results">
                  {cityResults.map((r, i) => (
                    <button key={i} className="fm-city-result" onClick={() => pickCity(r)}>{r.label} · {r.country || `${r.lat.toFixed(2)},${r.lng.toFixed(2)}`}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="fm-field">
              <label>地点库 · {places.length}</label>
              <div className="fm-placelist">
                {places.map(p => (
                  <button key={p.id} className="fm-place-item" onClick={() => setModal({ kind: "place", lat: p.lat, lng: p.lng, place: p })}>
                    <span>{p.emoji || "📍"} {p.name}</span>
                    {p.boundCharacterId && <span className="fm-place-bound">🏠</span>}
                  </button>
                ))}
                {places.length === 0 && <span className="fm-people-empty">还没有地点</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatPresenceLabel(p: CharacterPresence): string {
  if (p.source === "schedule" && p.scheduleItem) {
    return `${p.place.emoji} ${p.place.name} · ${p.scheduleItem.title} 至 ${p.scheduleItem.endTime}`;
  }
  if (p.source === "override") return `${p.place.emoji} ${p.place.name}${p.note ? ` · ${p.note}` : ""}`;
  return `${p.place.emoji} ${p.place.name}`;
}

// ── 地点编辑/创建 Modal ──

function PlaceModal({ modal, characters, presetName, presetBind, onClose, onSaved, onDelete }: {
  modal: { lat: number; lng: number; place?: MapPlace };
  characters: Character[];
  presetName?: string;
  presetBind?: string;
  onClose: () => void;
  onSaved: (p: MapPlace) => void;
  onDelete?: () => void;
}) {
  const editing = modal.place;
  const [name, setName] = useState(editing?.name ?? presetName ?? "");
  const [emoji, setEmoji] = useState(editing?.emoji ?? "📍");
  const [keywords, setKeywords] = useState((editing?.keywords ?? []).join(","));
  const [bindCharId, setBindCharId] = useState(editing?.boundCharacterId ?? presetBind ?? "");

  return (
    <div className="fm-modal-mask" onClick={onClose}>
      <div className="fm-modal" onClick={e => e.stopPropagation()}>
        <div className="fm-modal-head">
          <b>{editing ? "编辑地点" : "标注地点"}</b>
          <button className="fm-icon-btn" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="fm-field">
          <label>名称</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如：健身房 / 公司 / 小美的家" autoFocus />
        </div>
        <div className="fm-field">
          <label>图标 emoji</label>
          <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="📍" className="fm-emoji-input" />
        </div>
        <div className="fm-field">
          <label>匹配词（逗号分隔）</label>
          <input value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="日程里的叫法，如：健身,锻炼,私教" />
          <span className="fm-field-hint">日程出现这些词时，角色自动显示在这里</span>
        </div>
        <div className="fm-field">
          <label>设为某人的家</label>
          <select value={bindCharId} onChange={e => setBindCharId(e.target.value)}>
            <option value="">（不是家）</option>
            {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="fm-modal-actions">
          {onDelete && <button className="fm-btn danger" onClick={onDelete}><Trash2 size={13} /> 删除</button>}
          <span style={{ flex: 1 }} />
          <button className="fm-btn ghost" onClick={onClose}>取消</button>
          <button className="fm-btn primary" disabled={!name.trim()} onClick={() => {
            onSaved({
              id: editing?.id ?? `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: name.trim(),
              emoji: emoji.trim() || "📍",
              lat: modal.lat, lng: modal.lng,
              keywords: keywords.split(/[,，]/).map(s => s.trim()).filter(Boolean),
              boundCharacterId: bindCharId || undefined,
              createdAt: editing?.createdAt ?? new Date().toISOString(),
            });
          }}>{editing ? "保存" : "标注"}</button>
        </div>
      </div>
    </div>
  );
}

// ── 地点选择 Modal ──

function PlacePickerModal({ title, places, emptyHint, onPick, onClear, onClose }: {
  title: string;
  places: MapPlace[];
  emptyHint: string;
  onPick: (p: MapPlace) => void;
  onClear?: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fm-modal-mask" onClick={onClose}>
      <div className="fm-modal" onClick={e => e.stopPropagation()}>
        <div className="fm-modal-head"><b>{title}</b><button className="fm-icon-btn" onClick={onClose}><X size={15} /></button></div>
        <div className="fm-placelist big">
          {places.map(p => (
            <button key={p.id} className="fm-place-item" onClick={() => onPick(p)}>
              <span>{p.emoji || "📍"} {p.name}</span>
              {p.boundCharacterId && <span className="fm-place-bound">🏠</span>}
            </button>
          ))}
          {places.length === 0 && <span className="fm-people-empty">{emptyHint}</span>}
        </div>
        {onClear && (
          <div className="fm-modal-actions">
            <button className="fm-btn ghost" onClick={onClear}>清除手动标记，恢复日程定位</button>
          </div>
        )}
      </div>
    </div>
  );
}
