"use client";

import { useEffect, useState } from "react";
import {
    Info, ShieldAlert, Heart, Github, RefreshCw, History, ChevronDown,
    Download, Pause, Play, X, ExternalLink, ShieldCheck, CheckCircle2, CircleAlert,
} from "lucide-react";
import { openExternalUrl } from "@/lib/download-utils";
import {
    REPO_URL, LICENSE_URL, LICENSE_NAME,
    fetchReleases, getCurrentVersion, compareVersions, formatBytes, formatSpeed,
    subscribeDownload, restoreResumable, isAndroidPlatform,
    startDownload, pauseDownload, resumeDownload, cancelDownload, installDownloaded,
    type ReleaseInfo, type DownloadState,
} from "@/lib/app-updater";

export function AboutDeclaration() {
    const [version, setVersion] = useState("…");
    const [checking, setChecking] = useState(false);
    const [checkError, setCheckError] = useState<string | null>(null);
    const [latest, setLatest] = useState<ReleaseInfo | null>(null);
    const [upToDate, setUpToDate] = useState(false);
    const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [dl, setDl] = useState<DownloadState | null>(null);

    useEffect(() => {
        void getCurrentVersion().then(setVersion);
        void restoreResumable();
        return subscribeDownload(setDl);
    }, []);

    const runCheck = async () => {
        setChecking(true);
        setCheckError(null);
        const list = await fetchReleases();
        setChecking(false);
        if (list === null) {
            setCheckError("检查失败——无法连接 GitHub，请检查网络后重试");
            return;
        }
        setReleases(list);
        if (list.length === 0) {
            setCheckError("还没有发布过版本");
            return;
        }
        const newest = list[0];
        setLatest(newest);
        const cur = await getCurrentVersion();
        setUpToDate(compareVersions(cur, newest.tag) >= 0);
    };

    const pct = dl && dl.total > 0 ? Math.min(100, Math.round((dl.received / dl.total) * 100)) : 0;

    return (
        <div className="flex flex-col gap-5 h-full">

            {/* ── 应用信息 ── */}
            <div className="g-card about-app-card">
                <img src="/icon-512.png" alt="" className="about-app-icon" />
                <div className="flex flex-col flex-1 min-w-0">
                    <span className="menu-label font-semibold">Pneuma</span>
                    <span className="menu-desc ts-12 !mt-0">v{version}</span>
                </div>
                <button
                    className="about-license-pill"
                    onClick={() => openExternalUrl(LICENSE_URL)}
                >
                    <ShieldCheck size={13} />
                    {LICENSE_NAME}
                </button>
            </div>

            {/* ── 开源仓库 + 检查更新 ── */}
            <div className="g-card">
                <button className="about-gh-row" onClick={() => openExternalUrl(REPO_URL)}>
                    <Github size={22} className="shrink-0 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col flex-1 min-w-0 text-left">
                        <span className="menu-label">开源仓库</span>
                        <span className="menu-desc ts-12 !mt-0 truncate">shiaho777 / pneuma-android</span>
                    </div>
                    <ExternalLink size={15} className="shrink-0 text-[var(--c-icon)]" />
                </button>
                {/* 自更新仅 Android；iOS 由 App Store 托管（Guideline 2.5.2 禁止应用内下载安装） */}
                {isAndroidPlatform() && (<>
                <div className="ui-row-divider !mx-0" />
                <div className="about-update-row">
                    <div className="flex flex-col flex-1 min-w-0">
                        <span className="menu-label">检查更新</span>
                        <span className="menu-desc ts-12 !mt-0">
                            {checking ? "正在检查…" : upToDate && latest ? "当前已是最新版本" : "从 GitHub Releases 获取"}
                        </span>
                    </div>
                    <button
                        className="ui-btn ui-btn-primary about-check-btn"
                        onClick={runCheck}
                        disabled={checking}
                    >
                        <RefreshCw size={14} className={checking ? "animate-spin" : ""} />
                        检查更新
                    </button>
                </div>

                {/* 检查失败 */}
                {checkError && !checking && (
                    <div className="about-notice about-notice-error">
                        <CircleAlert size={15} className="shrink-0" />
                        <span>{checkError}</span>
                    </div>
                )}

                {/* 已是最新 */}
                {!checking && upToDate && latest && (
                    <div className="about-notice about-notice-ok">
                        <CheckCircle2 size={15} className="shrink-0" />
                        <span>已是最新版本 {latest.tag}</span>
                    </div>
                )}

                {/* 有更新：展示版本信息（不含下载控件——下载区独立于触发来源） */}
                {!checking && latest && !upToDate && (
                    <div className="about-update-detail">
                        <div className="about-update-head">
                            <span className="about-update-tag">{latest.tag}</span>
                            <span className="menu-desc ts-12 !mt-0">
                                {latest.publishedAt ? latest.publishedAt.slice(0, 10) : ""}
                            </span>
                        </div>
                        <div className="about-update-meta">
                            <span className="truncate">{latest.apkName}</span>
                            <span className="shrink-0">{formatBytes(latest.apkSize)}</span>
                        </div>
                        {latest.notes.trim() && (
                            <p className="about-update-notes">{latest.notes.trim()}</p>
                        )}
                        {(!dl || dl.phase === "idle") && (
                            <button
                                className="ui-btn ui-btn-primary about-download-btn"
                                onClick={() => void startDownload(latest)}
                            >
                                <Download size={15} />
                                {isAndroidPlatform() ? "下载更新" : "前往下载"}
                            </button>
                        )}
                    </div>
                )}

                {/* 下载区：无论从新版本卡还是历史版本行触发都在这里显示 */}
                {dl && dl.phase !== "idle" && (
                    <div className="about-update-detail">
                        <div className="about-update-head">
                            <span className="about-update-tag">{dl.tag || "下载中"}</span>
                        </div>
                        <div className="about-update-meta">
                            <span className="truncate">{dl.fileName}</span>
                            <span className="shrink-0">{dl.total > 0 ? `${pct}%` : ""}</span>
                        </div>

                        {(dl.phase === "downloading" || dl.phase === "paused") && (
                            <div className="about-dl">
                                <div className="about-dl-track">
                                    <div className={`about-dl-fill ${dl.phase === "paused" ? "about-dl-fill-paused" : ""}`} style={{ width: `${pct}%` }} />
                                </div>
                                <div className="about-dl-meta">
                                    <span>
                                        {dl.phase === "paused" ? "已暂停 · " : ""}
                                        {formatBytes(dl.received)} / {formatBytes(dl.total)}
                                        {dl.phase === "downloading" && dl.speedBps > 0 ? ` · ${formatSpeed(dl.speedBps)}` : ""}
                                    </span>
                                </div>
                                <div className="about-dl-actions">
                                    {dl.phase === "downloading" ? (
                                        <button className="ui-btn ui-btn-ghost about-dl-btn" onClick={() => void pauseDownload()}>
                                            <Pause size={14} /> 暂停
                                        </button>
                                    ) : (
                                        <button className="ui-btn ui-btn-primary about-dl-btn" onClick={() => void resumeDownload()}>
                                            <Play size={14} /> 继续下载
                                        </button>
                                    )}
                                    <button className="ui-btn ui-btn-ghost about-dl-btn" onClick={() => void cancelDownload()}>
                                        <X size={14} /> {dl.phase === "paused" ? "放弃" : "取消"}
                                    </button>
                                </div>
                            </div>
                        )}

                        {dl.phase === "done" && (
                            <button className="ui-btn ui-btn-success about-download-btn" onClick={() => void installDownloaded()}>
                                <Download size={15} /> 安装更新
                            </button>
                        )}
                        {dl.phase === "error" && (
                            <div className="about-notice about-notice-error">
                                <CircleAlert size={15} className="shrink-0" />
                                <span>{dl.error ?? "下载失败"}</span>
                                <button className="ui-link-btn" onClick={() => void startDownload({ tag: dl.tag, title: "", notes: "", publishedAt: "", apkName: dl.fileName, apkSize: dl.total, downloadUrl: dl.url })}>重试</button>
                            </div>
                        )}
                    </div>
                )}
                </>)}
            </div>

            {/* ── 历史版本（仅 Android 提供 APK 下载）── */}
            {isAndroidPlatform() && (
            <div className="g-card">
                <button className="about-gh-row" onClick={async () => {
                    if (!releases && !checking) void runCheck();
                    setShowHistory(v => !v);
                }}>
                    <History size={20} className="shrink-0 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col flex-1 min-w-0 text-left">
                        <span className="menu-label">历史版本</span>
                        <span className="menu-desc ts-12 !mt-0">{releases ? `${releases.length} 个版本` : "查看全部 Release"}</span>
                    </div>
                    <ChevronDown size={16} className={`shrink-0 text-[var(--c-icon)] transition-transform ${showHistory ? "rotate-180" : ""}`} />
                </button>
                {showHistory && (
                    <div className="about-history">
                        {releases === null && <span className="menu-desc ts-12">正在获取…</span>}
                        {releases?.length === 0 && <span className="menu-desc ts-12">暂无历史版本</span>}
                        {releases?.map(r => (
                            <div key={r.tag} className="about-release-row">
                                <div className="flex flex-col flex-1 min-w-0">
                                    <span className="menu-label ts-13">{r.tag}{r.title && r.title !== r.tag ? ` · ${r.title}` : ""}</span>
                                    <span className="menu-desc ts-12 !mt-0">
                                        {r.publishedAt.slice(0, 10)} · {r.apkName} · {formatBytes(r.apkSize)}
                                    </span>
                                </div>
                                <button
                                    className="about-release-dl"
                                    onClick={() => void startDownload(r)}
                                    title="下载此版本"
                                >
                                    <Download size={15} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            )}

            {/* ── 免责声明 ── */}
            <p className="card-section-label m-0 mx-2">免责声明</p>
            <div className="g-card">
                <div className="flex items-start gap-3">
                    <ShieldAlert size={20} className="shrink-0 mt-0.5 text-[var(--c-warning)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">AI 生成内容声明</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            本应用内的所有角色对话、动态内容均为人工智能模型自动生成。生成内容不代表本平台的立场与观点，亦不对应任何现实中的人物、事件。用户应当自行辨别并承担使用风险。
                        </span>
                    </div>
                </div>
                <div className="ui-row-divider !mx-0" />
                <div className="flex items-start gap-3">
                    <Info size={20} className="shrink-0 mt-0.5 text-[var(--c-icon-active)]" />
                    <div className="flex flex-col gap-2">
                        <span className="menu-label font-semibold">隐私与数据安全</span>
                        <span className="menu-desc ts-13 leading-relaxed !mt-0">
                            您的日记、聊天记录及身份预设等敏感数据默认保存在本地浏览器中（LocalStorage/IndexedDB）。清理浏览器缓存可能会导致数据丢失，请注意妥善备份。
                        </span>
                    </div>
                </div>
            </div>

            <p className="card-section-label m-0 mx-2">相关信息</p>
            <div className="flex flex-col gap-2">
                <button className="g-card flex-row items-center" onClick={() => openExternalUrl(REPO_URL)}>
                    <Heart size={20} fill="currentColor" className="shrink-0 text-[var(--c-icon-rose)]" />
                    <span className="menu-label flex-1">支持开发者</span>
                    <span className="menu-desc !mt-0">给仓库点个 Star</span>
                </button>
            </div>
        </div>
    );
}
