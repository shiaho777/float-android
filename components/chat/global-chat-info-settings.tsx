"use client";

import { useEffect, useRef, useState } from "react";
import { BellRing, ChevronRight, Code, Image as ImageIcon, LayoutPanelTop, Play, RotateCcw, User, X } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Toggle } from "@/components/ui/form";
import {
    MAX_VISION_IMAGE_PROMPT_LIMIT,
    getActiveChatSessionId,
    loadChatAppSettings,
    loadChatSessions,
    normalizeVisionImagePromptLimit,
    saveChatAppSettings,
    saveChatSessions,
    DEFAULT_MEETING_INVITE_CONTRACT,
    DEFAULT_MEETING_INVITE_PREVIEW,
    DEFAULT_MEETING_INVITE_RENDER,
    resolveMeetingInviteCardConfig,
    type ChatSoundConfig,
    type ChatSoundKind,
    type ChatSoundsConfig,
    type MeetingInviteCardConfig,
} from "@/lib/chat-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { dispatchChatMessageNotice } from "@/lib/chat-notification-events";
import { ChatSoundSourceEditor, SOUND_ITEMS } from "./chat-sound-editor";
import { previewChatSound } from "@/lib/chat-sound";
import {
    GLOBAL_CHAT_STATUS_REGION_ID,
    getStatusRegionConfig,
    isCustomStatusRegionActive,
    saveStatusRegionConfig,
    STATUS_REGION_SCHEME_TARGET,
    type StatusRegionConfig,
} from "@/lib/chat-status-region";
import { CHAT_SESSION_CSS_EXAMPLE } from "@/lib/css-examples";
import { fileToUserAvatarDataUrl } from "@/lib/user-avatar-image";
import { CustomStatusFrame } from "./custom-status-frame";

function saveSettings(patch: Record<string, unknown>) {
    saveChatAppSettings({ ...loadChatAppSettings(), ...patch });
}

// ── 提示音设置分区 ──────────────────────────────────────────────

function ChatSoundsSection() {
    const [sounds, setSounds] = useState<ChatSoundsConfig>(() => loadChatAppSettings().globalChatSounds || {});

    const changeSound = (kind: ChatSoundKind, patch: Partial<ChatSoundConfig>) => {
        setSounds(current => {
            const next: ChatSoundsConfig = { ...current, [kind]: { ...current[kind], ...patch } };
            saveChatAppSettings({ ...loadChatAppSettings(), globalChatSounds: next });
            return next;
        });
    };

    // 新消息音效“测试弹窗”：模拟一条真实新消息——播提示音 + 弹桌面通知横幅。
    // 横幅挑最近活跃的会话来演（优先避开正打开的那个），点击横幅会跳进那个聊天。
    const testNewMessageNotice = () => {
        void previewChatSound("newMessage");
        const sessions = loadChatSessions()
            .slice()
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        const activeId = getActiveChatSessionId();
        const target = sessions.find(s => s.id !== activeId) || sessions[0];
        if (!target) { alert("还没有聊天会话，先和角色聊一句再测试弹窗"); return; }
        dispatchChatMessageNotice({
            sessionId: target.id,
            body: "【提示音测试】模拟收到一条新消息",
            isTest: true,
        });
    };

    return (
        <div className="menu-group">
            {SOUND_ITEMS.map(({ kind, icon: Icon, label, desc }) => {
                const config: ChatSoundConfig = sounds[kind] || {};
                const enabled = config.enabled === true;
                return (
                    <div key={kind} className="chat-sound-block">
                        <div className="menu-item">
                            <Icon size={20} className="text-[var(--c-icon)]" />
                            <div className="menu-label-group"><span className="menu-label">{label}</span><span className="menu-desc">{desc}</span></div>
                            <div className="menu-right">
                                <Toggle checked={enabled} onChange={checked => changeSound(kind, { enabled: checked })} />
                            </div>
                        </div>
                        {enabled ? (
                            <div className="chat-sound-editor">
                                <ChatSoundSourceEditor
                                    config={config}
                                    onPatch={patch => changeSound(kind, patch)}
                                    onPreview={() => void previewChatSound(kind)}
                                />
                                {kind === "newMessage" ? (
                                    <>
                                        <div className="chat-sound-subtoggles">
                                            <div className="chat-sound-subtoggle">
                                                <div className="menu-label-group"><span className="menu-label">实时聊天不通知</span><span className="menu-desc">正打开该聊天时，角色新消息不播放音效</span></div>
                                                <Toggle checked={config.muteActiveChat === true} onChange={checked => changeSound(kind, { muteActiveChat: checked })} />
                                            </div>
                                            <div className="chat-sound-subtoggle">
                                                <div className="menu-label-group"><span className="menu-label">多条消息只通知1次</span><span className="menu-desc">同一角色连续多条消息只在第一条时播放</span></div>
                                                <Toggle checked={config.notifyOncePerBurst === true} onChange={checked => changeSound(kind, { notifyOncePerBurst: checked })} />
                                            </div>
                                        </div>
                                        {config.value ? (
                                            <div className="chat-sound-editor-row chat-sound-test-row">
                                                <button className="ui-btn ui-btn-outline chat-sound-file-btn" onClick={testNewMessageNotice}>
                                                    <BellRing size={14} /> 测试弹窗
                                                </button>
                                                <span className="chat-sound-source">模拟一条新消息：弹通知横幅并播放音效</span>
                                            </div>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}

export function GlobalChatInfoSettings({ onBack }: { onBack: () => void }) {
    const initial = loadChatAppSettings();
    const [avatar, setAvatar] = useState(initial.globalChatUserAvatar || "");
    const [background, setBackground] = useState(initial.globalChatBackgroundImage || "");
    const [backgroundPreview, setBackgroundPreview] = useState("");
    const [customCSS, setCustomCSS] = useState(initial.globalChatCustomCSS || "");
    const [visionLimit, setVisionLimit] = useState(() => normalizeVisionImagePromptLimit(initial.globalVisionImagePromptLimit));
    const [status, setStatus] = useState<StatusRegionConfig>(() => getStatusRegionConfig(GLOBAL_CHAT_STATUS_REGION_ID, false));
    const [meetingInvite, setMeetingInvite] = useState<MeetingInviteCardConfig>(() => resolveMeetingInviteCardConfig(initial));
    const [editingCSS, setEditingCSS] = useState(false);
    const [editingStatus, setEditingStatus] = useState(false);
    const [editingMeetingInvite, setEditingMeetingInvite] = useState(false);
    const [draftCSS, setDraftCSS] = useState(customCSS);
    const [draftStatus, setDraftStatus] = useState(status);
    const [draftMeetingInvite, setDraftMeetingInvite] = useState(meetingInvite);
    const [meetingPreviewHtml, setMeetingPreviewHtml] = useState(meetingInvite.renderHtml);
    const avatarInputRef = useRef<HTMLInputElement>(null);
    const backgroundInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let cancelled = false;
        if (!background) { setBackgroundPreview(""); return; }
        if (background.startsWith("data:") || background.startsWith("http")) {
            setBackgroundPreview(background);
            return;
        }
        void getChatImageFromIndexedDB(background).then(url => {
            if (!cancelled) setBackgroundPreview(url || "");
        });
        return () => { cancelled = true; };
    }, [background]);

    const changeAvatar = async (file?: File) => {
        if (!file) return;
        try {
            const value = await fileToUserAvatarDataUrl(file);
            setAvatar(value);
            saveSettings({ globalChatUserAvatar: value });
        } catch { alert("头像图片处理失败，请换一张图片重试"); }
    };

    const changeBackground = async (file?: File) => {
        if (!file) return;
        try {
            const id = await saveChatImageToIndexedDB(file);
            setBackground(id);
            saveSettings({ globalChatBackgroundImage: id });
        } catch { alert("背景图片保存失败，请换一张图片重试"); }
    };

    const changeVisionLimit = (value: unknown) => {
        const next = normalizeVisionImagePromptLimit(value);
        setVisionLimit(next);
        saveSettings({ globalVisionImagePromptLimit: next });
    };

    // 全部角色恢复默认：清空每个会话的单独聊天室 CSS，全部回落到全局聊天室 CSS / 主页外观 CSS。
    // 逐个派发 chat-session-css-updated，让正打开的聊天室（含桌面小窗）立即生效。
    const resetAllSessionCSS = () => {
        const sessions = loadChatSessions();
        const withCSS = sessions.filter(s => (s.customCSS || "").trim());
        if (!withCSS.length) { alert("所有聊天都在跟随全局样式，没有需要恢复的"); return; }
        if (!window.confirm(`将清除 ${withCSS.length} 个私聊/群聊的单独 CSS，全部恢复为默认样式（全局聊天室 CSS 不受影响）。确定继续吗？`)) return;
        saveChatSessions(sessions.map(s => (s.customCSS || "").trim() ? { ...s, customCSS: "" } : s));
        for (const s of withCSS) {
            window.dispatchEvent(new CustomEvent("chat-session-css-updated", { detail: { sessionId: s.id, css: "" } }));
        }
        alert(`已恢复 ${withCSS.length} 个聊天的默认样式`);
    };

    const statusPayload = JSON.stringify({
        type: "ai-phone-status-region",
        version: 1,
        contract: draftStatus.contract,
        renderHtml: draftStatus.renderHtml,
        previewRaw: draftStatus.previewRaw || "",
    }, null, 2);

    const loadStatusPayload = (payload: string) => {
        try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            setDraftStatus(current => ({
                ...current,
                mode: "custom",
                contract: typeof parsed.contract === "string" ? parsed.contract : "",
                renderHtml: typeof parsed.renderHtml === "string" ? parsed.renderHtml : "",
                previewRaw: typeof parsed.previewRaw === "string" ? parsed.previewRaw : "",
            }));
        } catch { alert("导入失败：不是有效的状态栏方案"); }
    };

    const meetingInvitePayload = JSON.stringify({
        type: "ai-phone-meeting-invite-card",
        version: 1,
        contract: draftMeetingInvite.contract,
        renderHtml: draftMeetingInvite.renderHtml,
        previewRaw: draftMeetingInvite.previewRaw,
    }, null, 2);

    const loadMeetingInvitePayload = (payload: string) => {
        try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            const next: MeetingInviteCardConfig = {
                mode: "custom",
                contract: typeof parsed.contract === "string" ? parsed.contract : DEFAULT_MEETING_INVITE_CONTRACT,
                renderHtml: typeof parsed.renderHtml === "string" ? parsed.renderHtml : DEFAULT_MEETING_INVITE_RENDER,
                previewRaw: typeof parsed.previewRaw === "string" ? parsed.previewRaw : DEFAULT_MEETING_INVITE_PREVIEW,
            };
            setDraftMeetingInvite(next);
            setMeetingPreviewHtml(next.renderHtml);
        } catch { alert("导入失败：不是有效的邀请见面卡片方案"); }
    };

    if (editingCSS) {
        return (
            <PageShell title="全局聊天室 CSS" onBack={() => setEditingCSS(false)} className="absolute inset-0 z-[110]">
                <div className="theme-section-page">
                    <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">作用于所有私聊和群聊；单独会话 CSS 会覆盖这里，主页“外观 CSS”优先级最低。</p>
                    <textarea className="ui-textarea font-mono ts-13 leading-relaxed flex-1" style={{ minHeight: 320, resize: "none" }} value={draftCSS} onChange={event => setDraftCSS(event.target.value)} spellCheck={false} placeholder={CHAT_SESSION_CSS_EXAMPLE} />
                    <div className="flex gap-2 mt-3 items-center">
                        <CSSSchemeBar target="chat_session" currentCSS={draftCSS} onLoad={setDraftCSS} />
                        <button className="ui-btn ui-btn-outline flex-1" onClick={() => setDraftCSS(CHAT_SESSION_CSS_EXAMPLE)}>示例</button>
                        <button className="ui-btn ui-btn-outline flex-1" onClick={() => setDraftCSS("")}>清除</button>
                        <button className="ui-btn ui-btn-soft-action flex-1" onClick={() => { setCustomCSS(draftCSS); saveSettings({ globalChatCustomCSS: draftCSS }); setEditingCSS(false); }}>应用</button>
                    </div>
                </div>
            </PageShell>
        );
    }

    if (editingMeetingInvite) {
        return (
            <PageShell title="邀请见面卡片 CSS 样式" onBack={() => setEditingMeetingInvite(false)} className="absolute inset-0 z-[110]">
                <div className="theme-section-page flex flex-col gap-3">
                    <div className="menu-group">
                        <div className="menu-item">
                            <div className="menu-label-group"><span className="menu-label">启用自定义卡片</span><span className="menu-desc">关闭时使用 Pneuma 默认邀请卡片</span></div>
                            <Toggle checked={draftMeetingInvite.mode === "custom"} onChange={checked => setDraftMeetingInvite(current => ({ ...current, mode: checked ? "custom" : "native" }))} />
                        </div>
                    </div>
                    {draftMeetingInvite.mode === "custom" ? <>
                        <label className="ts-13 font-medium text-[var(--c-text-title)]">输出契约</label>
                        <textarea className="ui-textarea font-mono ts-12" style={{ minHeight: 130, resize: "vertical" }} value={draftMeetingInvite.contract} onChange={event => setDraftMeetingInvite(current => ({ ...current, contract: event.target.value }))} placeholder="告诉 AI 何时发起邀请；固定标记由系统兜底" />
                        <label className="ts-13 font-medium text-[var(--c-text-title)]">输出渲染</label>
                        <textarea className="ui-textarea font-mono ts-12" style={{ minHeight: 210, resize: "vertical" }} value={draftMeetingInvite.renderHtml} onChange={event => setDraftMeetingInvite(current => ({ ...current, renderHtml: event.target.value }))} placeholder="完整 HTML / CSS / JS；按钮使用 data-meeting-action=accept 或 decline" />
                        <div className="flex items-center justify-between gap-2">
                            <label className="ts-13 font-medium text-[var(--c-text-title)]">预览</label>
                            <button type="button" className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => setMeetingPreviewHtml(draftMeetingInvite.renderHtml)} aria-label="运行预览" title="运行预览"><Play size={15} /></button>
                        </div>
                        <textarea className="ui-textarea font-mono ts-12" style={{ minHeight: 100, resize: "vertical" }} value={draftMeetingInvite.previewRaw} onChange={event => setDraftMeetingInvite(current => ({ ...current, previewRaw: event.target.value }))} placeholder="可编辑的示例数据" />
                        {meetingPreviewHtml.trim() ? <div className="rounded-2xl border border-[var(--c-card-border)] p-3 overflow-hidden"><CustomStatusFrame html={meetingPreviewHtml} raw={draftMeetingInvite.previewRaw} kind="meeting" title="邀请见面卡片预览" /></div> : null}
                    </> : null}
                    <div className="flex gap-2 items-center">
                        <CSSSchemeBar target="meeting_invite_card" currentCSS={meetingInvitePayload} onLoad={loadMeetingInvitePayload} />
                        <button className="ui-btn ui-btn-outline flex-1" onClick={() => {
                            const next = { mode: "native", contract: DEFAULT_MEETING_INVITE_CONTRACT, renderHtml: DEFAULT_MEETING_INVITE_RENDER, previewRaw: DEFAULT_MEETING_INVITE_PREVIEW } as MeetingInviteCardConfig;
                            setDraftMeetingInvite(next);
                            setMeetingPreviewHtml(next.renderHtml);
                        }}>恢复默认</button>
                        <button className="ui-btn ui-btn-soft-action flex-1" onClick={() => {
                            setMeetingInvite(draftMeetingInvite);
                            saveSettings({ meetingInviteCard: draftMeetingInvite });
                            setEditingMeetingInvite(false);
                        }}>应用</button>
                    </div>
                </div>
            </PageShell>
        );
    }

    if (editingStatus) {
        return (
            <PageShell title="全局私聊状态栏" onBack={() => setEditingStatus(false)} className="absolute inset-0 z-[110]">
                <div className="theme-section-page flex flex-col gap-3">
                    <div className="menu-group">
                        <div className="menu-item">
                            <div className="menu-label-group"><span className="menu-label">启用自定义状态栏</span><span className="menu-desc">关闭时使用 Pneuma 原生状态栏</span></div>
                            <Toggle checked={draftStatus.mode === "custom"} onChange={checked => setDraftStatus(current => ({ ...current, mode: checked ? "custom" : "native" }))} />
                        </div>
                    </div>
                    {draftStatus.mode === "custom" && <>
                        <label className="ts-13 font-medium text-[var(--c-text-title)]">输出契约</label>
                        <textarea className="ui-textarea font-mono ts-12" style={{ minHeight: 150, resize: "vertical" }} value={draftStatus.contract} onChange={event => setDraftStatus(current => ({ ...current, contract: event.target.value }))} placeholder="告诉 AI 状态栏需要输出哪些字段与格式" />
                        <label className="ts-13 font-medium text-[var(--c-text-title)]">渲染 HTML</label>
                        <textarea className="ui-textarea font-mono ts-12" style={{ minHeight: 220, resize: "vertical" }} value={draftStatus.renderHtml} onChange={event => setDraftStatus(current => ({ ...current, renderHtml: event.target.value }))} placeholder="完整 HTML / CSS / JS" />
                    </>}
                    <div className="flex gap-2 items-center">
                        <CSSSchemeBar target={STATUS_REGION_SCHEME_TARGET} currentCSS={statusPayload} onLoad={loadStatusPayload} />
                        <button className="ui-btn ui-btn-outline flex-1" onClick={() => setDraftStatus({ mode: "native", contract: "", renderHtml: "", previewRaw: "" })}>恢复原生</button>
                        <button className="ui-btn ui-btn-soft-action flex-1" onClick={() => { setStatus(draftStatus); saveStatusRegionConfig(GLOBAL_CHAT_STATUS_REGION_ID, draftStatus); setEditingStatus(false); }}>应用</button>
                    </div>
                </div>
            </PageShell>
        );
    }

    return (
        <PageShell title="全局聊天信息" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu chat-info-menu">
                <div className="px-4 pb-2 ts-12 text-[var(--c-text)] opacity-65">单独会话设置优先于这里；这里只改变聊天室，不会修改主页用户资料。状态栏仍仅用于私聊。</div>
                <div className="menu-group">
                    <div className="menu-item cursor-pointer" role="button" tabIndex={0} onClick={() => avatarInputRef.current?.click()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") avatarInputRef.current?.click(); }}>
                        <User size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">用户头像</span><span className="menu-desc">所有私聊和群聊默认使用</span></div>
                        <div className="menu-right gap-2">
                            {avatar ? <img src={avatar} className="h-9 w-9 rounded-full object-cover" alt="全局聊天头像" /> : <span className="menu-desc">跟随用户资料</span>}
                            {avatar && <button aria-label="清除全局聊天头像" onClick={event => { event.stopPropagation(); setAvatar(""); saveSettings({ globalChatUserAvatar: "" }); }}><X size={15} /></button>}
                            <ChevronRight size={16} />
                        </div>
                    </div>
                    <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={event => { void changeAvatar(event.target.files?.[0]); event.target.value = ""; }} />
                    <button className="menu-item" onClick={() => { setDraftStatus(status); setEditingStatus(true); }}>
                        <LayoutPanelTop size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">私聊状态栏</span><span className="menu-desc">可从状态栏资源方案导入</span></div>
                        <div className="menu-right"><span className="menu-desc mr-1">{isCustomStatusRegionActive(status) ? "自定义" : "原生"}</span><ChevronRight size={16} /></div>
                    </button>
                    <button className="menu-item" onClick={() => {
                        setDraftMeetingInvite(meetingInvite);
                        setMeetingPreviewHtml(meetingInvite.renderHtml);
                        setEditingMeetingInvite(true);
                    }}>
                        <LayoutPanelTop size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">邀请见面卡片 CSS 样式</span><span className="menu-desc">自定义输出契约、输出渲染与预览</span></div>
                        <div className="menu-right"><span className="menu-desc mr-1">{meetingInvite.mode === "custom" ? "自定义" : "默认"}</span><ChevronRight size={16} /></div>
                    </button>
                    <div className="menu-item cursor-pointer" role="button" tabIndex={0} onClick={() => backgroundInputRef.current?.click()} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") backgroundInputRef.current?.click(); }}>
                        <ImageIcon size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">聊天背景</span><span className="menu-desc">所有私聊和群聊默认使用</span></div>
                        <div className="menu-right gap-2">
                            {backgroundPreview ? <img src={backgroundPreview} className="h-9 w-9 rounded-lg object-cover" alt="全局聊天背景" /> : <span className="menu-desc">未设置</span>}
                            {background && <button aria-label="清除全局聊天背景" onClick={event => { event.stopPropagation(); setBackground(""); saveSettings({ globalChatBackgroundImage: "" }); }}><X size={15} /></button>}
                            <ChevronRight size={16} />
                        </div>
                    </div>
                    <input ref={backgroundInputRef} type="file" accept="image/*" className="hidden" onChange={event => { void changeBackground(event.target.files?.[0]); event.target.value = ""; }} />
                    <button className="menu-item" onClick={() => { setDraftCSS(customCSS); setEditingCSS(true); }}>
                        <Code size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">聊天室自定义 CSS 样式</span><span className="menu-desc">与单独私聊共用资源方案</span></div>
                        <div className="menu-right"><span className="menu-desc mr-1">{customCSS ? "已设置" : "未设置"}</span><ChevronRight size={16} /></div>
                    </button>
                    <button className="menu-item" onClick={resetAllSessionCSS}>
                        <RotateCcw size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">全部角色恢复默认</span><span className="menu-desc">清除所有私聊和群聊的单独 CSS，改用全局样式</span></div>
                        <div className="menu-right" />
                    </button>
                    <div className="menu-item">
                        <ImageIcon size={20} className="text-[var(--c-icon)]" />
                        <div className="menu-label-group"><span className="menu-label">传入最近图片</span><span className="menu-desc">所有私聊和群聊的默认视觉上下文数量</span></div>
                        <div className="menu-right gap-2">
                            <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => changeVisionLimit(visionLimit - 1)} disabled={visionLimit <= 0}>-</button>
                            <input type="number" min={0} max={MAX_VISION_IMAGE_PROMPT_LIMIT} value={visionLimit} onChange={event => changeVisionLimit(event.target.value)} className="ui-input h-8 w-14 text-center" />
                            <button className="ui-btn ui-btn-ghost h-8 w-8 p-0" onClick={() => changeVisionLimit(visionLimit + 1)} disabled={visionLimit >= MAX_VISION_IMAGE_PROMPT_LIMIT}>+</button>
                        </div>
                    </div>
                </div>
                <div className="px-4 pt-3 pb-2 ts-12 font-medium text-[var(--c-text-title)] opacity-80">提示音</div>
                <ChatSoundsSection />
            </div>
        </PageShell>
    );
}
