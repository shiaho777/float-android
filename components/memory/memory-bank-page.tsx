"use client";

import { Component, useState, useEffect, useCallback, useMemo, type CSSProperties, type ReactNode } from "react";
import { Trash2, Zap, Clock, Users, Archive, AlertCircle, Search, Brain, FileText, MoreHorizontal, Plus, Edit3, X, Check, ChevronRight, Filter, type LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import { getMemoryEventSourceTag, MEMORY_SOURCE_TAG_ORDER, MemoryTimeline } from "./memory-timeline";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MemoryEntry, MemoryConfig, MemoryKind } from "@/lib/memory-types";
import {
    DEFAULT_CORE_MEMORY_PROMPT,
    DEFAULT_SUMMARIZATION_PROMPT,
    DEFAULT_SUMMARIZATION_PROMPT_V2,
    DEFAULT_SUMMARIZATION_PROMPT_V3,
    LEGACY_SUMMARIZATION_PROMPT_V2,
    effectiveSalience,
    memoryKindOf,
    memoryStatusOf,
} from "@/lib/memory-types";
import {
    loadMemoryConfig,
    saveMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteCharacterMemoriesByType,
    getAllCharacterIdsWithMemories,
    getMemoryCountByType,
    getLastSummarizedTimestamp,
    getLastCoreSummarizedTimestamp,
} from "@/lib/memory-storage";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runSummarizationPipeline } from "@/lib/memory-summarizer";
import { runCoreMemoryPipeline } from "@/lib/core-memory-builder";
import { buildMemoryIndex, resolveEvidenceChain, buildChainTree, diagnoseMemoryHealth, repairDanglingLinks, type MemoryChainNode, type MemoryHealthReport } from "@/lib/memory-graph";
import { loadPersonaState, revertTraitShift, type PersonaState } from "@/lib/persona-state";
import { runConsolidation } from "@/lib/memory-consolidation";
import { invalidateMemoryEntry, restoreMemoryEntry } from "@/lib/memory-correction";
import { clearMemoryRecallLog, exportMemoryRecallLog, readMemoryRecallLog } from "@/lib/memory-recall-log";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "core" | "long";
type MemoryBudgetKey = "shortTermTokenBudget" | "coreMemoryTokenBudget" | "longTermTokenBudget";

const MEMORY_TOKEN_BUDGET_MAX = 100000;
const MEMORY_TOKEN_BUDGET_MIN: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    coreMemoryTokenBudget: 100,
    longTermTokenBudget: 200,
};
// 步长取细档：默认值（短期 16000 / 核心 1200 / 长期 3000）必须正好落在滑条
// 网格上，否则浏览器会把显示值吸附到邻近档位——看起来像"我设的值没生效"。
const MEMORY_TOKEN_BUDGET_STEP: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    coreMemoryTokenBudget: 100,
    longTermTokenBudget: 100,
};
const MANUAL_MEMORY_CONTENT_LIMIT = 3000;

/**
 * 总结提示词的"默认"判定：v1 / v2 / v3 的出厂文本都算默认。
 * 否则老用户库存的是 v2 出厂文本，界面会把"从没改过"显示成"已修改"，
 * 点"恢复默认"又写回 v1——与实际运行的 v3 张冠李戴。
 */
const isStoredSummarizationPromptDefault = (value?: string): boolean =>
    !value
    || value === DEFAULT_SUMMARIZATION_PROMPT_V3
    || value === DEFAULT_SUMMARIZATION_PROMPT_V2
    || value === DEFAULT_SUMMARIZATION_PROMPT
    || value === LEGACY_SUMMARIZATION_PROMPT_V2;

/** 非有效状态的展示名（作废 / 待重算 / 已替代）。 */
const MEMORY_STATUS_LABEL: Record<string, string> = {
    superseded: "已替代",
    needs_review: "待重算",
    invalid: "已作废",
    unverified: "未核验",
};// 详情页时间线最多解析渲染的条数：全量历史可能有几万条，
// 一次性解析+渲染会把 iOS Safari 的单页内存顶爆（灰屏杀页）
const MEMORY_TIMELINE_ENTRY_CAP = 2000;

/** 详情页兜底：时间线渲染抛错时显示提示，而不是整页白屏 */
class MemoryDetailBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) {
            return <p className="text-center ts-14 mt-10 text-secondary">这一页加载出错了，返回上一页再试一次。</p>;
        }
        return this.props.children;
    }
}

type SummarizeRange = "auto" | "all" | number;

const SUMMARIZE_RANGE_OPTIONS: Array<{ value: SummarizeRange; label: string; desc?: string }> = [
    { value: "auto", label: "接着上次总结", desc: "默认方式，从上次进度继续" },
    { value: 1, label: "最近 1 天" },
    { value: 3, label: "最近 3 天" },
    { value: 7, label: "最近 7 天" },
    { value: 14, label: "最近 14 天" },
    { value: 30, label: "最近 30 天" },
    { value: "all", label: "全部历史" },
];

type MemorySourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;

/** 记忆来源开关：同时作用于短期上下文与长期总结 */
const MEMORY_SOURCE_OPTIONS: Array<{ key: MemorySourceKey; label: string }> = [
    { key: "chat", label: "私聊上下文" },
    { key: "group_chat", label: "群聊上下文" },
    { key: "moments", label: "朋友圈" },
    { key: "checkphone", label: "查手机" },
    { key: "diary", label: "手记便签" },
    { key: "xiaohongshu", label: "小红书" },
    { key: "interview_magazine", label: "在场访谈" },
    { key: "cocreate", label: "共创" },
    { key: "game", label: "内置小游戏" },
    { key: "story", label: "剧情小剧场" },
    { key: "vn", label: "漫卷" },
    { key: "adventure", label: "地图冒险" },
    { key: "custom_app", label: "自定义应用" },
];

type MemoryEditorState = {
    type: MemoryEntry["type"];
    entry?: MemoryEntry;
    content: string;
};

const memorySettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function MemorySettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="card-icon" style={memorySettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <div className="menu-item memory-slider-item">
            <div className="memory-slider-header">
                <MemorySettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc">{desc}</span>
                </div>
                <span className="ui-slider-value memory-slider-current">{value}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="ui-slider memory-settings-slider"
                aria-label={label}
            />
        </div>
    );
}

const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
    episode: "事件",
    summary: "摘要",
    reflection: "反思",
    trait_shift: "漂移",
};

const MEMORY_KIND_VARIANT: Record<MemoryKind, string> = {
    episode: "info",
    summary: "default",
    reflection: "accent",
    trait_shift: "warn",
};

function relativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    return `${Math.floor(days / 30)}个月前`;
}

type CharacterMemoryInfo = {
    character: Character;
    longTermCount: number;
    coreCount: number;
    shortTermCount: number;
};

type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
    filterOpen?: boolean;
    onFilterOpenChange?: (open: boolean) => void;
    onFilterStateChange?: (state: { visible: boolean; activeCount: number }) => void;
};

export function MemoryBankPage({
    view,
    selectedCharId,
    onSelectChar,
    onNotice,
    filterOpen = false,
    onFilterOpenChange,
    onFilterStateChange,
}: Props) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [characters, setCharacters] = useState<CharacterMemoryInfo[]>([]);
    const [activeTab, setActiveTab] = useState<MemoryTab>("short");
    const [coreEntries, setCoreEntries] = useState<MemoryEntry[]>([]);
    const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
    const [personaState, setPersonaState] = useState<PersonaState | null>(null);
    const [consolidating, setConsolidating] = useState(false);
    const [longTermView, setLongTermView] = useState<"list" | "chain">("chain");
    const [shortTermEvents, setShortTermEvents] = useState<NativeTimelineEntry[]>([]);
    const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [summarizing, setSummarizing] = useState(false);
    const [rebuildingCore, setRebuildingCore] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
    const [editingCorePrompt, setEditingCorePrompt] = useState<string | null>(null);
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [summarizeRangeOpen, setSummarizeRangeOpen] = useState(false);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    const [activeTimelineTags, setActiveTimelineTags] = useState<Set<string>>(new Set());
    /** 检索日志条数，进入设置页时刷新一次（只用于文案） */
    const [logCount, setLogCount] = useState(0);

    useEffect(() => {
        if (view !== "settings") return;
        setLogCount(readMemoryRecallLog().length);
    }, [view]);

    const handleExportLog = useCallback(async () => {
        const { downloadFile } = await import("@/lib/download-utils");
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        await downloadFile(
            new Blob([exportMemoryRecallLog()], { type: "application/json" }),
            `float-memory-log-${stamp}.json`,
        );
    }, []);

    const handleClearLog = useCallback(() => {
        clearMemoryRecallLog();
        setLogCount(0);
    }, []);

    const disabledSourceCount = MEMORY_SOURCE_OPTIONS
        .filter(source => (config.shortTermAllowedSources ?? {})[source.key] === false).length;

    // Resolve selected character object from ID
    const selectedChar = selectedCharId
        ? loadCharacters().find(c => c.id === selectedCharId) ?? null
        : null;

    const filterEvents = activeTab === "shared" ? sharedEvents : shortTermEvents;
    const timelineTagCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const event of filterEvents) {
            const tag = getMemoryEventSourceTag(event);
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
        return Array.from(counts.entries()).sort((a, b) =>
            MEMORY_SOURCE_TAG_ORDER.indexOf(a[0]) - MEMORY_SOURCE_TAG_ORDER.indexOf(b[0]));
    }, [filterEvents]);

    const timelineFilterVisible = view === "detail" && (activeTab === "short" || activeTab === "shared");

    useEffect(() => {
        onFilterStateChange?.({ visible: timelineFilterVisible, activeCount: activeTimelineTags.size });
    }, [activeTimelineTags.size, onFilterStateChange, timelineFilterVisible]);

    useEffect(() => {
        setActiveTimelineTags(new Set());
        onFilterOpenChange?.(false);
    }, [activeTab, onFilterOpenChange, selectedCharId]);

    const loadCharacterList = useCallback(async (isCancelled?: () => boolean) => {
        const allChars = loadCharacters();

        let charIdsWithMem: string[] = [];
        try { charIdsWithMem = await getAllCharacterIdsWithMemories(); } catch { /* DB may fail */ }

        const infos: CharacterMemoryInfo[] = [];
        const seen = new Set<string>();

        // Characters with memories first
        for (const id of charIdsWithMem) {
            const char = allChars.find(c => c.id === id);
            if (!char) continue;
            seen.add(id);
            let ltCount = 0;
            let coreCount = 0;
            try {
                [ltCount, coreCount] = await Promise.all([
                    getMemoryCountByType(id, "long_term"),
                    getMemoryCountByType(id, "core"),
                ]);
            } catch { /* ignore */ }
            infos.push({ character: char, longTermCount: ltCount, coreCount, shortTermCount: 0 });
        }

        // Remaining characters
        for (const char of allChars) {
            if (seen.has(char.id)) continue;
            infos.push({ character: char, longTermCount: 0, coreCount: 0, shortTermCount: 0 });
        }

        if (isCancelled?.()) return;
        setCharacters(infos);

        // 短期计数逐个异步补齐：loadNativeTimeline 是全量组装，重数据账号
        // 在循环里同步跑完会长时间卡死主线程、瞬时吃掉大量内存
        for (const info of infos) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (isCancelled?.()) return;
            let stCount = 0;
            try { stCount = loadNativeTimeline(info.character.id).length; } catch { /* ignore */ }
            if (isCancelled?.()) return;
            setCharacters(prev => prev.map(item =>
                item.character.id === info.character.id ? { ...item, shortTermCount: stCount } : item));
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadCharacterList(() => cancelled);
        return () => { cancelled = true; };
    }, [loadCharacterList]);

    // 记忆链索引：core + long_term 混合，links 可跨层引用
    const allEntriesIndex = useMemo(
        () => buildMemoryIndex([...coreEntries, ...longTermEntries]),
        [coreEntries, longTermEntries],
    );

    // Load detail data when entering detail view
    const loadDetailData = useCallback(async (charId: string) => {
        setLoading(true);
        try {
            await hydrateChatStorage();
            const [core, lt] = await Promise.all([
                loadMemoryEntriesByType(charId, "core"),
                loadMemoryEntriesByType(charId, "long_term"),
            ]);
            setCoreEntries(core);
            setLongTermEntries(lt);
        } catch {
            setCoreEntries([]);
            setLongTermEntries([]);
        }
        // Native timeline is sync (localStorage) — no await needed.
        // 只取最近一段（全量可能几万条），防止解析+渲染把 iOS Safari 内存顶爆
        setPersonaState(loadPersonaState(charId));
        const timeline = loadNativeTimeline(charId).slice(-MEMORY_TIMELINE_ENTRY_CAP);
        setShortTermEvents(timeline.filter(e =>
            !(e.sourceApp === "moments" && e.postAuthorType === "user")
            && !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setSharedEvents(timeline.filter(e =>
            (e.sourceApp === "moments" && e.postAuthorType === "user") ||
            (e.sourceApp === "chat" && e.sourceDetail === "group") ||
            (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setLoading(false);
    }, []);

    // Reload detail data when view changes to detail
    useEffect(() => {
        if (view === "detail" && selectedCharId) {
            setActiveTab("short");
            setExpandedId(null);
            loadDetailData(selectedCharId);
        }
    }, [view, selectedCharId, loadDetailData]);

    // Reset editing prompt when leaving settings
    useEffect(() => {
        if (view !== "settings") {
            setEditingPrompt(null);
            setEditingCorePrompt(null);
        }
    }, [view]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    const handleDeleteEntry = async (id: string) => {
        await deleteMemoryEntry(id);
        setCoreEntries(prev => prev.filter(e => e.id !== id));
        setLongTermEntries(prev => prev.filter(e => e.id !== id));
        setEntryMenuId(null);
        loadCharacterList();
    };

    const handleClearEntries = async (type: "core" | "long_term") => {
        if (!selectedCharId) return;
        await deleteCharacterMemoriesByType(selectedCharId, type);
        if (type === "core") setCoreEntries([]);
        else setLongTermEntries([]);
        loadCharacterList();
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
    };

    const handleManualSummarize = async (range: SummarizeRange = "auto") => {
        if (!selectedCharId || summarizing) return;
        setSummarizeRangeOpen(false);
        setSummarizing(true);
        try {
            const sinceTimestamp = typeof range === "number"
                ? new Date(Date.now() - range * 86400000).toISOString()
                : undefined;
            const afterTimestamp = range === "all"
                ? undefined
                : sinceTimestamp ?? getLastSummarizedTimestamp(selectedCharId) ?? undefined;
            const timelineCount = loadNativeTimeline(selectedCharId, {
                ...(afterTimestamp ? { afterTimestamp } : {}),
                forPersonalMemory: true,
            }).length;
            if (timelineCount < 4) {
                showNotice("所选范围内事件不足 4 条");
                return;
            }

            const result = await runSummarizationPipeline(
                selectedCharId,
                selectedChar?.name ?? "",
                range === "all" ? { force: true } : sinceTimestamp ? { sinceTimestamp } : undefined,
            );
            if (result.success) {
                showNotice("总结完成");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "总结失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual summarize failed:", err);
            showNotice("总结失败: " + String(err));
        } finally {
            setSummarizing(false);
        }
    };

    const handleManualRebuildCore = async () => {
        if (!selectedCharId || rebuildingCore) return;
        setRebuildingCore(true);
        try {
            const lastCoreSummarizedAt = getLastCoreSummarizedTimestamp(selectedCharId);
            const longTermEntries = await loadMemoryEntriesByType(selectedCharId, "long_term");
            const pendingLongTermCount = longTermEntries.filter(entry =>
                !lastCoreSummarizedAt || entry.createdAt > lastCoreSummarizedAt
            ).length;
            if (pendingLongTermCount === 0) {
                showNotice(lastCoreSummarizedAt ? "没有新的长期记忆需要总结" : "没有可用于总结核心记忆的长期记忆");
                return;
            }

            const result = await runCoreMemoryPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                showNotice(result.rebuiltCount ? `核心记忆已重建（${result.rebuiltCount}条）` : "核心记忆已重建");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "核心记忆重建失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual core rebuild failed:", err);
            showNotice("核心记忆重建失败: " + String(err));
        } finally {
            setRebuildingCore(false);
        }
    };

    const saveBudget = (key: MemoryBudgetKey, value: number) => {
        if (!Number.isFinite(value)) return;
        const min = MEMORY_TOKEN_BUDGET_MIN[key];
        const nextValue = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        const next = { ...config, [key]: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(200, Math.max(10, Math.round(value)));
        const next = { ...config, summarizationEventInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveCoreInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(20, Math.max(1, Math.round(value)));
        const next = { ...config, coreSummarizationInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    // ── Prompt editing ──
    const handleSavePrompt = () => {
        if (editingPrompt === null) return;
        const next = { ...config, summarizationPrompt: editingPrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提示词已保存");
    };

    const handleResetPrompt = () => {
        setEditingPrompt(DEFAULT_SUMMARIZATION_PROMPT_V3);
        const next = { ...config, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT_V3 };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("已恢复默认提示词");
    };

    const handleSaveCorePrompt = () => {
        if (editingCorePrompt === null) return;
        const next = { ...config, coreMemoryPrompt: editingCorePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已保存");
    };

    const handleResetCorePrompt = () => {
        setEditingCorePrompt(DEFAULT_CORE_MEMORY_PROMPT);
        const next = { ...config, coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已恢复默认");
    };

    const createManualMemoryId = (type: MemoryEntry["type"]) => (
        `mem_${type === "core" ? "core" : "lt"}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const isManualMemoryEntry = (entry: MemoryEntry) => {
        const origin = String(entry.metadata?.origin ?? "");
        return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
    };

    const maybeBuildManualMemoryEmbedding = async (type: MemoryEntry["type"], content: string): Promise<number[] | undefined> => {
        if (type !== "long_term" || !config.vectorRecallEnabled) return undefined;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
        try {
            return await generateEmbedding(content, embeddingApiConfig) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const openCreateMemoryEditor = (type: MemoryEntry["type"]) => {
        setEntryMenuId(null);
        setMemoryEditor({ type, content: "" });
    };

    const openEditMemoryEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        setMemoryEditor({ type: entry.type, entry, content: entry.content });
    };

    const handleSaveManualMemory = async () => {
        if (!selectedCharId || !memoryEditor || savingMemory) return;
        const content = memoryEditor.content.trim();
        if (!content) {
            showNotice("记忆内容不能为空");
            return;
        }
        if (content.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内`);
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const type = memoryEditor.type;
            const source = memoryEditor.entry;
            const contentChanged = !source || source.content.trim() !== content;
            const embedding = type === "long_term"
                ? (contentChanged ? await maybeBuildManualMemoryEmbedding(type, content) : source?.embedding)
                : undefined;
            const entry: MemoryEntry = source
                ? {
                    ...source,
                    content,
                    embedding,
                    updatedAt: now,
                    metadata: {
                        ...(source.metadata ?? {}),
                        origin: isManualMemoryEntry(source) ? "user_manual" : "user_edited",
                        editedByUser: true,
                    },
                }
                : {
                    id: createManualMemoryId(type),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type,
                    content,
                    embedding,
                    importance: type === "core" ? 0.95 : 0.8,
                    createdAt: now,
                    updatedAt: now,
                    metadata: {
                        origin: "user_manual",
                    },
                };

            await saveMemoryEntry(entry);
            if (type === "core") {
                setCoreEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            } else {
                setLongTermEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            }
            setMemoryEditor(null);
            setExpandedId(entry.id);
            loadCharacterList();
            showNotice(type === "core" ? "核心记忆已保存" : "长期记忆已保存");
        } catch (error) {
            console.error("[MemoryBank] Save manual memory failed:", error);
            showNotice("记忆保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    const handleRevertDrift = (index: number) => {
        if (!selectedCharId) return;
        if (revertTraitShift(selectedCharId, index)) {
            setPersonaState(loadPersonaState(selectedCharId));
            showNotice("已撤销该性格变化");
        }
    };

    // 人格状态面板：反思沉淀出的性格漂移 + 心情，全部可撤销。
    const renderPersonaPanel = () => {
        if (!personaState) return null;
        const activeTraits = personaState.traits.filter(t => Math.abs(t.delta) >= 0.08);
        const mood = personaState.currentMood;
        const moodActive = mood && (!mood.until || Date.parse(mood.until) > Date.now());
        const hasLog = personaState.driftLog.length > 0;
        if (!activeTraits.length && !moodActive && !personaState.moodBaseline && !hasLog) return null;
        return (
            <div className="mem-persona-panel">
                <div className="mem-persona-title">人格状态</div>
                {activeTraits.length > 0 && (
                    <div className="mem-persona-traits">
                        {activeTraits.map(t => (
                            <span key={t.key} className="mem-persona-trait">
                                {t.delta > 0 ? "+" : "−"}{t.key}
                            </span>
                        ))}
                    </div>
                )}
                {personaState.moodBaseline && (
                    <div className="mem-persona-mood">常态心情：{personaState.moodBaseline}</div>
                )}
                {moodActive && mood && (
                    <div className="mem-persona-mood">此刻心情：{mood.label}</div>
                )}
                {hasLog && (
                    <div className="mem-persona-log">
                        {personaState.driftLog.slice(-6).reverse().map((log, i) => {
                            const realIndex = personaState.driftLog.length - 1 - i;
                            const linked = allEntriesIndex.get(log.sourceEntryId);
                            return (
                                <div key={`${log.at}-${realIndex}`} className={`mem-persona-log-item${log.reverted ? " reverted" : ""}`}>
                                    <span className="mem-persona-log-change">
                                        {log.change}
                                        {linked && <em title={linked.content}>（证据）</em>}
                                    </span>
                                    {!log.reverted && (
                                        <button className="mem-persona-revert" onClick={() => handleRevertDrift(realIndex)}>撤销</button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    // 记忆诊断：体检报告（死链/重复/游离角色/未挂链散点）+ 死链一键修复。
    const [diagReport, setDiagReport] = useState<MemoryHealthReport | null>(null);
    const handleDiagnose = () => {
        const entries = [...coreEntries, ...longTermEntries];
        const validIds = new Set(loadCharacters().map(c => c.id));
        setDiagReport(diagnoseMemoryHealth(entries, validIds));
    };
    const handleRepairLinks = async () => {
        if (!diagReport) return;
        const entries = [...coreEntries, ...longTermEntries];
        const changed = repairDanglingLinks(entries);
        for (const e of changed) await saveMemoryEntry(e);
        showNotice(`已清理 ${changed.length} 条记忆里的死链`);
        setDiagReport(null);
        if (selectedCharId) await loadDetailData(selectedCharId);
    };

    const handleRunConsolidation = async () => {
        if (!selectedCharId || !selectedChar || consolidating) return;
        setConsolidating(true);
        try {
            // manual：用户显式点了"整理记忆"，不受"自动反思"总闸限制。
            const result = await runConsolidation(selectedCharId, selectedChar.name, undefined, { manual: true });
            if (!result.ran) {
                showNotice(result.error || "素材不足，暂无可整理的沉淀");
            } else {
                showNotice(`整理完成：${result.reflections} 条洞察、${result.traitShifts} 处性格变化、合并 ${result.deduped} 条重复`);
                await loadDetailData(selectedCharId);
            }
        } catch (error) {
            showNotice("整理失败：" + String(error));
        } finally {
            setConsolidating(false);
        }
    };

    /**
     * 作废一条记忆。派生条目（总结 / 反思 / 性格变化）会沿证据链一起失效并停止召回——
     * 只改一条却让派生副本继续生效，正是"修正正文后错误总结仍然生效"的来源。
     */
    const handleInvalidateEntry = async (entryId: string) => {
        if (!selectedCharId) return;
        try {
            const outcome = await invalidateMemoryEntry(selectedCharId, entryId, { reason: "记忆页手工作废" });
            if (!outcome.changed.length) {
                showNotice(outcome.skipped[0]?.reason ?? "没有条目被改动");
                return;
            }
            const derived = outcome.changed.length - 1;
            showNotice(derived > 0
                ? `已作废，并连带失效 ${derived} 条派生记忆（已停止召回，可恢复）`
                : "已作废（无派生条目）");
            await loadDetailData(selectedCharId);
        } catch (error) {
            showNotice("作废失败：" + String(error));
        }
    };

    const handleRestoreEntry = async (entryId: string) => {
        if (!selectedCharId) return;
        try {
            const outcome = await restoreMemoryEntry(selectedCharId, entryId);
            showNotice(outcome.changed.length ? "已恢复为有效" : (outcome.skipped[0]?.reason ?? "没有条目被改动"));
            await loadDetailData(selectedCharId);
        } catch (error) {
            showNotice("恢复失败：" + String(error));
        }
    };

    const renderChainNode = (node: MemoryChainNode, depth: number) => (
        <div key={node.entry.id} className="mem-chain-node" style={{ marginLeft: depth * 16 }}>
            <div className="mem-chain-node-head">
                <span className={`mem-origin-badge mem-kind-${memoryKindOf(node.entry)}`}>
                    {MEMORY_KIND_LABEL[memoryKindOf(node.entry)]}
                </span>
                <span className="ts-10 text-secondary">{relativeTime(node.entry.createdAt)}</span>
                <span className="mem-origin-badge">★{effectiveSalience(node.entry)}</span>
            </div>
            <div className="ts-12 leading-[1.6] mem-chain-content">{node.entry.content}</div>
            {node.children.map(child => renderChainNode(child, depth + 1))}
        </div>
    );

    // 链路视图：从衍生节点向下展开证据树，看清"经历→反思→性格变化"的传导。
    const renderChainView = (entries: MemoryEntry[]) => {
        const view = buildChainTree(entries);
        if (view.heads.length === 0) {
            return (
                <div className="mem-empty-card">
                    <p>还没有形成记忆链。记忆积累后经「整理」会生成反思与性格变化的链式结构。</p>
                </div>
            );
        }
        return (
            <div className="mem-chain-view">
                <div className="mem-entry-toolbar">
                    <button className="mem-entry-add-btn" onClick={() => setLongTermView("list")}>
                        <span>列表</span>
                    </button>
                    <button className="mem-entry-add-btn" disabled={consolidating} onClick={handleRunConsolidation}>
                        <span>{consolidating ? "整理中…" : "立即整理"}</span>
                    </button>
                    <button className="mem-entry-clear-btn" onClick={() => setConfirmClearAll(true)}>
                        <Trash2 size={15} strokeWidth={1.8} />
                        <span>清除长期记忆</span>
                    </button>
                </div>
                {view.heads.map(head => (
                    <div key={head.entry.id} className="g-card memory-report-card mem-chain-head">
                        {renderChainNode(head, 0)}
                    </div>
                ))}
                {view.orphans.length > 0 && (
                    <div className="mem-chain-orphans">
                        <div className="ts-10 text-secondary" style={{ letterSpacing: "1px", margin: "8px 0 4px" }}>
                            未挂链 · {view.orphans.length}
                        </div>
                        {view.orphans.map(entry => (
                            <div key={entry.id} className="mem-chain-node" style={{ marginLeft: 0 }}>
                                <div className="mem-chain-node-head">
                                    <span className={`mem-origin-badge mem-kind-${memoryKindOf(entry)}`}>
                                        {MEMORY_KIND_LABEL[memoryKindOf(entry)]}
                                    </span>
                                    <span className="ts-10 text-secondary">{relativeTime(entry.createdAt)}</span>
                                </div>
                                <div className="ts-12 mem-chain-content">{entry.content.slice(0, 80)}{entry.content.length > 80 ? "…" : ""}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const renderMemoryEntries = (type: MemoryEntry["type"], entries: MemoryEntry[], emptyText: string) => {
        const label = type === "core" ? "核心记忆" : "长期记忆";
        return (
            <>
                {entries.length > 0 && (
                    <div className="mem-entry-toolbar">
                        <button
                            className="mem-entry-add-btn"
                            onClick={() => openCreateMemoryEditor(type)}
                        >
                            <Plus size={15} strokeWidth={1.8} />
                            <span>新增{label}</span>
                        </button>
                        <button
                            className="mem-entry-clear-btn"
                            onClick={() => setConfirmClearAll(true)}
                        >
                            <Trash2 size={15} strokeWidth={1.8} />
                            <span>清除{label}</span>
                        </button>
                        {type === "long_term" && (
                            <>
                                <button
                                    className="mem-entry-add-btn"
                                    onClick={() => setLongTermView(v => v === "chain" ? "list" : "chain")}
                                >
                                    <span>{longTermView === "chain" ? "列表" : "链路"}</span>
                                </button>
                                <button
                                    className="mem-entry-add-btn"
                                    disabled={consolidating}
                                    onClick={handleRunConsolidation}
                                >
                                    <span>{consolidating ? "整理中…" : "立即整理"}</span>
                                </button>
                                <button
                                    className="mem-entry-add-btn"
                                    onClick={handleDiagnose}
                                >
                                    <span>诊断</span>
                                </button>
                            </>
                        )}
                    </div>
                )}
                {diagReport && type === "long_term" && (
                    <div className="g-card memory-report-card" style={{ padding: "12px 14px", marginBottom: 10 }}>
                        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                            <strong className="ts-12">记忆诊断（共 {diagReport.total} 条）</strong>
                            <button className="mem-entry-add-btn" onClick={() => setDiagReport(null)}><span>关闭</span></button>
                        </div>
                        <div className="ts-12 leading-[1.8]">
                            <div>死链（证据指向已删除记忆）：{diagReport.danglingLinks.length} 条{diagReport.danglingLinks.length > 0 && <button className="mem-entry-add-btn" style={{ marginLeft: 8 }} onClick={handleRepairLinks}><span>一键修复</span></button>}</div>
                            <div>完全重复的条目组：{diagReport.duplicateGroups.length} 组{diagReport.duplicateGroups.length > 0 && "（可在整理时自动合并）"}</div>
                            <div>未挂链的散点 episode：{diagReport.unlinkedEpisodes.length} 条</div>
                            <div>归属角色已不存在的记忆：{diagReport.foreignCharacterEntries.length} 条</div>
                            <div>空内容条目：{diagReport.emptyContent.length} 条</div>
                        </div>
                    </div>
                )}
                {entryMenuId && (
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={() => setEntryMenuId(null)}
                    />
                )}
                {entries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{emptyText}</p>
                        <button className="mem-empty-add-btn" onClick={() => openCreateMemoryEditor(type)}>
                            <Plus size={14} />
                            <span>新增{label}</span>
                        </button>
                    </div>
                ) : (
                    entries.map(entry => (
                        <div
                            key={entry.id}
                            className={`g-card memory-report-card${entryMenuId === entry.id ? " is-menu-open" : ""}`}
                            onClick={() => {
                                if (entryMenuId) {
                                    setEntryMenuId(null);
                                    return;
                                }
                                setExpandedId(expandedId === entry.id ? null : entry.id);
                            }}
                        >
                            <div className="mem-report-head">
                                <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {relativeTime(entry.createdAt)} ]</span>
                                <div className="mem-report-actions">
                                    <span className={`mem-origin-badge mem-kind-${memoryKindOf(entry)}`}>
                                        {MEMORY_KIND_LABEL[memoryKindOf(entry)]}
                                    </span>
                                    <span className="mem-origin-badge" title="重要性(1-10)">
                                        ★{effectiveSalience(entry)}
                                    </span>
                                    <span className={`mem-origin-badge ${isManualMemoryEntry(entry) ? "is-manual" : ""}`}>
                                        {isManualMemoryEntry(entry) ? "MANUAL" : "AUTO"}
                                    </span>
                                    {memoryStatusOf(entry) !== "active" && (
                                        <span className="mem-origin-badge">
                                            {MEMORY_STATUS_LABEL[memoryStatusOf(entry)] ?? memoryStatusOf(entry)}
                                        </span>
                                    )}
                                    <div className="mem-entry-menu-wrap">
                                        <button
                                            className="mem-entry-menu-btn"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setEntryMenuId(prev => prev === entry.id ? null : entry.id);
                                            }}
                                            title="更多"
                                        >
                                            <MoreHorizontal size={18} />
                                        </button>
                                        {entryMenuId === entry.id && (
                                            <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                                                <button onClick={() => openEditMemoryEditor(entry)}>
                                                    <Edit3 size={13} />
                                                    <span>编辑</span>
                                                </button>
                                                {memoryStatusOf(entry) === "active" ? (
                                                    <button
                                                        onClick={() => {
                                                            setEntryMenuId(null);
                                                            void handleInvalidateEntry(entry.id);
                                                        }}
                                                    >
                                                        <AlertCircle size={13} />
                                                        <span>标记为无效</span>
                                                    </button>
                                                ) : (
                                                    <button
                                                        onClick={() => {
                                                            setEntryMenuId(null);
                                                            void handleRestoreEntry(entry.id);
                                                        }}
                                                    >
                                                        <Check size={13} />
                                                        <span>恢复为有效</span>
                                                    </button>
                                                )}
                                                <button
                                                    className="is-danger"
                                                    onClick={() => {
                                                        setEntryMenuId(null);
                                                        setConfirmDeleteEntryId(entry.id);
                                                    }}
                                                >
                                                    <Trash2 size={13} />
                                                    <span>删除</span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="ts-12 leading-[1.7]">
                                {expandedId === entry.id
                                    ? entry.content
                                    : entry.content.length > 100
                                        ? entry.content.slice(0, 100) + "..."
                                        : entry.content
                                }
                            </div>
                            {expandedId === entry.id && (entry.links?.length ?? 0) > 0 && (
                                <div className="mem-evidence-chain">
                                    <div className="ts-10 text-secondary" style={{ letterSpacing: "1px" }}>证据链 · {entry.links!.length} 条支撑</div>
                                    {resolveEvidenceChain(entry, allEntriesIndex).map(linked => (
                                        <div key={linked.id} className="mem-evidence-item">
                                            <span className={`mem-origin-badge mem-kind-${memoryKindOf(linked)}`}>
                                                {MEMORY_KIND_LABEL[memoryKindOf(linked)]}
                                            </span>
                                            <span className="ts-11">{linked.content.slice(0, 60)}{linked.content.length > 60 ? "…" : ""}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))
                )}
            </>
        );
    };


    // ── Detail View ──
    if (view === "detail" && selectedChar) {
        return (
            <div className="flex flex-col absolute inset-0 overflow-hidden" style={{ padding: "0 16px" }}>
                {/* Content */}
                <div className="memory-detail-scroll flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
                    <MemoryDetailBoundary>
                    {loading ? (
                        <p className="text-center ts-14 mt-10 text-secondary">
                            加载中...
                        </p>
                    ) : activeTab === "short" ? (
                        /* ── Short-term: card view ── */
                        <>
                            <MemoryTimeline
                                events={shortTermEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                                activeTags={activeTimelineTags}
                            />
                        </>
                    ) : activeTab === "shared" ? (
                        /* ── Shared events: card view ── */
                        sharedEvents.length === 0 ? (
                            <p className="text-center ts-14 mt-10 text-secondary">
                                暂无共享事件。用户发朋友圈或参与群聊后会自动显示。
                            </p>
                        ) : (
                            <MemoryTimeline
                                events={sharedEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                                activeTags={activeTimelineTags}
                            />
                        )
                    ) : activeTab === "core" ? (
                        renderMemoryEntries("core", coreEntries, "暂无核心记忆。长期记忆累计到设定条数后会自动提炼，也可以手动新增。")
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        <>
                            {renderPersonaPanel()}
                            {longTermView === "chain" && longTermEntries.length > 0
                                ? renderChainView(longTermEntries)
                                : renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")}
                        </>
                    )}
                    </MemoryDetailBoundary>
                </div>

                {/* Bottom tab bar — floating above bottom */}
                <div className="chat-tab-bar" style={{ position: "absolute", bottom: 40, left: 40, right: 40, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "core" as const, icon: Archive, label: "核心" },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            className={`chat-tab${activeTab === tab.key ? " chat-tab-active" : ""}`}
                            onClick={() => {
                                setActiveTab(tab.key);
                                setEntryMenuId(null);
                            }}
                        >
                            <tab.icon size={18} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                {filterOpen && timelineFilterVisible ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => onFilterOpenChange?.(false)}>
                        <div className="modal-sheet memory-timeline-filter-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">筛选记忆来源</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => onFilterOpenChange?.(false)} aria-label="关闭筛选">
                                    <X size={18} />
                                </button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-timeline-filter-list">
                                    <button
                                        type="button"
                                        className="memory-timeline-filter-option"
                                        data-selected={activeTimelineTags.size === 0 ? "" : undefined}
                                        onClick={() => setActiveTimelineTags(new Set())}
                                    >
                                        <span>全部</span>
                                        <span className="memory-timeline-filter-option-meta">
                                            {filterEvents.length}
                                            {activeTimelineTags.size === 0 ? <Check size={17} /> : null}
                                        </span>
                                    </button>
                                    {timelineTagCounts.map(([tag, count]) => {
                                        const selected = activeTimelineTags.has(tag);
                                        return (
                                            <button
                                                key={tag}
                                                type="button"
                                                className="memory-timeline-filter-option"
                                                data-selected={selected ? "" : undefined}
                                                aria-pressed={selected}
                                                onClick={() => setActiveTimelineTags(prev => {
                                                    const next = new Set(prev);
                                                    if (next.has(tag)) next.delete(tag);
                                                    else next.add(tag);
                                                    return next;
                                                })}
                                            >
                                                <span>{tag}</span>
                                                <span className="memory-timeline-filter-option-meta">
                                                    {count}
                                                    {selected ? <Check size={17} /> : null}
                                                </span>
                                            </button>
                                        );
                                    })}
                                    {timelineTagCounts.length === 0 ? (
                                        <p className="memory-timeline-filter-empty">当前页面暂无可筛选的记忆事件</p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Manual memory editor */}
                {memoryEditor && (() => {
                    const isCore = memoryEditor.type === "core";
                    const isEdit = Boolean(memoryEditor.entry);
                    const title = `${isEdit ? "编辑" : "新增"}${isCore ? "核心记忆" : "长期记忆"}`;
                    const placeholder = isCore
                        ? "记录稳定、长期影响角色判断的事实，例如关系身份、重大约定、长期设定。"
                        : "记录一次重要事件、承诺、偏好、关系变化，后续对话会参考。";
                    const contentLength = memoryEditor.content.trim().length;
                    const overLimit = contentLength > MANUAL_MEMORY_CONTENT_LIMIT;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => savingMemory ? undefined : setMemoryEditor(null)}>
                            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button
                                        className="modal-header-btn modal-header-btn-muted"
                                        onClick={() => setMemoryEditor(null)}
                                        disabled={savingMemory}
                                    >
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">{title}</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body mem-edit-body" data-ui="modal-body">
                                    <textarea
                                        className="ui-textarea mem-edit-textarea"
                                        value={memoryEditor.content}
                                        placeholder={placeholder}
                                        disabled={savingMemory}
                                        onChange={event => setMemoryEditor(prev => prev ? { ...prev, content: event.target.value } : prev)}
                                    />
                                    <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`}>
                                        <span>{isCore ? "CORE" : "LONG TERM"}</span>
                                        <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                    </div>
                                    <button
                                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        {savingMemory ? "保存中..." : "保存记忆"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Confirm delete single entry */}
                {confirmDeleteEntryId && (
                    <ConfirmDialog
                        title="确认删除？"
                        message="删除记忆条目后无法恢复。是否继续？"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认删除"
                        onConfirm={() => {
                            handleDeleteEntry(confirmDeleteEntryId);
                            setConfirmDeleteEntryId(null);
                        }}
                        onCancel={() => setConfirmDeleteEntryId(null)}
                    />
                )}

                {/* Confirm clear all long-term entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="确认清除？"
                        message={activeTab === "core" ? "将清除该角色所有核心记忆，此操作无法恢复。" : "将清除该角色所有长期记忆，此操作无法恢复。"}
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认清除"
                        onConfirm={() => {
                            handleClearEntries(activeTab === "core" ? "core" : "long_term");
                            setConfirmClearAll(false);
                        }}
                        onCancel={() => setConfirmClearAll(false)}
                    />
                )}
            </div>
        );
    }

    // ── Settings View ──
    if (view === "settings") {
        const currentPrompt = editingPrompt
            ?? (isStoredSummarizationPromptDefault(config.summarizationPrompt)
                ? DEFAULT_SUMMARIZATION_PROMPT_V3
                : config.summarizationPrompt!);
        const currentCorePrompt = editingCorePrompt ?? config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT;
        // 只有"编辑器里的内容与已存的不一致"才算改过。原写法拿显示值去比，
        // 存量默认提示词会被误判成"已修改"。
        const isModified = editingPrompt !== null && editingPrompt !== config.summarizationPrompt;
        const isDefault = isStoredSummarizationPromptDefault(config.summarizationPrompt);
        const isCoreModified = currentCorePrompt !== (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT);
        const isCoreDefault = (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT) === DEFAULT_CORE_MEMORY_PROMPT;

        return (
            <div className="page-menu memory-settings-menu">
                {/* Manual summarize */}
                {selectedCharId && (
                    <>
                        <p className="menu-group-desc mx-2">手动操作</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆手动总结</span>
                                    <span className="menu-desc">将新产生的事件整理为长期记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => setSummarizeRangeOpen(true)}
                                        disabled={summarizing}
                                    >
                                        <Zap size={12} className="mr-1" />
                                        {summarizing ? "处理中..." : "总结"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">核心记忆手动总结</span>
                                    <span className="menu-desc">将长期记忆整理为核心记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={handleManualRebuildCore}
                                        disabled={rebuildingCore}
                                    >
                                        <Archive size={12} className="mr-1" />
                                        {rebuildingCore ? "处理中..." : "重建"}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {summarizeRangeOpen ? (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSummarizeRangeOpen(false)}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSummarizeRangeOpen(false)}><X size={18} /></button>
                                        <h3 className="modal-title">选择总结范围</h3>
                                        <span style={{ width: 44 }} />
                                    </div>
                                    <div className="modal-body modal-body-tight" data-ui="modal-body">
                                        <div className="menu-group">
                                            {SUMMARIZE_RANGE_OPTIONS.map(option => (
                                                <button
                                                    key={String(option.value)}
                                                    type="button"
                                                    className="menu-item w-full text-left"
                                                    onClick={() => void handleManualSummarize(option.value)}
                                                >
                                                    <div className="menu-label-group">
                                                        <span className="menu-label">{option.label}</span>
                                                        {option.desc ? <span className="menu-desc">{option.desc}</span> : null}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </>
                )}

                {/* Memory source filter — one entry row, full picker lives in a bottom sheet */}
                <p className="menu-group-desc mx-2">记忆来源</p>
                <div className="menu-group">
                    <button type="button" className="menu-item" onClick={() => setSourcePickerOpen(true)}>
                        <MemorySettingsIcon icon={Filter} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆来源</span>
                            <span className="menu-desc">选择哪些内容参与记忆</span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{disabledSourceCount === 0 ? "全部开启" : `已关闭 ${disabledSourceCount} 项`}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {sourcePickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSourcePickerOpen(false)}>
                        <div className="modal-sheet memory-source-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">记忆来源</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSourcePickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-source-chips" style={{ "--chip-accent": BINDING_ACCENTS.memory } as CSSProperties}>
                                    {MEMORY_SOURCE_OPTIONS.map(source => {
                                        const allowed = config.shortTermAllowedSources ?? {};
                                        const isChecked = allowed[source.key] !== false;
                                        return (
                                            <button
                                                key={source.key}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={isChecked ? undefined : ""}
                                                aria-pressed={isChecked}
                                                onClick={() => {
                                                    const next = {
                                                        ...config,
                                                        shortTermAllowedSources: { ...allowed, [source.key]: !isChecked },
                                                    };
                                                    setConfig(next);
                                                    saveMemoryConfig(next);
                                                }}
                                            >
                                                {source.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Feature toggles */}
                <p className="menu-group-desc mx-2">群聊里别人的事不会写进这个角色的长期记忆。只有他本人说的，或别人直接提到他、回应他的内容，才会留下。</p>
                <p className="menu-group-desc mx-2">自动化</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数自动将新事件整理为长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoSummarizeEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoSummarizeEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数长期记忆，自动整理为核心记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoBuildCoreEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoBuildCoreEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">自动反思</span>
                            <span className="menu-desc">默认关闭。打开后，空闲整理才会跨多条记忆生成"新结论"。反思是推断而不是事实：无论开关如何，它都不会再进入事实召回与核心记忆，"整理记忆"按钮不受此开关限制。</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoReflectionEnabled === true} onChange={(v) => {
                                const next = { ...config, autoReflectionEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">自动性格漂移</span>
                            <span className="menu-desc">默认关闭。打开后，空闲整理才可以把持续的性格变化写进下次聊天。关闭时已有变化不再注入对话。</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoPersonaDriftEnabled === true} onChange={(v) => {
                                const next = { ...config, autoPersonaDriftEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Search} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">向量召回</span>
                            <span className="menu-desc">长期记忆超出预算时，通过 embedding 按相关性检索</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.vectorRecallEnabled ?? true} onChange={(v) => {
                                const next = { ...config, vectorRecallEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                </div>

                {/* 检索日志：可检查、可关闭、有限容量、不含密钥 */}
                <p className="menu-group-desc mx-2">诊断日志</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆检索日志</span>
                            <span className="menu-desc">记录每轮召回了哪些记忆、分数怎么来的、谁没入选，以及各后台任务的开关状态。只存本机、有限容量、不含 API 密钥。</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.memoryRecallLogEnabled !== false} onChange={(v) => {
                                const next = { ...config, memoryRecallLogEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Archive} color={BINDING_ACCENTS.api} />
                        <div className="menu-label-group">
                            <span className="menu-label">导出诊断文件</span>
                            <span className="menu-desc">当前有 {logCount} 条记录。导出前会递归剔除密钥字段，排查"记过却想不起来"时把它发出来。</span>
                        </div>
                        <div className="menu-right">
                            <button className="menu-label ts-12 underline" onClick={handleExportLog}>导出</button>
                            <button className="menu-label menu-label-danger ts-12 underline ml-3" onClick={handleClearLog}>清空</button>
                        </div>
                    </div>
                </div>

                {/* Token budget sliders */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                        onChange={value => saveBudget("shortTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget}
                        onChange={value => saveBudget("longTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆"
                        desc="高优先级里程碑注入量"
                        value={config.coreMemoryTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.coreMemoryTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.coreMemoryTokenBudget}
                        onChange={value => saveBudget("coreMemoryTokenBudget", value)}
                    />
                </div>

                {/* Summarization interval */}
                <p className="menu-group-desc mx-2">自动总结间隔</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.api}
                        label="总结间隔"
                        desc="每 N 条事件自动触发总结"
                        value={config.summarizationEventInterval ?? 50}
                        min={10}
                        max={200}
                        step={10}
                        onChange={saveInterval}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆总结间隔"
                        desc="每 N 条长期记忆自动触发核心记忆总结"
                        value={config.coreSummarizationInterval ?? 5}
                        min={1}
                        max={20}
                        step={1}
                        onChange={saveCoreInterval}
                    />
                </div>

                {/* Summarization Prompt Editor */}
                <p className="menu-group-desc mx-2">长期记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 记录集合
                            </span>
                        </div>
                        {!isDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => setEditingPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isModified && (
                            <button
                                onClick={handleSavePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">核心记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 长期记忆集合、{"{{cardFacts}}"} 人物卡核对摘录
                            </span>
                        </div>
                        {!isCoreDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetCorePrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentCorePrompt}
                            onChange={e => setEditingCorePrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isCoreModified && (
                            <button
                                onClick={handleSaveCorePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Archive size={14} className="mr-1.5" /> 保存核心记忆提词配置
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // ── Character List View ──
    return (
        <div className="mem-picker">
            <div className="mem-picker-card">
                <p className="mem-picker-cover-title">Every moment we shared becomes a timeless memory</p>
                <div className="mem-picker-divider"><span>✦</span></div>
                <div className="mem-picker-cover-wrap">
                    {"MEMORY".split("").map((ch, i) => (
                        <span key={i} className={`mem-picker-cover-letter mem-picker-letter-${i}`}>{ch}</span>
                    ))}
                    <div className="mem-picker-cover-clip">
                        {(() => {
                            const coverSrc = pickedCharId
                                ? (characters.find(c => c.character.id === pickedCharId)?.character.avatar || "")
                                : (resolveUserIdentity()?.avatarUrl || "");
                            return coverSrc ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={coverSrc}
                                    alt=""
                                    className="mem-picker-cover"
                                    draggable={false}
                                />
                            ) : null;
                        })()}
                    </div>
                </div>

                <div className="mem-picker-body">
                    <p className="mem-picker-prompt">
                        你想查看谁的记忆呢？<br />
                        <span className="mem-picker-hint">点击TA的卡片查看吧</span>
                    </p>

                    <div className="mem-picker-chips">
                        {characters.map(({ character }) => (
                            <button
                                key={character.id}
                                className="ui-chip"
                                {...(pickedCharId === character.id ? { "data-selected": "" } : {})}
                                onClick={() => setPickedCharId(pickedCharId === character.id ? null : character.id)}
                            >
                                {character.name}
                            </button>
                        ))}
                    </div>

                    <div className="mem-picker-tear">
                        <div className="mem-picker-tear-line"><span>✦</span></div>
                    </div>

                    <div className="mem-picker-action">
                        <button
                            className="ui-chip ui-chip-lg"
                            {...(pickedCharId ? { "data-selected": "" } : {})}
                            onClick={() => pickedCharId && handleSelectChar(loadCharacters().find(c => c.id === pickedCharId)!)}
                        >
                            查看TA的记忆
                        </button>
                    </div>

                    <div className="mem-picker-footer">
                        <span>OBSERVER · 记忆观察员</span>
                        <span>{characters.length} PROFILES · {characters.reduce((s, c) => s + c.shortTermCount + c.coreCount + c.longTermCount, 0)} RECORDS</span>
                        <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
