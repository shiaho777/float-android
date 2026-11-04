"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  FileJson,
  HardDrive,
  ImageIcon,
  Info,
  Layers,
  Pencil,
  PackageCheck,
  RefreshCw,
  Search,
  LoaderCircle,
  Sparkles,
  Store,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { customAppGlyphPath } from "@/components/icon-glyph";

import { CUSTOM_APP_CREATOR_GUIDE_MD } from "@/lib/custom-app-creator-guide";
import { permissionLabelWithContext } from "@/lib/custom-app-permission-labels";
import {
  applyCustomAppRegistrationsAsync,
  formatCustomAppRegistrationRemovalSummary,
  formatCustomAppRegistrationSummary,
  removeCustomAppRegistrationsAsync,
} from "@/lib/custom-app-registration";
import {
  CUSTOM_APPS_UPDATED_EVENT,
  installCustomAppAsync,
  loadCustomAppPackage,
  loadInstalledCustomApps,
  loadSingleHtmlCustomApp,
  normalizeCustomAppManifestId,
  saveInstalledCustomApps,
  uninstallCustomAppAsync,
  getCustomAppIconStyle,
  setCustomAppIconStyle,
  type CustomAppIconStyle,
} from "@/lib/custom-app-storage";
import type { CustomAppManifest, CustomAppPermission, CustomAppResourceDeclarations, InstalledCustomApp } from "@/lib/custom-app-types";
import { createCustomAppPackageFile } from "@/lib/custom-app-package";
import { downloadFile } from "@/lib/download-utils";

type AppMarketAppProps = {
  onClose: () => void;
  onOpenCustomApp: (appId: string) => void;
  onInstallToDesktop: (app: InstalledCustomApp) => void;
  onNotice?: (message: string) => void;
  launchContext?: Record<string, unknown> | null;
};

type AppMarketTab = "installed" | "create";

type ManualUploadFiles = {
  manifest: File | null;
  entry: File | null;
  icon: File | null;
  presets: File | null;
  regex: File | null;
  worldBooks: File | null;
  bindings: File | null;
  assets: File[];
};

const EMPTY_MANUAL_FILES: ManualUploadFiles = {
  manifest: null,
  entry: null,
  icon: null,
  presets: null,
  regex: null,
  worldBooks: null,
  bindings: null,
  assets: [],
};

const DECLARATION_FILES = [
  { file: "presets.json", label: "预设", icon: Layers },
  { file: "regex.json", label: "正则", icon: Sparkles },
  { file: "worldbooks.json", label: "世界书", icon: FileJson },
  { file: "bindings.json", label: "默认绑定", icon: CheckCircle2 },
] as const;

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatPackageSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "未知大小";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePackagePath(value: string, fallback: string): string {
  const text = (value || fallback).replace(/\\/g, "/").replace(/^\.?\//, "").replace(/^\/+/, "").trim();
  return text || fallback;
}

function resourceKeyForPath(path: string): keyof CustomAppResourceDeclarations | null {
  const file = path.split("/").pop()?.toLowerCase() ?? "";
  if (file === "presets.json") return "presets";
  if (file === "regex.json" || file === "regexes.json") return "regexes";
  if (file === "worldbook.json" || file === "worldbooks.json") return "worldBooks";
  if (file === "bindings.json") return "bindings";
  if (file === "tools.json") return "tools";
  if (file === "voices.json") return "voices";
  return null;
}

function appendResourcePath(resources: CustomAppResourceDeclarations, key: keyof CustomAppResourceDeclarations, path: string): void {
  const current = resources[key] ?? [];
  if (!current.includes(path)) resources[key] = [...current, path];
}

function replaceResourcePath(resources: CustomAppResourceDeclarations, key: keyof CustomAppResourceDeclarations, path: string): void {
  resources[key] = path ? [path] : [];
}

function normalizeManualResources(value: unknown): CustomAppResourceDeclarations {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as CustomAppResourceDeclarations : {};
  return {
    presets: [...(record.presets ?? [])],
    regexes: [...(record.regexes ?? [])],
    worldBooks: [...(record.worldBooks ?? [])],
    bindings: [...(record.bindings ?? [])],
    tools: [...(record.tools ?? [])],
    voices: [...(record.voices ?? [])],
    assets: [...(record.assets ?? [])],
  };
}

function appWithVersion(app: InstalledCustomApp, versionInput: string): InstalledCustomApp {
  const version = versionInput.trim() || app.version || "1.0.0";
  return {
    ...app,
    version,
    manifest: {
      ...app.manifest,
      version,
      permissions: app.permissions,
    },
  };
}

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return new Uint8Array();
  const meta = dataUrl.slice(0, comma).toLowerCase();
  const payload = dataUrl.slice(comma + 1);
  if (meta.includes(";base64")) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

function resourcePathsForKey(resources: CustomAppResourceDeclarations, key: keyof CustomAppResourceDeclarations): string[] {
  return (resources[key] ?? []).map(path => normalizePackagePath(path, path)).filter(Boolean);
}

function findAssetPath(app: InstalledCustomApp | null, filename: string): string {
  if (!app) return "";
  const lower = filename.toLowerCase();
  return Object.values(app.assets).find(asset => asset.path.toLowerCase() === lower)?.path ?? "";
}

function existingDeclarationPath(
  app: InstalledCustomApp | null,
  manifest: CustomAppManifest | undefined,
  key: keyof CustomAppResourceDeclarations,
  fallback: string,
): string {
  const fromManifest = manifest ? resourcePathsForKey(normalizeManualResources(manifest.resources), key)[0] : "";
  return fromManifest || findAssetPath(app, fallback);
}

function existingOtherAssetPaths(app: InstalledCustomApp | null, manifest: CustomAppManifest | undefined): string[] {
  const resources = normalizeManualResources(manifest?.resources);
  const reserved = new Set([
    "manifest.json",
    normalizePackagePath(manifest?.entry || "index.html", "index.html"),
    normalizePackagePath(manifest?.icon || "icon.png", "icon.png"),
    "presets.json",
    "regex.json",
    "worldbooks.json",
    "bindings.json",
    ...resourcePathsForKey(resources, "presets"),
    ...resourcePathsForKey(resources, "regexes"),
    ...resourcePathsForKey(resources, "worldBooks"),
    ...resourcePathsForKey(resources, "bindings"),
  ].map(path => path.toLowerCase()));
  const paths = new Set<string>();
  for (const path of resourcePathsForKey(resources, "assets")) {
    const normalized = normalizePackagePath(path, path);
    if (normalized && !reserved.has(normalized.toLowerCase())) paths.add(normalized);
  }
  if (app) {
    for (const asset of Object.values(app.assets)) {
      const normalized = normalizePackagePath(asset.path, asset.path);
      if (normalized && !reserved.has(normalized.toLowerCase())) paths.add(normalized);
    }
  }
  return Array.from(paths);
}

function fileSlotLabel(selected: File | null, existingPath: string, fallback: string, loading = false): string {
  if (selected) return selected.name;
  if (existingPath) return `当前：${existingPath}`;
  if (loading) return "正在读取线上文件…";
  return fallback;
}

function assetSlotLabel(selected: File[], existingPaths: string[], fallback: string, loading = false): string {
  if (selected.length > 0) return `${selected.length} 个文件`;
  if (existingPaths.length > 0) {
    const preview = existingPaths.slice(0, 2).join("、");
    return existingPaths.length > 2 ? `当前：${existingPaths.length} 个资源 · ${preview}…` : `当前：${preview}`;
  }
  if (loading) return "正在读取线上文件…";
  return fallback;
}

function appNameFromEntryPath(path: string): string {
  const filename = path.split("/").pop() || "custom-app";
  return filename.replace(/\.[^.]+$/, "").trim() || "custom-app";
}


function hasDeclaration(app: InstalledCustomApp | null, filename: string): boolean {
  if (!app) return false;
  return Object.values(app.assets).some(asset => asset.path.toLowerCase() === filename.toLowerCase());
}

function declarationCount(app: InstalledCustomApp | null): number {
  return DECLARATION_FILES.filter(item => hasDeclaration(app, item.file)).length;
}

// 没传图标的 APP:按名字哈希稳定地选一个 mdi 字形——和桌面图标同一套形状体系,
// 同一个 APP 在市场/桌面/已安装各处字形一致;颜色沿用市场页原来的统一蓝,不花哨。
function AppIcon({ iconDataUrl, seed = "", className = "" }: {
  iconDataUrl?: string;
  seed?: string;
  className?: string;
}) {
  if (iconDataUrl) {
    return (
      <span className={`app-market-app-icon ${className}`}>
        <img src={iconDataUrl} alt="" />
      </span>
    );
  }
  return (
    <span className={`app-market-app-icon ${className}`}>
      <svg viewBox="0 0 24 24" style={{ width: "58%", height: "58%" }} aria-hidden>
        <path d={customAppGlyphPath(seed)} fill="currentColor" />
      </svg>
    </span>
  );
}

export function AppMarketApp({ onClose, onOpenCustomApp, onInstallToDesktop, onNotice, launchContext }: AppMarketAppProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const repackInputRef = useRef<HTMLInputElement | null>(null);
  const manualLoadSeqRef = useRef(0);
  const consumedLaunchTargetRef = useRef("");
  const [tab, setTab] = useState<AppMarketTab>("installed");
  const [apps, setApps] = useState<InstalledCustomApp[]>(() => loadInstalledCustomApps());
  const [pendingApp, setPendingApp] = useState<InstalledCustomApp | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [selectedInstalledApp, setSelectedInstalledApp] = useState<InstalledCustomApp | null>(null);
  // 本地测试 APP 的"编辑"目标：保存时按它的运行时 id 原地替换（数据保留，仅本地）
  const [localEditTarget, setLocalEditTarget] = useState<InstalledCustomApp | null>(null);
  // 本地测试「换包」目标：点按钮直接弹系统文件选择器（与已发布换包一致），选完即原地替换（仅本地，不影响市场版）
  const [repackTarget, setRepackTarget] = useState<InstalledCustomApp | null>(null);
  const [publishVersion, setPublishVersion] = useState("");
  const [manualFiles, setManualFiles] = useState<ManualUploadFiles>(EMPTY_MANUAL_FILES);
  const [manualFileInputKey, setManualFileInputKey] = useState(0);
  const [manualExistingApp, setManualExistingApp] = useState<InstalledCustomApp | null>(null);
  const [manualExistingLoading, setManualExistingLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);
  const [installedActionError, setInstalledActionError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<InstalledCustomApp | null>(null);
  const [creatorGuideOpen, setCreatorGuideOpen] = useState(false);
  const [manualBuilderOpen, setManualBuilderOpen] = useState(false);

  const installedById = useMemo(() => new Map(apps.map(app => [app.id, app])), [apps]);
  // 纯本地版：所有已安装 APP 都是本机作品，一律可编辑/换包/导出
  const localTestEntries = useMemo(
    () => apps.map(app => ({ app })),
    [apps],
  );

  const refresh = () => setApps(loadInstalledCustomApps());

  function showErrorDialog(message: unknown, title = "操作失败") {
    const text = message instanceof Error ? message.message : String(message || "请稍后再试。");
    setErrorDialog({ title, message: text });
  }

  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT, handler);
  }, []);


  useEffect(() => {
    setInstalledActionError("");
  }, [selectedInstalledApp?.id]);

  // 桌面图标样式编辑（详情弹窗图标下方入口）
  const [iconStyleEditorOpen, setIconStyleEditorOpen] = useState(false);
  const [selectedIconStyle, setSelectedIconStyle] = useState<CustomAppIconStyle>("cover");
  useEffect(() => {
    setIconStyleEditorOpen(false);
    if (selectedInstalledApp) setSelectedIconStyle(getCustomAppIconStyle(selectedInstalledApp.id));
  }, [selectedInstalledApp?.id]);

  function chooseIconStyle(style: CustomAppIconStyle) {
    if (!selectedInstalledApp) return;
    setCustomAppIconStyle(selectedInstalledApp.id, style);
    setSelectedIconStyle(style);
    setIconStyleEditorOpen(false);
    onNotice?.(style === "global" ? "桌面图标已改为跟随全局样式" : "桌面图标已恢复为上传图标");
  }

  useEffect(() => {
    const targetId = typeof launchContext?.selectedInstalledAppId === "string"
      ? launchContext.selectedInstalledAppId.trim()
      : "";
    if (!targetId) {
      consumedLaunchTargetRef.current = "";
      return;
    }
    if (consumedLaunchTargetRef.current === targetId) return;
    const installed = apps.find(app => app.id === targetId);
    if (!installed) return;
    consumedLaunchTargetRef.current = targetId;
    setTab("installed");
    setSelectedInstalledApp(installed);
  }, [apps, launchContext?.selectedInstalledAppId]);

  function openImporter() {
    setLocalEditTarget(null);
    setTab("create");
    fileRef.current?.click();
  }

  async function copyCreatorGuide() {
    try {
      await navigator.clipboard.writeText(CUSTOM_APP_CREATOR_GUIDE_MD);
      onNotice?.("制作说明已复制");
    } catch {
      onNotice?.("复制失败，请手动选择文本复制");
    }
  }

  function updateManualFile(field: keyof ManualUploadFiles, files: FileList | null) {
    if (field === "assets") {
      setManualFiles(current => ({ ...current, assets: files ? Array.from(files) : [] }));
      return;
    }
    setManualFiles(current => ({ ...current, [field]: files?.[0] ?? null }));
  }

  function resetManualFiles() {
    setManualFiles(EMPTY_MANUAL_FILES);
    setManualFileInputKey(current => current + 1);
  }

  function closeManualBuilder() {
    if (busy) return;
    manualLoadSeqRef.current += 1;
    setManualBuilderOpen(false);
    setManualExistingApp(null);
    setManualExistingLoading(false);
  }

  // 导出本地 APP 为市场同款 zip 包（blob 下载，不触发页面刷新），可发给别人从市场「上传导入」
  async function exportLocalApp(app: InstalledCustomApp) {
    try {
      const file = await createCustomAppPackageFile(app);
      await downloadFile(file, file.name);
      onNotice?.(`已导出「${app.name}」安装包`);
    } catch (err) {
      showErrorDialog(err, "导出失败");
    }
  }

  // 编辑本地测试 APP：直接以本机安装的包为底稿打开单文件编辑器，不用下载线上包
  function openLocalManualBuilder(app: InstalledCustomApp) {
    manualLoadSeqRef.current += 1;
    setLocalEditTarget(app);
    setPendingApp(null);
    setSourceFile(null);
    setManualFiles(EMPTY_MANUAL_FILES);
    setManualExistingApp(app);
    setManualExistingLoading(false);
    setPublishVersion(app.version);
    setManualBuilderOpen(true);
    setManualFileInputKey(current => current + 1);
  }

  function openManualBuilder() {
    manualLoadSeqRef.current += 1;
    setLocalEditTarget(null);
    setPendingApp(null);
    setSourceFile(null);
    setManualFiles(EMPTY_MANUAL_FILES);
    setManualExistingApp(null);
    setManualExistingLoading(false);
    setPublishVersion("");
    setManualBuilderOpen(true);
    setManualFileInputKey(current => current + 1);
  }

  function cancelPendingEdit() {
    setLocalEditTarget(null);
    setPendingApp(null);
    setSourceFile(null);
    setPublishVersion("");
  }

  function suggestNextVersion(version: string): string {
    const match = version.trim().match(/^(.*?)(\d+)$/);
    if (!match) return version;
    return `${match[1]}${Number(match[2]) + 1}`;
  }

  // 本地测试「换包」：与已发布换包一致，点按钮直接弹系统文件选择器，选完即按原
  // 运行时 id 原地替换（数据、桌面图标都在，仅本地）——不走"新安装"那套 id 逻辑，
  // 避免误替换别的同名 APP。
  function startRepack(app: InstalledCustomApp) {
    setRepackTarget(app);
    repackInputRef.current?.click();
  }

  async function confirmRepack(target: InstalledCustomApp, file: File) {
    setBusy(true);
    try {
      const lower = file.name.toLowerCase();
      const loaded = lower.endsWith(".html") || lower.endsWith(".htm")
        ? await loadSingleHtmlCustomApp(file)
        : await loadCustomAppPackage(file);
      const replaced: InstalledCustomApp = {
        ...loaded,
        id: target.id,
        installedAt: target.installedAt,
        marketItemId: target.marketItemId,
      };
      const installed = await installApp(replaced);
      if (installed) {
        setSelectedInstalledApp(current => (current && current.id === installed.id ? installed : current));
      }
    } catch (err) {
      showErrorDialog(err, "换包失败");
    } finally {
      setRepackTarget(null);
      setBusy(false);
    }
  }

  async function buildManualPackage() {
    setBusy(true);
    try {
      const baseApp = manualExistingApp ?? null;
      if (!manualFiles.entry && !baseApp) throw new Error("请选择入口 HTML 文件。");
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let manifestRecord: Record<string, unknown> = baseApp ? { ...baseApp.manifest } : {};
      if (manualFiles.manifest) {
        const parsed = JSON.parse(await manualFiles.manifest.text()) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest.json 必须是 JSON 对象。");
        manifestRecord = { ...manifestRecord, ...parsed as Record<string, unknown> };
      }
      const fallbackEntryPath = normalizePackagePath(baseApp?.manifest.entry || "index.html", "index.html");
      const entryPath = normalizePackagePath(
        manualFiles.entry?.name || String(manifestRecord.entry ?? fallbackEntryPath),
        fallbackEntryPath,
      );
      zip.file(entryPath, manualFiles.entry ? await manualFiles.entry.arrayBuffer() : baseApp?.entryHtml ?? "");

      let iconPath = typeof manifestRecord.icon === "string" ? normalizePackagePath(manifestRecord.icon, "icon.png") : "";
      const declarationSlots = [
        { file: manualFiles.presets, path: "presets.json", key: "presets" as const },
        { file: manualFiles.regex, path: "regex.json", key: "regexes" as const },
        { file: manualFiles.worldBooks, path: "worldbooks.json", key: "worldBooks" as const },
        { file: manualFiles.bindings, path: "bindings.json", key: "bindings" as const },
      ];
      const selectedAssetPaths = manualFiles.assets.map(file => normalizePackagePath(file.name, file.name));
      const resources = normalizeManualResources(manifestRecord.resources);
      const replacedPaths = new Set([
        "manifest.json",
        entryPath,
        ...selectedAssetPaths,
        ...declarationSlots.filter(slot => slot.file).map(slot => slot.path),
        ...declarationSlots.flatMap(slot => slot.file ? resourcePathsForKey(resources, slot.key) : []),
      ].filter(Boolean));
      if (manualFiles.icon) {
        iconPath = normalizePackagePath(manualFiles.icon.name, "icon.png");
        zip.file(iconPath, await manualFiles.icon.arrayBuffer());
        replacedPaths.add(iconPath);
      }

      if (baseApp) {
        for (const asset of Object.values(baseApp.assets)) {
          const path = normalizePackagePath(asset.path, asset.path);
          if (!path || replacedPaths.has(path)) continue;
          zip.file(path, bytesFromDataUrl(asset.dataUrl));
        }
      }

      const usedPaths = new Set(["manifest.json", entryPath, iconPath].filter(Boolean));
      for (const slot of declarationSlots) {
        if (!slot.file) continue;
        usedPaths.add(slot.path);
        zip.file(slot.path, await slot.file.arrayBuffer());
        replaceResourcePath(resources, slot.key, slot.path);
      }
      for (const file of manualFiles.assets) {
        const path = normalizePackagePath(file.name, file.name);
        if (!path || usedPaths.has(path)) continue;
        usedPaths.add(path);
        zip.file(path, await file.arrayBuffer());
        const key = resourceKeyForPath(path);
        if (key) appendResourcePath(resources, key, path);
        appendResourcePath(resources, "assets", path);
      }

      const name = String(manifestRecord.name ?? baseApp?.name ?? "").trim() || appNameFromEntryPath(entryPath);
      if (!name) throw new Error("manifest.json 需要 name 字段。");
      const version = String(manifestRecord.version ?? baseApp?.version ?? "").trim() || "1.0.0";
      const permissions = Array.isArray(manifestRecord.permissions)
        ? manifestRecord.permissions as CustomAppPermission[]
        : baseApp?.permissions ?? [];
      const manifest: CustomAppManifest = {
        ...manifestRecord,
        id: normalizeCustomAppManifestId(manifestRecord.id, name),
        name,
        version,
        author: String(manifestRecord.author ?? baseApp?.author ?? "").trim() || undefined,
        description: String(manifestRecord.description ?? baseApp?.description ?? "").trim() || undefined,
        icon: iconPath || (typeof manifestRecord.icon === "string" ? manifestRecord.icon : undefined),
        entry: entryPath,
        permissions,
        resources,
      };
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
      const packageFile = new File([blob], `${manifest.id}-${version}.zip`, { type: "application/zip" });
      if (localEditTarget) {
        // 本地测试编辑：保存即原地更新本机副本（沿用运行时 id，数据保留，仅本地不发市场）
        const loaded = await loadCustomAppPackage(packageFile);
        const replaced: InstalledCustomApp = {
          ...loaded,
          id: localEditTarget.id,
          installedAt: localEditTarget.installedAt,
          marketItemId: localEditTarget.marketItemId,
        };
        const installed = await installApp(replaced);
        if (installed) {
          setManualBuilderOpen(false);
          setLocalEditTarget(null);
          setManualExistingApp(null);
        }
        return;
      }
      setPublishVersion(version);
      const parsed = await handleFile(packageFile);
      if (parsed) setManualBuilderOpen(false);
    } catch (err) {
      showErrorDialog(err);
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File | null | undefined): Promise<boolean> {
    if (!file) return false;
    setBusy(true);
    setSourceFile(file);
    setTab("create");
    try {
      const lower = file.name.toLowerCase();
      const app = lower.endsWith(".html") || lower.endsWith(".htm")
        ? await loadSingleHtmlCustomApp(file)
        : await loadCustomAppPackage(file);
      setPendingApp(app);
      setPublishVersion(app.version);
      return true;
    } catch (err) {
      setSourceFile(null);
      showErrorDialog(err, "导入失败");
      return false;
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function installApp(app: InstalledCustomApp, options: { silent?: boolean } = {}) {
    try {
      const wasInstalled = loadInstalledCustomApps().some(item => item.id === app.id);
      const installed = await installCustomAppAsync(app);
      const registration = await applyCustomAppRegistrationsAsync(installed);
      const registrationText = formatCustomAppRegistrationSummary(registration);
      onInstallToDesktop(installed);
      refresh();
      if (!options.silent) {
        const head = wasInstalled ? `已更新「${installed.name}」（换包成功，原有数据保留）` : `已安装「${installed.name}」`;
        onNotice?.(registrationText ? `${head}，${registrationText}` : head);
      }
      return installed;
    } catch (err) {
      showErrorDialog(err);
      return null;
    }
  }

  async function confirmInstall() {
    if (!pendingApp) return;
    setBusy(true);
    const base = appWithVersion(pendingApp, publishVersion);
    // 编辑本地测试 APP 后的"本机测试"是原地替换：沿用原运行时 id 和 installedAt，数据保留
    const app = localEditTarget ? { ...base, id: localEditTarget.id, installedAt: localEditTarget.installedAt } : base;
    const installed = await installApp(app);
    if (installed) {
      setLocalEditTarget(null);
      setPendingApp(null);
      setSourceFile(null);
      setTab(localEditTarget ? "create" : "installed");
    }
    setBusy(false);
  }

  function closePendingSheet() {
    setPendingApp(null);
    setSourceFile(null);
    setLocalEditTarget(null);
    setPublishVersion("");
  }

  async function deleteApp(app: InstalledCustomApp, deleteData: boolean) {
    setBusy(true);
    try {
      const removal = await removeCustomAppRegistrationsAsync(app.id, { deleteResources: deleteData });
      const removalText = formatCustomAppRegistrationRemovalSummary(removal);
      await uninstallCustomAppAsync(app.id, { deleteData });
      setConfirmDelete(null);
      setSelectedInstalledApp(null);
      refresh();
      const base = deleteData ? `已卸载「${app.name}」并删除数据` : `已卸载「${app.name}」`;
      onNotice?.(removalText ? `${base}，${removalText}` : base);
    } catch (err) {
      showErrorDialog(err, "卸载失败");
    } finally {
      setBusy(false);
    }
  }


  const titleHint = tab === "installed" ? "我的应用" : "创作与测试";
  const manualFileCount = [
    manualFiles.manifest,
    manualFiles.entry,
    manualFiles.icon,
    manualFiles.presets,
    manualFiles.regex,
    manualFiles.worldBooks,
    manualFiles.bindings,
    ...manualFiles.assets,
  ].filter(Boolean).length;
  const manualExistingManifest = manualExistingApp?.manifest;
  const manualExistingEntryPath = manualExistingManifest ? normalizePackagePath(manualExistingManifest.entry || "index.html", "index.html") : "";
  const manualExistingIconPath = manualExistingManifest?.icon
    ? normalizePackagePath(manualExistingManifest.icon, "icon.png")
    : manualExistingApp?.iconDataUrl ? "icon.png" : "";
  const manualExistingPresetsPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "presets", "presets.json");
  const manualExistingRegexPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "regexes", "regex.json");
  const manualExistingWorldBooksPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "worldBooks", "worldbooks.json");
  const manualExistingBindingsPath = existingDeclarationPath(manualExistingApp, manualExistingManifest, "bindings", "bindings.json");
  const manualExistingAssetPaths = existingOtherAssetPaths(manualExistingApp, manualExistingManifest);

  return (
    <div className="app-market-app">
      <header className="app-market-header">
        <button type="button" className="app-market-icon-btn" onClick={onClose} aria-label="返回桌面">
          <ChevronLeft size={25} />
        </button>
        <div className="app-market-title">
          <strong>应用市场</strong>
          <span>{titleHint}</span>
        </div>
              </header>

      <div className="app-market-tabbar">
        <div className="app-market-tabs" role="tablist" aria-label="应用市场视图">
          <button type="button" role="tab" aria-selected={tab === "installed"} className="app-market-tab" data-active={tab === "installed"} onClick={() => setTab("installed")}>
            <span>已安装</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "create"} className="app-market-tab" data-active={tab === "create"} onClick={() => setTab("create")}>
            <span>创作</span>
          </button>
        </div>
      </div>

      <main className="app-market-body">
        <input
          ref={fileRef}
          type="file"
          accept=".zip,.html,.htm,.pneumaapp,.floatapp,application/zip,application/x-zip-compressed,text/html,application/octet-stream"
          className="app-market-hidden-input"
          onChange={event => void handleFile(event.target.files?.[0])}
        />
        <input
          ref={repackInputRef}
          type="file"
          accept=".zip,.html,.htm,.pneumaapp,.floatapp,application/zip,application/x-zip-compressed,text/html,application/octet-stream"
          className="app-market-hidden-input"
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && repackTarget) void confirmRepack(repackTarget, file);
          }}
        />

        {tab === "installed" ? (
          <>
            {apps.length === 0 ? (
              <div className="app-market-empty">
                <HardDrive size={26} />
                <p>还没有安装应用，去发现页逛逛吧</p>
              </div>
            ) : (
              <section className="app-market-section">
                <div className="am-store-list">
                  {apps.map(app => (
                    <article className="am-list-row" key={app.id}>
                      <button type="button" className="am-list-icon-btn" onClick={() => onOpenCustomApp(app.id)} aria-label={`打开${app.name}`}>
                        <AppIcon iconDataUrl={app.iconDataUrl} seed={app.name} className="list" />
                      </button>
                      <div className="am-list-col">
                        <button type="button" className="am-list-text" onClick={() => onOpenCustomApp(app.id)}>
                          <span className="am-list-name-row">
                            <strong>{app.name}</strong>
                            <span className="am-list-author">{app.author || "本地作者"} · v{app.version}</span>
                          </span>
                          {app.description ? <em>{app.description}</em> : null}
                        </button>
                        <div className="am-list-action">
                          <button type="button" className="am-pill am-pill-get" onClick={() => onOpenCustomApp(app.id)}>打开</button>
                          <button type="button" className="am-list-manage" onClick={() => setSelectedInstalledApp(app)} aria-label={`管理${app.name}`}>
                            <Info size={16} />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : null}

        {tab === "create" ? (
          <>
            <div className="am-create-actions">
              <button type="button" className="am-create-action" onClick={openImporter} disabled={busy}>
                <span className="am-create-action-icon"><CloudUpload size={23} /></span>
                <strong>{busy ? "正在解析…" : "导入整包"}</strong>
                <em>.zip · .html</em>
              </button>

              <button type="button" className="am-create-action" onClick={() => openManualBuilder()} disabled={busy}>
                <span className="am-create-action-icon"><PackageCheck size={23} /></span>
                <strong>单文件逐项上传</strong>
                <em>逐项选择文件</em>
              </button>
            </div>

            <button type="button" className="app-market-secondary am-guide-btn" onClick={() => setCreatorGuideOpen(true)}>
              <BookOpen size={17} />
              <span>制作说明</span>
            </button>

            {localTestEntries.length > 0 ? (
              <section className="app-market-section">
                <div className="app-market-section-head">
                  <h2>本地测试</h2>
                  <span>{localTestEntries.length} 个</span>
                </div>
                <div className="am-store-list">
                  {localTestEntries.map(({ app }) => (
                    <article className="am-list-row" key={app.id}>
                      <span className="am-list-icon-btn">
                        <AppIcon iconDataUrl={app.iconDataUrl} seed={app.name} className="list" />
                      </span>
                      <div className="am-list-col">
                        <div className="am-list-text">
                          <span className="am-list-name-row">
                            <strong>{app.name}</strong>
                            <span className="am-list-author">v{app.version}</span>

                          </span>
                          {app.description ? <em>{app.description}</em> : null}
                        </div>
                        <div className="am-list-action am-publish-actions">
                          <button type="button" className="am-action-chip" onClick={() => openLocalManualBuilder(app)} disabled={busy} aria-label={`编辑${app.name}`}>
                            <Pencil size={14} />
                            <span>编辑</span>
                          </button>
                          <button type="button" className="am-action-chip" onClick={() => startRepack(app)} disabled={busy} aria-label={`换包更新${app.name}`}>
                            <Upload size={16} />
                            <span>换包</span>
                          </button>
                          <button type="button" className="am-action-chip" onClick={() => void exportLocalApp(app)} disabled={busy} aria-label={`导出${app.name}安装包`}>
                            <Download size={16} />
                            <span>导出</span>
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </main>

      {pendingApp ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={closePendingSheet}>
          <div className="app-market-sheet app-market-check-sheet" role="dialog" aria-modal="true" aria-label="安装前检查" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>"安装前检查"</strong>
              <button type="button" onClick={closePendingSheet} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <AppIcon iconDataUrl={pendingApp.iconDataUrl} seed={pendingApp.name} className="large" />
                <div>
                  <strong>{pendingApp.name}</strong>
                  <p>{pendingApp.description || "本地自定义 APP"}</p>
                  <span>v{publishVersion || pendingApp.version} · {pendingApp.author || "本地作者"}</span>
                </div>
              </div>

              <div className="am-publish-fields">
                <label className="am-form-field">
                  <span>版本号</span>
                  <input value={publishVersion} onChange={event => setPublishVersion(event.target.value)} placeholder={pendingApp.version} spellCheck={false} />
                </label>
              </div>

              <div className="app-market-inspection-grid">
                <div><strong>{pendingApp.permissions.length}</strong><span>权限</span></div>
                <div><strong>{declarationCount(pendingApp)}</strong><span>声明文件</span></div>
                <div><strong>{sourceFile ? formatPackageSize(sourceFile.size) : "未知"}</strong><span>包大小</span></div>
              </div>

              <div className="app-market-declaration-strip">
                {DECLARATION_FILES.map(item => {
                  const Icon = item.icon;
                  const active = hasDeclaration(pendingApp, item.file);
                  return (
                    <span key={item.file} data-active={active}>
                      <Icon size={15} />
                      {item.label}
                    </span>
                  );
                })}
              </div>

              <div className="app-market-permissions">
                <span>请求权限</span>
                {pendingApp.permissions.length === 0 ? (
                  <p>未声明特殊权限，仅作为页面运行。</p>
                ) : (
                  <ul>
                    {pendingApp.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, pendingApp.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>

              {sourceFile ? <p className="app-market-upload-hint">文件：{sourceFile.name}</p> : null}

                <div className="app-market-sheet-actions">
                  <button type="button" className="app-market-secondary" onClick={closePendingSheet}>取消</button>
                  <button type="button" className="app-market-secondary" onClick={() => void confirmInstall()} disabled={busy}>
                    <HardDrive size={18} />
                    <span>本机测试</span>
                  </button>
                </div>
            </div>
          </div>
        </div>
      ) : null}

      {selectedInstalledApp ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setSelectedInstalledApp(null)}>
          <div className="app-market-sheet app-market-detail-sheet" role="dialog" aria-modal="true" aria-label="已安装 APP 详情" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>已安装 APP</strong>
              <button type="button" onClick={() => setSelectedInstalledApp(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <div className="app-market-preview-row">
                <div className="am-installed-icon-col">
                  <AppIcon
                    iconDataUrl={selectedIconStyle === "global" ? undefined : selectedInstalledApp.iconDataUrl}
                    seed={selectedInstalledApp.name}
                    className="large"
                  />
                  {selectedInstalledApp.iconDataUrl ? (
                    <button type="button" className="am-icon-style-edit" onClick={() => setIconStyleEditorOpen(true)}>
                      <Pencil size={11} />
                      图标样式
                    </button>
                  ) : null}
                </div>
                <div>
                  <strong>{selectedInstalledApp.name}</strong>
                  <p>{selectedInstalledApp.description || "本地自定义 APP"}</p>
                  <span>{selectedInstalledApp.author || "本地作者"} · v{selectedInstalledApp.version}</span>
                </div>
              </div>
              <div className="app-market-declaration-strip">
                {DECLARATION_FILES.map(item => {
                  const Icon = item.icon;
                  const active = hasDeclaration(selectedInstalledApp, item.file);
                  return (
                    <span key={item.file} data-active={active}>
                      <Icon size={15} />
                      {item.label}
                    </span>
                  );
                })}
              </div>
              <div className="app-market-permissions">
                <span>已授权能力</span>
                {selectedInstalledApp.permissions.length === 0 ? (
                  <p>未声明特殊权限。</p>
                ) : (
                  <ul>
                    {selectedInstalledApp.permissions.map(permission => (
                      <li key={permission}>{permissionLabelWithContext(permission, selectedInstalledApp.manifest)}</li>
                    ))}
                  </ul>
                )}
              </div>
              {installedActionError ? <div className="app-market-error" role="alert">{installedActionError}</div> : null}
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-danger" onClick={() => setConfirmDelete(selectedInstalledApp)} >
                  <Trash2 size={18} />
                  <span>卸载</span>
                </button>
                <button type="button" className="app-market-primary" onClick={() => onOpenCustomApp(selectedInstalledApp.id)} >
                  <ExternalLink size={18} />
                  <span>打开</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {manualBuilderOpen ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={closeManualBuilder}>
          <div className="app-market-sheet app-market-manual-sheet" role="dialog" aria-modal="true" aria-label="单文件逐项上传" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>{localEditTarget ? `编辑「${localEditTarget.name}」（本地）` : "单文件逐项上传"}</strong>
              {localEditTarget ? (
                <button type="button" onClick={() => void exportLocalApp(localEditTarget)} aria-label={`导出${localEditTarget.name}安装包`} title="导出安装包（zip，可发给别人导入）" disabled={busy}>
                  <Download size={18} />
                </button>
              ) : null}
              <button type="button" onClick={closeManualBuilder} aria-label="关闭" disabled={busy}>
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              {localEditTarget ? (
                <p className="app-market-upload-hint">下方是本机安装包里的文件；只选择需要替换的文件，未选择的沿用原文件。保存后原地更新本机版，数据保留（仅本地，不会发市场）。</p>
              ) : (
                <p className="app-market-upload-hint">基础信息从 manifest.json 读取；入口、图标、预设、正则、世界书、绑定和资源都用文件上传。</p>
              )}
              <div className="am-manual-file-stack" key={manualFileInputKey}>
                <div className="am-file-section">
                  <div className="am-file-section-head">
                    <strong>基础文件</strong>
                    {manualFileCount > 0 ? (
                      <button type="button" onClick={resetManualFiles} disabled={busy}>清空已选</button>
                    ) : null}
                  </div>
                  <div className="am-file-grid">
                    <label className="am-file-pick" data-active={Boolean(manualFiles.manifest)}>
                      <FileJson size={18} />
                      <span>manifest.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("manifest", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.manifest, "", "建议必选", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.entry || manualExistingEntryPath)}>
                      <FileCode2 size={18} />
                      <span>入口 HTML</span>
                      <input type="file" accept=".html,.htm,text/html" onChange={event => updateManualFile("entry", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.entry, manualExistingEntryPath, "选择 index.html", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.icon || manualExistingIconPath)}>
                      <ImageIcon size={18} />
                      <span>图标文件</span>
                      <input type="file" accept="image/*" onChange={event => updateManualFile("icon", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.icon, manualExistingIconPath, "可选上传", manualExistingLoading)}</em>
                    </label>
                  </div>
                </div>
                <div className="am-file-section">
                  <div className="am-file-section-head">
                    <strong>声明文件</strong>
                    <span>按槽位上传，不需要手写</span>
                  </div>
                  <div className="am-file-grid">
                    <label className="am-file-pick" data-active={Boolean(manualFiles.presets || manualExistingPresetsPath)}>
                      <Layers size={18} />
                      <span>presets.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("presets", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.presets, manualExistingPresetsPath, "预设条目", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.regex || manualExistingRegexPath)}>
                      <Sparkles size={18} />
                      <span>regex.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("regex", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.regex, manualExistingRegexPath, "正则美化", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.worldBooks || manualExistingWorldBooksPath)}>
                      <FileJson size={18} />
                      <span>worldbooks.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("worldBooks", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.worldBooks, manualExistingWorldBooksPath, "世界书资料", manualExistingLoading)}</em>
                    </label>
                    <label className="am-file-pick" data-active={Boolean(manualFiles.bindings || manualExistingBindingsPath)}>
                      <CheckCircle2 size={18} />
                      <span>bindings.json</span>
                      <input type="file" accept=".json,application/json" onChange={event => updateManualFile("bindings", event.target.files)} />
                      <em>{fileSlotLabel(manualFiles.bindings, manualExistingBindingsPath, "默认绑定", manualExistingLoading)}</em>
                    </label>
                  </div>
                </div>
                <div className="am-file-section">
                  <div className="am-file-section-head">
                    <strong>其他资源</strong>
                    <span>图片、脚本、样式、字体等</span>
                  </div>
                  <label className="am-file-pick am-file-pick-wide" data-active={manualFiles.assets.length > 0 || manualExistingAssetPaths.length > 0}>
                    <Upload size={18} />
                    <span>资源文件</span>
                    <input type="file" multiple accept=".json,.js,.css,.png,.jpg,.jpeg,.webp,.svg,.woff,.woff2,text/*,image/*,application/json" onChange={event => updateManualFile("assets", event.target.files)} />
                    <em>{assetSlotLabel(manualFiles.assets, manualExistingAssetPaths, "可多选，不包含上面的专用槽位", manualExistingLoading)}</em>
                  </label>
                </div>
              </div>
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={closeManualBuilder} disabled={busy}>取消</button>
                <button type="button" className="app-market-primary" onClick={() => void buildManualPackage()} disabled={busy}>
                  {busy ? <LoaderCircle className="am-spin" size={18} /> : <PackageCheck size={18} />}
                  <span>{busy ? (localEditTarget ? "保存中" : "组包中") : localEditTarget ? "保存" : "生成并检查"}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <div className="app-market-overlay" role="presentation" onClick={() => setConfirmDelete(null)}>
          <div className="app-market-sheet" role="dialog" aria-modal="true" aria-label="卸载 APP" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>卸载「{confirmDelete.name}」？</strong>
              <button type="button" onClick={() => setConfirmDelete(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">
                将移除桌面图标、权限授权和运行文件。聊天历史里的 APP 卡片会保留。
              </p>
              <div className="app-market-sheet-actions stacked">
                <button type="button" className="app-market-secondary" onClick={() => void deleteApp(confirmDelete, false)} disabled={busy}>
                  卸载并保留数据
                </button>
                <button type="button" className="app-market-danger" onClick={() => void deleteApp(confirmDelete, true)} disabled={busy}>
                  卸载并删除数据
                </button>
                <button type="button" className="app-market-secondary" onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {iconStyleEditorOpen && selectedInstalledApp ? (
        <div className="app-market-overlay app-market-center-overlay" role="presentation" onClick={() => setIconStyleEditorOpen(false)}>
          <div className="app-market-sheet app-market-confirm-sheet am-icon-style-sheet" role="dialog" aria-modal="true" aria-label="桌面图标样式" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>桌面图标样式</strong>
              <button type="button" onClick={() => setIconStyleEditorOpen(false)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-upload-hint">选择「{selectedInstalledApp.name}」在桌面上的图标显示方式，随时可以改回来。</p>
              <div className="am-icon-style-options">
                <button
                  type="button"
                  data-active={selectedIconStyle === "cover" ? "true" : undefined}
                  onClick={() => chooseIconStyle("cover")}
                >
                  <AppIcon iconDataUrl={selectedInstalledApp.iconDataUrl} seed={selectedInstalledApp.name} className="large" />
                  <strong>使用当前图标</strong>
                  <span>上传的图标铺满图标格</span>
                </button>
                <button
                  type="button"
                  data-active={selectedIconStyle === "global" ? "true" : undefined}
                  onClick={() => chooseIconStyle("global")}
                >
                  <AppIcon seed={selectedInstalledApp.name} className="large" />
                  <strong>跟随全局图标</strong>
                  <span>生成字形，套用全局图标效果（毛玻璃等）</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {errorDialog ? (
        <div className="app-market-overlay app-market-center-overlay" role="presentation" onClick={() => setErrorDialog(null)}>
          <div className="app-market-sheet app-market-confirm-sheet app-market-error-dialog" role="alertdialog" aria-modal="true" aria-label={errorDialog.title} onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>{errorDialog.title}</strong>
              <button type="button" onClick={() => setErrorDialog(null)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-delete-copy">{errorDialog.message}</p>
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-primary" onClick={() => setErrorDialog(null)}>知道了</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}


      {creatorGuideOpen ? (
        <div className="app-market-overlay app-market-drawer-overlay" role="presentation" onClick={() => setCreatorGuideOpen(false)}>
          <div className="app-market-sheet app-market-guide-sheet" role="dialog" aria-modal="true" aria-label="自定义 APP 制作说明" onClick={event => event.stopPropagation()}>
            <div className="app-market-sheet-head">
              <strong>自定义 APP 制作说明</strong>
              <button type="button" onClick={() => setCreatorGuideOpen(false)} aria-label="关闭">
                <X size={20} />
              </button>
            </div>
            <div className="app-market-sheet-body">
              <p className="app-market-guide-copy">
                把这份说明和你的 APP 想法一起发给创作助手，让它按小手机当前 SDK 生成应用包文件。
              </p>
              <textarea
                className="app-market-guide-text"
                value={CUSTOM_APP_CREATOR_GUIDE_MD}
                rows={18}
                readOnly
                spellCheck={false}
                aria-label="自定义 APP 制作说明全文"
              />
              <div className="app-market-sheet-actions">
                <button type="button" className="app-market-secondary" onClick={() => setCreatorGuideOpen(false)}>关闭</button>
                <button type="button" className="app-market-primary" onClick={() => void copyCreatorGuide()}>
                  <Copy size={18} />
                  <span>复制全文</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
