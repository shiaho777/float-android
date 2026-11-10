"use client";

import { useState, useRef, useEffect } from "react";
import { saveModel } from "./model-db";
import { optimizeModelBlob } from "./model-optimize";
import { kvGet, kvSet } from "@/lib/kv-db";
import type { Character } from "@/lib/character-types";
import { tripoCreateTask, tripoTaskStatus, tripoUploadImage, tripoVerifyKey } from "./tripo-client";
import { httpFetch } from "@/lib/native-http";

interface Props {
  open: boolean;
  categories: string[];
  /** 角色库（角色化身模式用） */
  characters?: Character[];
  onClose: () => void;
  onModelAdded: () => void;
}

const API_KEY_STORAGE = "wb-tripo-api-key";

export default function GenerateModal({ open, categories, characters = [], onClose, onModelAdded }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<"" | "checking" | "ok" | "fail">("");
  const [mode, setMode] = useState<"text" | "image" | "avatar">("text");
  // 角色化身模式：选中的角色 + 图片来源（角色头像 / 上传立绘）
  const [avatarCharacterId, setAvatarCharacterId] = useState("");
  const [avatarSource, setAvatarSource] = useState<"avatar" | "upload">("upload");
  // 生成后自动绑骨+走路动画（额外消耗额度；化身可在场景中漫步）
  const [animateAvatar, setAnimateAvatar] = useState(true);
  const avatarCharacter = characters.find((c) => c.id === avatarCharacterId) ?? null;
  const [prompt, setPrompt] = useState("");
  const [faceLimit, setFaceLimit] = useState<number>(0);
  const [simplifyRatio, setSimplifyRatio] = useState<number>(15); // 存整数百分比，避免浮点问题
  const [status, setStatus] = useState<"idle" | "generating" | "done" | "failed">("idle");
  const [progress, setProgress] = useState("");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [modelName, setModelName] = useState("");
  const [category, setCategory] = useState("导入");
  const [customCat, setCustomCat] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = kvGet(API_KEY_STORAGE);
    if (stored) setApiKey(stored);
  }, []);

  function saveApiKey(key: string) {
    setApiKey(key);
    setKeyStatus("");
    kvSet(API_KEY_STORAGE, key);
  }

  async function verifyApiKey() {
    if (!apiKey.trim()) return;
    setKeyStatus("checking");
    try {
      const data = await tripoVerifyKey(apiKey);
      setKeyStatus(data.ok ? "ok" : "fail");
      if (data.ok && data.balance != null) {
        setProgress(`余额: ${data.balance}`);
      }
    } catch (e: any) {
      setKeyStatus("fail");
      setProgress(e?.message || "验证失败");
    }
  }

  /** 上传图片并创建 image_to_model / multiview_to_model 任务。 */
  async function tripoCreateImageTask(apiKey: string, files: File[], faceLimit: number): Promise<string> {
    const uploads = await Promise.all(files.map((f) => tripoUploadImage(apiKey, f)));
    if (uploads.length === 1) {
      return tripoCreateTask(apiKey, {
        type: "image_to_model",
        file: { type: uploads[0].type, file_token: uploads[0].token },
        ...(faceLimit > 0 ? { face_limit: faceLimit } : {}),
      });
    }
    return tripoCreateTask(apiKey, {
      type: "multiview_to_model",
      files: uploads.map((u) => ({ type: u.type, file_token: u.token })),
      ...(faceLimit > 0 ? { face_limit: faceLimit } : {}),
    });
  }

  const STATUS_TEXT: Record<string, string> = {
    queued: "排队中", running: "生成中", success: "完成", failed: "失败", pending: "等待中",
  };

  /** 轮询任务状态（8s 间隔省函数调用；页面切后台时暂停）。成功返回结果（含 Tripo 模型直链），失败抛错。 */
  async function pollTaskStatus(taskId: string, stageLabel: string): Promise<{ modelUrl?: string }> {
    let consecutiveErrors = 0;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 8000));
      if (typeof document !== "undefined" && document.hidden) { i--; continue; }
      let data: import("./tripo-client").TripoTaskStatusResult;
      try {
        data = await tripoTaskStatus(apiKey, taskId);
      } catch (e: any) {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error(`${stageLabel}状态查询失败：${e?.message || "网络错误"}`, { cause: e });
        }
        setProgress(`${stageLabel}·状态查询重试中…`);
        continue;
      }
      if (data.status === "success") return data;
      if (data.status === "failed" || data.status === "cancelled" || data.status === "banned" || data.status === "expired") {
        throw new Error(data.error || `${stageLabel}失败（${data.status}）`);
      }
      if (!data.status) {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) {
          throw new Error(`${stageLabel}状态查询失败：任务状态缺失`);
        }
        setProgress(`${stageLabel}·状态查询重试中…`);
        continue;
      }
      consecutiveErrors = 0;
      const label = STATUS_TEXT[data.status] || data.status;
      const elapsed = Math.round(((i + 1) * 8) / 60 * 10) / 10;
      setProgress((data.progress ?? 0) > 0 ? `${stageLabel}·${label} ${data.progress}%` : `${stageLabel}·${label}（已等待 ${elapsed} 分钟）`);
    }
    throw new Error(`${stageLabel}超时`);
  }

  /** 浏览器直连 Tripo 下载模型 + 客户端减面/缩贴图（不经过服务器，不耗 Netlify 额度）。 */
  async function downloadAndOptimize(modelUrl: string, hasAnimation: boolean): Promise<Blob> {
    setProgress("下载模型…");
    const glbRes = await httpFetch(modelUrl);
    if (!glbRes.ok) throw new Error("模型下载失败");
    const raw = await glbRes.blob();
    return optimizeModelBlob(raw, {
      ratio: simplifyRatio / 100,
      textureSize: 512,
      hasAnimation,
      onProgress: setProgress,
    });
  }

  async function pollAndDownload(taskId: string) {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 8000));
      if (typeof document !== "undefined" && document.hidden) { i--; continue; }
      let data: import("./tripo-client").TripoTaskStatusResult;
      try {
        data = await tripoTaskStatus(apiKey, taskId);
      } catch (e: any) {
        setStatus("failed");
        setProgress(e?.message || "状态查询失败");
        return;
      }
      const s = data.status || "等待中";
      const statusText: Record<string, string> = {
        queued: "排队中",
        running: "生成中",
        success: "完成",
        failed: "失败",
        pending: "等待中",
      };
      const label = statusText[s] || s;
      const pct = data.progress;
      setProgress(pct != null && pct > 0 ? `${label} ${pct}%` : label);

      if (data.status === "success" && data.modelUrl) {
        // 浏览器直连 Tripo 下载 + 客户端优化；跨域被拒时给手动下载兜底
        try {
          const blob = await downloadAndOptimize(data.modelUrl, false);
          setResultBlob(blob);
          setStatus("done");
          return;
        } catch {
          setResultUrl(data.modelUrl);
          setStatus("failed");
          setProgress("自动下载失败，请手动下载后通过「导入模型」添加");
          return;
        }
      }
      if (data.status === "failed" || data.status === "cancelled") {
        setStatus("failed");
        setProgress(data.error || "生成失败");
        return;
      }
    }
    setStatus("failed");
    setProgress("超时");
  }

  async function handleGenerate() {
    if (!apiKey.trim()) { setProgress("请先填写 API Key"); return; }
    setStatus("generating");
    setProgress("提交中...");

    try {
      if (mode === "avatar") {
        if (!avatarCharacter) { setProgress("请先选择角色"); setStatus("idle"); return; }
        let files: File[] = imageFiles;
        if (avatarSource === "avatar") {
          if (!avatarCharacter.avatar) { setProgress("该角色没有头像，请改用上传立绘"); setStatus("idle"); return; }
          const imgRes = await fetch(avatarCharacter.avatar);
          if (!imgRes.ok) throw new Error("头像读取失败，请改用上传立绘");
          const blob = await imgRes.blob();
          files = [new File([blob], "avatar.png", { type: blob.type || "image/png" })];
        }
        if (files.length === 0) { setProgress("请上传该角色的全身立绘"); setStatus("idle"); return; }
        setModelName(`${avatarCharacter.name || "角色"}·化身`);
        const taskId = await tripoCreateImageTask(apiKey, files, faceLimit);
        if (animateAvatar) {
          // 动画链：基础模型（不落盘）→ 自动绑骨 → 套走路动画（跳过减面，保护骨骼）
          await pollTaskStatus(taskId, "基础模型");
          setProgress("提交自动绑骨…");
          const rigTaskId = await tripoCreateTask(apiKey, { type: "animate_rig", original_model_task_id: taskId });
          await pollTaskStatus(rigTaskId, "自动绑骨");
          setProgress("提交走路动画…");
          const retargetTaskId = await tripoCreateTask(apiKey, { type: "animate_retarget", original_model_task_id: rigTaskId, animation: "preset:walk" });
          const finalData = await pollTaskStatus(retargetTaskId, "走路动画");
          if (!finalData.modelUrl) throw new Error("动画模型下载失败");
          // 动画模型跳过几何操作（保护骨骼蒙皮），只缩贴图
          setResultBlob(await downloadAndOptimize(finalData.modelUrl, true));
          setStatus("done");
        } else {
          setProgress("生成中...");
          await pollAndDownload(taskId);
        }
      } else if (mode === "text") {
        if (!prompt.trim()) { setProgress("请输入描述"); setStatus("idle"); return; }
        setModelName(prompt.trim());
        const taskId = await tripoCreateTask(apiKey, {
          type: "text_to_model",
          prompt: prompt.trim(),
          ...(faceLimit > 0 ? { face_limit: faceLimit } : {}),
        });
        setProgress("生成中...");
        await pollAndDownload(taskId);
      } else {
        if (imageFiles.length === 0) { setProgress("请选择图片"); setStatus("idle"); return; }
        setModelName(imageFiles[0].name.replace(/\.\w+$/, ""));
        const taskId = await tripoCreateImageTask(apiKey, imageFiles, faceLimit);
        setProgress("生成中...");
        await pollAndDownload(taskId);
      }
    } catch (e: any) {
      setStatus("failed");
      setProgress(e.message);
    }
  }

  async function handleAddToLibrary() {
    if (!resultBlob) return;
    const isAvatar = mode === "avatar" && !!avatarCharacter;
    const cat = isAvatar ? "角色" : (customCat.trim() || category);
    await saveModel({
      name: modelName || "未命名",
      category: cat,
      blob: resultBlob,
      ...(isAvatar ? { characterId: avatarCharacter.id } : {}),
    });
    onModelAdded();
    resetAndClose();
  }

  function resetAndClose() {
    setStatus("idle");
    setProgress("");
    setResultUrl(null);
    setResultBlob(null);
    setPrompt("");
    setImageFiles([]);
    setModelName("");
    setCustomCat("");
    setAvatarCharacterId("");
    setAvatarSource("upload");
    setAnimateAvatar(true);
    onClose();
  }

  if (!open) return null;

  return (
    <div className="wb-modal-overlay" onClick={resetAndClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb-modal-header">
          <span>生成模型</span>
          <button className="wb-float-close" onClick={resetAndClose}>✕</button>
        </div>

        {/* API Key */}
        <div className="wb-modal-section">
          <label className="wb-modal-label">API Key</label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="wb-modal-input"
              style={{ flex: 1 }}
              type="password"
              placeholder="输入 Tripo API Key"
              value={apiKey}
              onChange={(e) => saveApiKey(e.target.value)}
            />
            <button
              className="wb-modal-btn"
              style={{ width: "auto", padding: "8px 12px", flexShrink: 0 }}
              onClick={verifyApiKey}
              disabled={!apiKey.trim() || keyStatus === "checking"}
            >
              {keyStatus === "checking" ? "验证中" : "验证"}
            </button>
          </div>
          {keyStatus === "ok" && <span className="wb-modal-hint" style={{ color: "rgba(100,220,140,0.8)" }}>已连接</span>}
          {keyStatus === "fail" && <span className="wb-modal-hint" style={{ color: "rgba(255,120,100,0.8)" }}>连接失败，请检查 Key</span>}
        </div>

        {/* 模式切换 */}
        <div className="wb-modal-section">
          <div className="wb-modal-tabs">
            <button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>文字生成</button>
            <button className={mode === "image" ? "active" : ""} onClick={() => setMode("image")}>图片生成</button>
            <button
              className={mode === "avatar" ? "active" : ""}
              onClick={() => {
                setMode("avatar");
                // 化身跳过后处理减面（保护骨骼蒙皮），face_limit 是唯一控面手段；
                // 不限面时 Tripo 原始输出 20 万+ 面，实时骨骼动画太重——默认 4 万
                if (faceLimit === 0) setFaceLimit(40000);
              }}
            >角色化身</button>
          </div>
        </div>

        {/* 面数控制 */}
        <div className="wb-modal-section">
          <label className="wb-modal-label">生成面数（0 = 不限制）</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              className="wb-scale-slider"
              type="range"
              min={0}
              max={50000}
              step={1000}
              value={faceLimit}
              onChange={(e) => setFaceLimit(parseInt(e.target.value))}
            />
            <span className="wb-scale-value" style={{ minWidth: 40 }}>{faceLimit || "无限"}</span>
          </div>
        </div>

        <div className="wb-modal-section">
          <label className="wb-modal-label">重拓扑保留比例（{simplifyRatio}%）</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              className="wb-scale-slider"
              type="range"
              min={5}
              max={100}
              step={5}
              value={simplifyRatio}
              onChange={(e) => setSimplifyRatio(parseInt(e.target.value))}
            />
            <span className="wb-scale-value">{simplifyRatio}%</span>
          </div>
        </div>

        {/* 输入 */}
        <div className="wb-modal-section">
          {mode === "avatar" ? (
            <>
              <label className="wb-modal-label">选择角色</label>
              <select
                className="wb-modal-input"
                value={avatarCharacterId}
                onChange={(e) => setAvatarCharacterId(e.target.value)}
                disabled={status === "generating"}
              >
                <option value="">请选择…</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name || "未命名角色"}</option>
                ))}
              </select>
              <div className="wb-modal-tabs" style={{ marginTop: 8 }}>
                <button
                  className={avatarSource === "upload" ? "active" : ""}
                  onClick={() => setAvatarSource("upload")}
                  disabled={status === "generating"}
                >上传立绘（推荐）</button>
                <button
                  className={avatarSource === "avatar" ? "active" : ""}
                  onClick={() => setAvatarSource("avatar")}
                  disabled={status === "generating"}
                >用角色头像</button>
              </div>
              {avatarSource === "upload" ? (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      if (files.length) setImageFiles((prev) => [...prev, ...files]);
                    }}
                  />
                  <button
                    className="wb-modal-btn"
                    style={{ marginTop: 8 }}
                    onClick={() => fileRef.current?.click()}
                    disabled={status === "generating"}
                  >
                    选择立绘图片（可多选多视角）
                  </button>
                  {imageFiles.length > 0 && (
                    <div className="wb-modal-images">
                      {imageFiles.map((f, i) => (
                        <div key={i} className="wb-modal-img-item">
                          <img src={URL.createObjectURL(f)} alt={f.name} />
                          <button onClick={() => setImageFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                avatarCharacter?.avatar
                  ? <div className="wb-modal-images" style={{ marginTop: 8 }}><div className="wb-modal-img-item"><img src={avatarCharacter.avatar} alt="" /></div></div>
                  : <span className="wb-modal-hint" style={{ marginTop: 8 }}>该角色没有头像，请改用上传立绘</span>
              )}
              <label className="wb-modal-hint" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={animateAvatar}
                  onChange={(e) => setAnimateAvatar(e.target.checked)}
                  disabled={status === "generating"}
                />
                生成后自动绑骨+走路动画（多消耗额度，化身可在场景中走动）
              </label>
              <span className="wb-modal-hint">
                立绘建议：全身、自然站姿/T-pose、无遮挡——大头照会生成奇怪的半身像
              </span>
            </>
          ) : mode === "text" ? (
            <input
              className="wb-modal-input"
              placeholder="描述你想要的物体..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && status === "idle" && handleGenerate()}
              disabled={status === "generating"}
            />
          ) : (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) setImageFiles((prev) => [...prev, ...files]);
                }}
              />
              <button
                className="wb-modal-btn"
                onClick={() => fileRef.current?.click()}
                disabled={status === "generating"}
              >
                选择图片（可多选）
              </button>
              {imageFiles.length > 0 && (
                <div className="wb-modal-images">
                  {imageFiles.map((f, i) => (
                    <div key={i} className="wb-modal-img-item">
                      <img src={URL.createObjectURL(f)} alt={f.name} />
                      <button onClick={() => setImageFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <span className="wb-modal-hint">
                1张=单图生成 · 多张=多视角生成（效果更好）
              </span>
            </>
          )}
        </div>

        {/* 生成按钮 */}
        {status === "idle" && (
          <button className="wb-modal-btn wb-modal-primary" onClick={handleGenerate}>
            开始生成
          </button>
        )}

        {/* 进度 */}
        {progress && <div className="wb-modal-progress">{progress}</div>}

        {/* 下载失败提示 */}
        {status === "failed" && resultUrl && (
          <a href={resultUrl} target="_blank" rel="noreferrer" className="wb-modal-link">
            手动下载模型
          </a>
        )}

        {/* 生成完成：添加到库 */}
        {status === "done" && resultBlob && (
          <div className="wb-modal-result">
            <div className="wb-modal-section">
              <label className="wb-modal-label">模型名称</label>
              <input
                className="wb-modal-input"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              />
            </div>
            <div className="wb-modal-section">
              <label className="wb-modal-label">分类</label>
              <div className="wb-modal-cat-list">
                {[...categories, "自定义"].map((c) => (
                  <button
                    key={c}
                    className={`wb-modal-cat ${category === c ? "active" : ""}`}
                    onClick={() => { setCategory(c); if (c !== "自定义") setCustomCat(""); }}
                  >{c}</button>
                ))}
              </div>
              {category === "自定义" && (
                <input
                  className="wb-modal-input"
                  placeholder="输入新分类名"
                  value={customCat}
                  onChange={(e) => setCustomCat(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              )}
            </div>
            <div className="wb-modal-actions">
              <button className="wb-modal-btn wb-modal-primary" onClick={handleAddToLibrary}>添加到库</button>
              <button className="wb-modal-btn" onClick={resetAndClose}>丢弃</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
