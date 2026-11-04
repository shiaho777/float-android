"use client";

import { useState, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { Capacitor } from "@capacitor/core";
import ModelPalette from "./ModelPalette";
import PropertyPanel from "./PropertyPanel";
import GenerateModal from "./GenerateModal";
import ImportModal from "./ImportModal";
import * as THREE from "three";
import { type SceneObject, createSceneObject, PRESET_MODELS } from "./scene-store";
import { getAllModels, type UserModel } from "./model-db";
import { httpFetch } from "@/lib/native-http";
import SettingsModal, { useSceneSettings, isLightTheme } from "./SettingsModal";
import SceneSaveLoadModal from "./SceneSaveLoadModal";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";

const SceneViewport = lazy(() => import("./SceneViewport"));

export default function WorldBuilder() {
  const [objects, setObjects] = useState<SceneObject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [placingModel, setPlacingModel] = useState<{ url: string; name: string; characterId?: string } | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const { settings, update: updateSettings } = useSceneSettings();
  const [userModels, setUserModels] = useState<UserModel[]>([]);
  // 角色库（独立窗口页面需先水合 kv 才能读到）
  const [characters, setCharacters] = useState<Character[]>([]);
  // 点击化身名牌弹出的角色简介卡
  const [avatarCardId, setAvatarCardId] = useState<string | null>(null);
  const [showInitialBoot, setShowInitialBoot] = useState(true);
  const history = useRef<SceneObject[][]>([]);
  const future = useRef<SceneObject[][]>([]);

  const selected = objects.find((o) => o.id === selectedId) ?? null;

  // 加载用户模型
  const loadUserModels = useCallback(async () => {
    try {
      const models = await getAllModels();
      setUserModels(models);
    } catch (error) {
      console.warn("Failed to load world builder models", error);
      setUserModels([]);
    }
  }, []);

  useEffect(() => {
    loadUserModels();
  }, [loadUserModels]);

  useEffect(() => {
    let cancelled = false;
    hydrateKvDb()
      .catch(() => undefined)
      .then(() => { if (!cancelled) setCharacters(loadCharacters()); });
    return () => { cancelled = true; };
  }, []);

  const hideInitialBoot = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setShowInitialBoot(false));
    });
  }, []);

  const handleInitialBootBack = useCallback(() => {
    // 原生端筑境是同窗口导航进来的，返回也只能整页重载（IDB 连接使 bfcache 不生效）。
    // 标记让主界面跳过一次引导动画，回来直接落桌面。
    if (Capacitor.isNativePlatform()) {
      try { sessionStorage.setItem("pneuma_skip_splash_once", "1"); } catch { /* ignore */ }
      window.location.replace("/");
      return;
    }
    if (window.opener && !window.opener.closed) {
      window.opener.focus();
    }
    window.close();
    window.setTimeout(() => {
      if (!window.closed) window.location.replace("/");
    }, 40);
  }, []);

  // 所有分类（预设 + 用户）
  const allCategories = [
    ...new Set([
      ...PRESET_MODELS.map((m) => m.category),
      ...userModels.map((m) => m.category),
    ]),
  ];

  // 每次 objects 变更前存快照
  const pushHistory = useCallback(() => {
    history.current.push(objects.map((o) => ({ ...o })));
    if (history.current.length > 50) history.current.shift();
    future.current = [];
  }, [objects]);

  const handleUndo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) {
      future.current.push(objects.map((o) => ({ ...o })));
      setObjects(prev);
      setSelectedId(null);
    }
  }, [objects]);

  const handleRedo = useCallback(() => {
    const next = future.current.pop();
    if (next) {
      history.current.push(objects.map((o) => ({ ...o })));
      setObjects(next);
      setSelectedId(null);
    }
  }, [objects]);

  const handlePalettePlace = useCallback((url: string, name: string, characterId?: string) => {
    setPlacingModel({ url, name, characterId });
    setSelectedId(null);
  }, []);

  const handlePlace = useCallback(
    (position: [number, number, number]) => {
      if (!placingModel) return;
      const obj = createSceneObject(placingModel.url, placingModel.name, position, placingModel.characterId);
      pushHistory();
      setObjects((prev) => [...prev, obj]);
      setSelectedId(obj.id);
      setPlacingModel(null);
    },
    [placingModel]
  );

  const handleTransformEnd = useCallback(
    (id: string, pos: [number, number, number], rot: [number, number, number], scale: [number, number, number]) => {
      pushHistory();
      setObjects((prev) =>
        prev.map((o) => (o.id === id ? { ...o, position: pos, rotation: rot, scale } : o))
      );
    },
    [pushHistory]
  );

  const handleUpdate = useCallback((id: string, changes: Partial<SceneObject>) => {
    pushHistory();
    setObjects((prev) => prev.map((o) => (o.id === id ? { ...o, ...changes } : o)));
  }, [pushHistory]);

  const handleDelete = useCallback(
    (id: string) => {
      pushHistory();
      setObjects((prev) => prev.filter((o) => o.id !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [selectedId]
  );

  const handleArray = useCallback(
    (id: string, axis: 0 | 1 | 2, count: number, spacing: number) => {
      const source = objects.find((o) => o.id === id);
      if (!source || spacing === 0) return;
      pushHistory();

      const localDir = new THREE.Vector3(
        axis === 0 ? 1 : 0,
        axis === 1 ? 1 : 0,
        axis === 2 ? 1 : 0
      );
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...source.rotation));
      localDir.applyQuaternion(q);

      const newObjs: SceneObject[] = [];
      for (let i = 1; i < count; i++) {
        const offset = localDir.clone().multiplyScalar(spacing * i);
        const pos: [number, number, number] = [
          source.position[0] + offset.x,
          source.position[1] + offset.y,
          source.position[2] + offset.z,
        ];
        const obj = createSceneObject(source.modelUrl, source.name, pos, source.characterId);
        obj.rotation = [...source.rotation];
        obj.scale = [...source.scale];
        newObjs.push(obj);
      }
      setObjects((prev) => [...prev, ...newObjs]);
    },
    [objects]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlacingModel(null);
      if (e.key === "Delete" && selectedId) handleDelete(selectedId);
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "z") { e.preventDefault(); handleRedo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); handleUndo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, handleDelete, handleUndo, handleRedo]);

  return (
    <div className={`wb-layout ${isLightTheme(settings.theme) ? "wb-light" : ""} ${showInitialBoot ? "wb-layout--booting" : ""}`}>
      <div className="wb-topbar">
          <button className="wb-topbar-btn" onClick={handleInitialBootBack}>
            返回
          </button>
          <button className="wb-topbar-btn" onClick={handleUndo} disabled={history.current.length === 0}>
            撤销
          </button>
          <button className="wb-topbar-btn" onClick={handleRedo} disabled={future.current.length === 0}>
            重做
          </button>
          <button className="wb-topbar-btn" onClick={() => setShowImport(true)}>
            导入模型
          </button>
          <button
            className="wb-topbar-btn"
            disabled={!selectedId}
            onClick={async () => {
              if (!selected) return;
              try {
                let blob: Blob;
                if (selected.modelUrl.startsWith("blob:")) {
                  const res = await fetch(selected.modelUrl);
                  blob = await res.blob();
                } else {
                  const res = await httpFetch(selected.modelUrl);
                  blob = await res.blob();
                }
                const { downloadFile } = await import("@/lib/download-utils");
                await downloadFile(blob, `${selected.name}.glb`);
              } catch (e: any) {
                alert("导出失败: " + e.message);
              }
            }}
          >
            导出模型
          </button>
          <button className="wb-topbar-btn" onClick={() => setShowGenerate(true)}>
            生成模型
          </button>
          <button className="wb-topbar-btn" onClick={() => setShowSave(true)}>
            保存场景
          </button>
          <button className="wb-topbar-btn" onClick={() => setShowLoad(true)}>
            加载场景
          </button>
          <button className="wb-topbar-btn" onClick={() => setShowSettings(true)}>
            偏好设置
          </button>
      </div>

      <Suspense fallback={null}>
      <SceneViewport
        objects={objects}
        selectedId={selectedId}
        placingModel={placingModel}
        settings={settings}
        onSelect={setSelectedId}
        onPlace={handlePlace}
        onTransformEnd={handleTransformEnd}
        onSceneMounted={hideInitialBoot}
        characterNameById={new Map(characters.map((c) => [c.id, c.name || "未命名"]))}
        onCharacterTap={setAvatarCardId}
      />
      </Suspense>

      {showInitialBoot && (
        <div className="wb-initial-boot" role="status" aria-live="polite">
          <div className="wb-initial-center">
            <div className="wb-initial-mark" aria-hidden="true">
              <span />
            </div>
            <div className="wb-initial-copy">
              <span>World Builder</span>
              <h1>正在搭建筑境</h1>
              <p>场景出现后会自动进入。</p>
            </div>
            <button className="wb-initial-back" type="button" onClick={handleInitialBootBack}>
              返回小手机
            </button>
          </div>
        </div>
      )}

      <div className="wb-bottom-bar">
        <ModelPalette userModels={userModels} onPlace={handlePalettePlace} />
      </div>

      <PropertyPanel
        selected={selected}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onArray={handleArray}
      />

      <GenerateModal
        open={showGenerate}
        categories={allCategories}
        characters={characters}
        onClose={() => setShowGenerate(false)}
        onModelAdded={loadUserModels}
      />

      <ImportModal
        open={showImport}
        categories={allCategories}
        onClose={() => setShowImport(false)}
        onModelAdded={loadUserModels}
      />

      <SettingsModal
        open={showSettings}
        settings={settings}
        onUpdate={updateSettings}
        onClose={() => setShowSettings(false)}
      />

      <SceneSaveLoadModal
        open={showSave}
        mode="save"
        currentObjects={objects}
        onLoad={() => {}}
        onClose={() => setShowSave(false)}
      />

      {avatarCardId && (() => {
        const card = characters.find((c) => c.id === avatarCardId);
        return (
          <div className="wb-avatar-card-overlay" onClick={() => setAvatarCardId(null)}>
            <div className="wb-avatar-card" onClick={(e) => e.stopPropagation()}>
              <div className="wb-avatar-card-photo">
                {card?.avatar
                  ? <img src={card.avatar} alt="" />
                  : <span>{(card?.name || "?").slice(0, 1)}</span>}
              </div>
              <div className="wb-avatar-card-name">{card?.name || "未知角色"}</div>
              <p className="wb-avatar-card-brief">
                {card ? (card.briefPersona?.trim() || card.personality?.trim() || "还没有简介，可在角色档案里生成简量人设。") : "该角色档案已不存在。"}
              </p>
              <button className="wb-topbar-btn" onClick={() => setAvatarCardId(null)}>关闭</button>
            </div>
          </div>
        );
      })()}

      <SceneSaveLoadModal
        open={showLoad}
        mode="load"
        currentObjects={objects}
        onLoad={(objs) => {
          pushHistory();
          setObjects(objs);
          setSelectedId(null);
        }}
        onClose={() => setShowLoad(false)}
      />
    </div>
  );
}
