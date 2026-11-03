// lib/app-updater.ts
// 应用自更新：GitHub Releases 检查 + APK 下载状态机。
//
// 原生端下载走 AppUpdater 插件（OkHttp 流式写盘、Range 断点续传）——
// release 资产会 302 到 objects.githubusercontent.com，无 CORS 头，
// WebView fetch 拿不到，必须原生直连。浏览器端则把下载交给系统浏览器。
// 断点状态存 localStorage：退出重进后能对上 cacheDir 里的残件继续下。

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

export const REPO_URL = "https://github.com/shiaho777/float-android";
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const LICENSE_NAME = "AGPL-3.0-only";

const RELEASES_API = "https://api.github.com/repos/shiaho777/float-android/releases";
const STORAGE_KEY = "float_update_dl_v1";
const FALLBACK_VERSION = "1.0.2";

export interface ReleaseInfo {
    tag: string;
    title: string;
    notes: string;
    publishedAt: string;
    apkName: string;
    apkSize: number;
    downloadUrl: string;
}

export type DownloadPhase = "idle" | "downloading" | "paused" | "done" | "error";

export interface DownloadState {
    phase: DownloadPhase;
    tag: string;
    fileName: string;
    url: string;
    received: number;
    total: number;
    speedBps: number;
    error?: string;
}

interface AppUpdaterNative {
    start(opts: { url: string; fileName: string; offset: number }): Promise<void>;
    pause(): Promise<void>;
    cancel(opts: { fileName: string }): Promise<void>;
    partialSize(opts: { fileName: string }): Promise<{ size: number }>;
    install(opts: { fileName: string }): Promise<void>;
    addListener(
        event: "updateProgress" | "updateDone" | "updateError",
        cb: (data: Record<string, unknown>) => void,
    ): Promise<PluginListenerHandle>;
}

const Updater = registerPlugin<AppUpdaterNative>("AppUpdater");

/** 自更新仅 Android：Apple 禁止应用内下载安装二进制（Guideline 2.5.2），iOS 走 App Store。 */
export function isAndroidPlatform(): boolean {
    return Capacitor.getPlatform() === "android";
}

function normalizeVersion(v: string): number[] {
    return v.replace(/^v/i, "").split(".").map(s => parseInt(s.replace(/\D.*$/, ""), 10) || 0);
}

/** a > b → 1；a < b → -1；相等 → 0。"1.0" 与 "1.0.0" 视为相等。 */
export function compareVersions(a: string, b: string): number {
    const pa = normalizeVersion(a), pb = normalizeVersion(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

export async function getCurrentVersion(): Promise<string> {
    try {
        const { App } = await import("@capacitor/app");
        const info = await App.getInfo();
        return info.version || FALLBACK_VERSION;
    } catch {
        return FALLBACK_VERSION; // 浏览器端
    }
}

function parseRelease(raw: Record<string, unknown>): ReleaseInfo | null {
    const assets = (raw.assets as Array<Record<string, unknown>> | undefined) ?? [];
    const apk = assets.find(a => typeof a.name === "string" && a.name.toLowerCase().endsWith(".apk"));
    if (!apk) return null;
    return {
        tag: String(raw.tag_name ?? ""),
        title: String(raw.name ?? raw.tag_name ?? ""),
        notes: String(raw.body ?? ""),
        publishedAt: String(raw.published_at ?? ""),
        apkName: String(apk.name),
        apkSize: Number(apk.size ?? 0),
        downloadUrl: String(apk.browser_download_url ?? ""),
    };
}

/** 拉全部 release。返回 null 表示请求失败（离线/限流）。 */
export async function fetchReleases(): Promise<ReleaseInfo[] | null> {
    try {
        const res = await fetch(`${RELEASES_API}?per_page=20`, {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!res.ok) return null;
        const list = await res.json();
        if (!Array.isArray(list)) return null;
        return list
            .filter((r: Record<string, unknown>) => r.draft !== true && r.prerelease !== true)
            .map(parseRelease).filter((r): r is ReleaseInfo => r !== null);
    } catch {
        return null;
    }
}

// ── 下载状态机（模块单例，组件卸载不丢进度） ────────────────────────

type Listener = (s: DownloadState) => void;

const initial: DownloadState = { phase: "idle", tag: "", fileName: "", url: "", received: 0, total: 0, speedBps: 0 };
let state: DownloadState = { ...initial };
const listeners = new Set<Listener>();
let nativeListenersBound = false;

function set(patch: Partial<DownloadState>) {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn(state));
}

export function subscribeDownload(fn: Listener): () => void {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
}

export function getDownloadState(): DownloadState {
    return state;
}

function persistResumable() {
    try {
        if (state.phase === "paused" || state.phase === "downloading") {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                tag: state.tag, fileName: state.fileName, url: state.url,
                received: state.received, total: state.total,
            }));
        } else {
            localStorage.removeItem(STORAGE_KEY);
        }
    } catch { /* 存不下就算了 */ }
}

async function bindNativeListeners() {
    if (nativeListenersBound || !isAndroidPlatform()) return;
    nativeListenersBound = true;
    await Updater.addListener("updateProgress", d => {
        // 暂停瞬间桥上可能有在途进度事件——非 downloading 状态一律丢弃，
        // 否则会把已暂停的 phase 顶回 downloading（速度值还会定格成僵尸数）。
        if (d.fileName !== state.fileName || state.phase !== "downloading") return;
        set({
            phase: "downloading",
            received: Number(d.received ?? 0),
            total: Number(d.total ?? 0),
            speedBps: Number(d.speedBps ?? 0),
        });
        persistResumable();
    });
    await Updater.addListener("updateDone", d => {
        if (d.fileName !== state.fileName) return;
        set({ phase: "done", received: state.total || state.received, speedBps: 0 });
        localStorage.removeItem(STORAGE_KEY);
    });
    await Updater.addListener("updateError", d => {
        if (d.fileName !== undefined && d.fileName !== state.fileName) return;
        set({ phase: "error", error: String(d.message ?? "下载失败"), speedBps: 0 });
    });
}

export async function startDownload(rel: ReleaseInfo): Promise<void> {
    if (!isAndroidPlatform()) {
        const { openExternalUrl } = await import("./download-utils");
        openExternalUrl(rel.downloadUrl);
        return;
    }
    await bindNativeListeners();
    const fileName = rel.apkName || `pneuma-${rel.tag}.apk`;
    set({ phase: "downloading", tag: rel.tag, fileName, url: rel.downloadUrl, received: 0, total: rel.apkSize, speedBps: 0 });
    persistResumable();
    try {
        await Updater.start({ url: rel.downloadUrl, fileName, offset: 0 });
    } catch (e) {
        set({ phase: "error", error: e instanceof Error ? e.message : "下载失败" });
    }
}

export async function pauseDownload(): Promise<void> {
    if (!isAndroidPlatform() || state.phase !== "downloading") return;
    try { await Updater.pause(); } catch { /* noop */ }
    set({ phase: "paused", speedBps: 0 });
    persistResumable();
}

export async function resumeDownload(): Promise<void> {
    if (!isAndroidPlatform() || state.phase !== "paused") return;
    await bindNativeListeners();
    set({ phase: "downloading", speedBps: 0 });
    try {
        await Updater.start({ url: state.url, fileName: state.fileName, offset: state.received });
    } catch (e) {
        set({ phase: "error", error: e instanceof Error ? e.message : "下载失败" });
    }
}

export async function cancelDownload(): Promise<void> {
    if (isAndroidPlatform() && state.fileName) {
        try { await Updater.cancel({ fileName: state.fileName }); } catch { /* noop */ }
    }
    set({ ...initial });
    localStorage.removeItem(STORAGE_KEY);
}

export async function installDownloaded(): Promise<void> {
    if (!isAndroidPlatform() || state.phase !== "done") return;
    await Updater.install({ fileName: state.fileName });
}

/**
 * 重进页面时恢复断点：localStorage 里有残件记录 → 向原生校验文件还在 →
 * 置为 paused，UI 显示「继续下载」。文件被系统清了则丢弃记录。
 */
export async function restoreResumable(): Promise<void> {
    if (state.phase !== "idle" || !isAndroidPlatform()) return;
    let saved: { tag?: string; fileName?: string; url?: string; received?: number; total?: number } | null = null;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch { /* bad json */ }
    if (!saved?.fileName || !saved.url) return;
    await bindNativeListeners();
    try {
        const { size } = await Updater.partialSize({ fileName: saved.fileName });
        if (size > 0) {
            set({
                phase: "paused",
                tag: saved.tag ?? "",
                fileName: saved.fileName,
                url: saved.url,
                received: Math.min(size, saved.total ?? size),
                total: saved.total ?? 0,
                speedBps: 0,
            });
            return;
        }
    } catch { /* 插件不可用 */ }
    localStorage.removeItem(STORAGE_KEY);
}

export function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return "0 MB";
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.ceil(bytes / 1024)} KB`;
}

export function formatSpeed(bps: number): string {
    if (!bps || bps <= 0) return "";
    if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
    return `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}
