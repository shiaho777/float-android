"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronLeft, HeartPulse, Plus, RefreshCw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { Avatar } from "./ui/primitives";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { CALENDAR_CSS_EXAMPLE } from "@/lib/css-examples";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";
import { Input } from "./ui/form";
import type { CalendarOwnerType, CalendarScheduleItem, CalendarWeekPlan } from "@/lib/calendar-types";
import {
  CALENDAR_DAYS_PER_PAGE_OPTIONS,
  CALENDAR_THEME_IDS,
  deleteCalendarScheduleItem,
  loadCalendarConfig,
  loadOwnerCalendarPlans,
  saveCalendarConfig,
  upsertCalendarScheduleItem,
  validateScheduleDraft,
} from "@/lib/calendar-storage";
import { createDefaultScheduleDraft, generateDayCalendarSchedule, generateWeeklyCalendarSchedule } from "@/lib/calendar-engine";
import { generateDailyWorld } from "@/lib/daily-world-engine";
import { loadAllDailyWorldPlans } from "@/lib/daily-world-storage";
import { loadCharacters } from "@/lib/character-storage";
import { getZonedClock, timeZoneCityLabel } from "@/lib/character-time";
import { isNpcCharacter } from "@/lib/character-tier";
import { loadChatSessions } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
  formatIsoDate,
  getWeekStartIso,
  parseIsoDate,
  pickScheduleColorKey,
  sanitizeScheduleEmoji,
} from "@/lib/calendar-utils";
import {
  buildMenstrualDayMap,
  cancelFinishCurrentPeriod,
  cancelCurrentPeriodStart,
  finishCurrentPeriod,
  deleteMenstrualRecord,
  getMenstrualSummary,
  loadMenstrualConfig,
  loadMenstrualRecords,
  saveMenstrualConfig,
  startCurrentPeriod,
  validateMenstrualSettings,
  type MenstrualRecord,
} from "@/lib/menstrual-storage";
import { CalendarMonthPage } from "./calendar/month-page";
import { CalendarDetailPage } from "./calendar/detail-page";
import { CalendarEventEditModal, type CalendarEventDraft } from "./calendar/event-edit-modal";
import "@/styles/calendar.css";

type OwnerOption = {
  key: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  name: string;
  avatar?: string | null;
  isNpc?: boolean;
};

const CALENDAR_THEMES: Array<{ id: (typeof CALENDAR_THEME_IDS)[number]; name: string }> = [
  { id: "light", name: "默认" },
  { id: "dark", name: "深色" },
  { id: "cream", name: "奶油" },
  { id: "mint", name: "薄荷" },
  { id: "mist", name: "雾紫" },
  { id: "sakura", name: "樱粉" },
];

function buildOwnerOptions(): OwnerOption[] {
  const options: OwnerOption[] = [];
  const identity = resolveUserIdentity(undefined, "calendar") ?? resolveUserIdentity() ?? null;
  options.push({
    key: "user:me",
    ownerType: "user",
    ownerId: "self",
    name: identity?.name?.trim() || "我",
    avatar: identity?.avatarUrl || null,
  });
  for (const char of loadCharacters()) {
    options.push({
      key: `character:${char.id}`,
      ownerType: "character",
      ownerId: char.id,
      name: char.name,
      avatar: char.avatar,
      isNpc: isNpcCharacter(char),
    });
  }
  return options;
}

type PeriodCareCharacterOption = {
  characterId: string;
  name: string;
  avatar?: string | null;
};

function buildPeriodCareCharacterOptions(): PeriodCareCharacterOption[] {
  const characters = loadCharacters();
  const characterById = new Map(characters.map(char => [char.id, char]));
  const latestSessionByCharacter = new Map<string, ReturnType<typeof loadChatSessions>[number]>();
  for (const session of loadChatSessions()) {
    if (session.isGroup) continue;
    const character = characterById.get(session.contactId);
    if (!character) continue;
    const existing = latestSessionByCharacter.get(session.contactId);
    if (!existing || session.updatedAt > existing.updatedAt) {
      latestSessionByCharacter.set(session.contactId, session);
    }
  }
  return Array.from(latestSessionByCharacter.values())
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(session => {
      const character = characterById.get(session.contactId)!;
      return {
        characterId: character.id,
        name: session.alias || character.name,
        avatar: character.avatar,
      };
    });
}

function formatSimpleDate(dateText: string | null): string {
  if (!dateText) return "待记录";
  const date = parseIsoDate(dateText);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function PhoneCalendarApp({
  onClose,
  onNotice,
}: {
  onClose: () => void;
  onNotice?: (text: string) => void;
}) {
  const [clockNow, setClockNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [owners, setOwners] = useState<OwnerOption[]>(() => buildOwnerOptions());
  const [selectedKey, setSelectedKey] = useState<string>(() => owners[0]?.key ?? "user:me");
  const [view, setView] = useState<"month" | "detail">("month");
  const [selectedDate, setSelectedDate] = useState<string>(() => formatIsoDate(new Date()));
  const [detailKey, setDetailKey] = useState(0);
  const [ownerPlans, setOwnerPlans] = useState<CalendarWeekPlan[]>([]);
  const [config, setConfig] = useState(() => loadCalendarConfig());
  const [menstrualConfig, setMenstrualConfig] = useState(() => loadMenstrualConfig());
  const [menstrualRecords, setMenstrualRecords] = useState<MenstrualRecord[]>(() => loadMenstrualRecords());
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [showDaysPanel, setShowDaysPanel] = useState(false);
  const [showMenstrualSettings, setShowMenstrualSettings] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false);
  const [weekGenFeedback, setWeekGenFeedback] = useState("");
  const [dayGenOpen, setDayGenOpen] = useState(false);
  const [dayGenFeedback, setDayGenFeedback] = useState("");
  const [showAutoConfirm, setShowAutoConfirm] = useState(false);
  const [fabMenuOpen, setFabMenuOpen] = useState(false);
  const [worldGenOpen, setWorldGenOpen] = useState(false);
  const [worldGenSelected, setWorldGenSelected] = useState<Set<string>>(new Set());
  const [worldGenStage, setWorldGenStage] = useState<string | null>(null);
  const autoAttemptedRef = useRef<Set<string>>(new Set());
  const [editingItem, setEditingItem] = useState<(CalendarEventDraft & { originalDate?: string }) | null>(null);
  const autoGenerateEnabled = config.autoGenerateEnabled;

  const [menstrualDraft, setMenstrualDraft] = useState<{
    cycleLength: string;
    periodLength: string;
    periodCareEnabled: boolean;
    periodCareCharacterIds: string[];
    periodCareLeadDays: "1" | "2" | "3";
  }>(() => {
    const initial = loadMenstrualConfig();
    return {
      cycleLength: String(initial.cycleLength),
      periodLength: String(initial.periodLength),
      periodCareEnabled: initial.periodCareEnabled,
      periodCareCharacterIds: initial.periodCareCharacterIds,
      periodCareLeadDays: String(initial.periodCareLeadDays) as "1" | "2" | "3",
    };
  });

  const [calendarCustomCss, setCalendarCustomCss] = useState(() =>
    typeof window !== "undefined" ? kvGet("calendar-custom-css") || "" : ""
  );
  const [appliedCalendarCss, setAppliedCalendarCss] = useState(() =>
    typeof window !== "undefined" ? kvGet("calendar-custom-css") || "" : ""
  );
  const handleApplyCalendarCss = () => {
    const trimmed = calendarCustomCss.trim();
    if (trimmed) kvSet("calendar-custom-css", trimmed);
    else kvRemove("calendar-custom-css");
    setAppliedCalendarCss(trimmed);
    window.dispatchEvent(new CustomEvent("calendar-css-updated", { detail: trimmed }));
  };
  // 小卷等外部来源实时更新日历自定义 CSS
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const css = (e as CustomEvent).detail || "";
      setAppliedCalendarCss(css);
      setCalendarCustomCss(css);
    };
    window.addEventListener("calendar-css-updated", onCSSUpdate);
    return () => window.removeEventListener("calendar-css-updated", onCSSUpdate);
  }, []);

  const selectedOwner = useMemo(
    () => owners.find(owner => owner.key === selectedKey) ?? owners[0] ?? null,
    [owners, selectedKey],
  );
  const ownerTimeZone = selectedOwner?.ownerType === "character"
    ? loadCharacters().find(character => character.id === selectedOwner.ownerId)?.timeZone
    : undefined;
  const ownerClock = useMemo(
    () => getZonedClock(ownerTimeZone, clockNow),
    [ownerTimeZone, clockNow],
  );
  const todayIso = ownerClock.dateIso;
  const zoneCity = timeZoneCityLabel(ownerTimeZone);
  const weekStart = useMemo(() => getWeekStartIso(parseIsoDate(selectedDate)), [selectedDate]);
  const [worldPlans, setWorldPlans] = useState(() => loadAllDailyWorldPlans());
  const worldByDate = useMemo(() => new Map(worldPlans.map(p => [p.date, p])), [worldPlans]);

  const itemsByDate = useMemo(() => {
    const map = new Map<string, CalendarScheduleItem[]>();
    for (const plan of ownerPlans) {
      for (const item of plan.items) {
        const list = map.get(item.date) || [];
        list.push(item);
        map.set(item.date, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    return map;
  }, [ownerPlans]);

  // 经期标注：覆盖月历页 ±1 年范围
  const cycleMap = useMemo(() => {
    if (selectedOwner?.ownerType !== "user") return null;
    const today = parseIsoDate(todayIso);
    const start = formatIsoDate(new Date(today.getFullYear() - 1, today.getMonth(), 1));
    const end = formatIsoDate(new Date(today.getFullYear() + 1, today.getMonth() + 1, 0));
    return buildMenstrualDayMap(start, end, menstrualRecords, menstrualConfig);
  }, [selectedOwner, todayIso, menstrualRecords, menstrualConfig]);

  const menstrualSummary = useMemo(
    () => getMenstrualSummary(menstrualRecords, menstrualConfig, selectedDate),
    [menstrualRecords, menstrualConfig, selectedDate],
  );
  const periodCareCharacterOptions = useMemo(
    () => (showMenstrualSettings ? buildPeriodCareCharacterOptions() : []),
    [showMenstrualSettings],
  );

  useEffect(() => {
    setOwners(buildOwnerOptions());
  }, []);

  const refreshPlans = () => {
    if (!selectedOwner) return;
    setOwnerPlans(loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId));
  };

  useEffect(() => {
    if (!selectedOwner) return;
    setOwnerPlans(loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId));
  }, [selectedOwner]);

  // 聊天/工具调用改动日程后刷新
  useEffect(() => {
    const handler = () => {
      if (!selectedOwner) return;
      setOwnerPlans(loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId));
      setWorldPlans(loadAllDailyWorldPlans());
    };
    window.addEventListener("calendar-updated", handler);
    return () => window.removeEventListener("calendar-updated", handler);
  }, [selectedOwner]);

  // 每周自动生成（仅角色）
  useEffect(() => {
    if (!selectedOwner || !autoGenerateEnabled || selectedOwner.ownerType !== "character" || isGenerating) return;
    const autoKey = `${selectedOwner.ownerType}:${selectedOwner.ownerId}:${weekStart}`;
    if (autoAttemptedRef.current.has(autoKey)) return;
    const existing = loadOwnerCalendarPlans(selectedOwner.ownerType, selectedOwner.ownerId)
      .find(plan => plan.weekStart === weekStart);
    if (existing && existing.items.length > 0) return;
    void (async () => {
      autoAttemptedRef.current.add(autoKey);
      setIsGenerating(true);
      const result = await generateWeeklyCalendarSchedule(selectedOwner.ownerType, selectedOwner.ownerId, weekStart);
      setIsGenerating(false);
      if (!result.success) {
        onNotice?.(result.error || "自动生成失败");
        return;
      }
      refreshPlans();
      onNotice?.("已自动生成本周角色日程");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerateEnabled, isGenerating, selectedOwner, weekStart]);

  // ── 事件编辑 ──
  const openNewDraft = (date: string) => {
    const base = createDefaultScheduleDraft(date);
    setEditingItem({
      date: base.date,
      startTime: base.startTime,
      endTime: base.endTime,
      location: base.location,
      title: base.title,
      emoji: base.emoji,
    });
  };

  const openEditItem = (item: CalendarScheduleItem) => {
    setEditingItem({
      id: item.id,
      date: item.date,
      endDate: item.date,
      originalDate: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      location: item.location,
      title: item.title,
      emoji: item.emoji || "",
      colorKey: item.colorKey,
      mood: item.mood,
      note: item.note,
      photoRefs: item.photoRefs,
      todos: item.todos,
    });
  };

  const handleSaveDraft = () => {
    if (!selectedOwner || !editingItem) return;
    const error = validateScheduleDraft(editingItem);
    if (error) {
      onNotice?.(error);
      return;
    }
    const startDate = editingItem.date;
    const endDate = editingItem.endDate || editingItem.date;
    if (endDate < startDate) {
      onNotice?.("结束日期不能早于开始日期");
      return;
    }
    const dayCount = Math.round((parseIsoDate(endDate).getTime() - parseIsoDate(startDate).getTime()) / 86400000) + 1;
    if (dayCount > 31) {
      onNotice?.("一次最多创建 31 天的日程");
      return;
    }
    const firstWeekStart = getWeekStartIso(parseIsoDate(startDate));
    // 跨周移动：先从原来的周删除
    if (editingItem.id && editingItem.originalDate) {
      const originalWeekStart = getWeekStartIso(parseIsoDate(editingItem.originalDate));
      if (originalWeekStart !== firstWeekStart) {
        deleteCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, originalWeekStart, editingItem.id);
      }
    }
    // 多天：第一天沿用原 id（编辑场景），其余每天各生成一条独立日程
    for (let offset = 0; offset < dayCount; offset++) {
      const day = parseIsoDate(startDate);
      day.setDate(day.getDate() + offset);
      const dayIso = formatIsoDate(day);
      upsertCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, getWeekStartIso(parseIsoDate(dayIso)), {
        id: offset === 0 ? editingItem.id : undefined,
        date: dayIso,
        startTime: editingItem.startTime,
        endTime: editingItem.endTime,
        location: editingItem.location,
        title: editingItem.title,
        emoji: sanitizeScheduleEmoji(editingItem.emoji),
        source: "manual",
        colorKey: editingItem.colorKey ?? pickScheduleColorKey(editingItem.startTime),
        mood: editingItem.mood?.trim() || undefined,
        note: editingItem.note?.trim() || undefined,
        photoRefs: editingItem.photoRefs?.length ? editingItem.photoRefs : undefined,
        todos: editingItem.todos?.length ? editingItem.todos : undefined,
      });
    }
    setEditingItem(null);
    refreshPlans();
    onNotice?.(dayCount > 1 ? `已创建 ${dayCount} 天的日程` : "日程已保存");
  };

  const handleDeleteItem = () => {
    if (!selectedOwner || !editingItem?.id) return;
    const targetWeekStart = getWeekStartIso(parseIsoDate(editingItem.originalDate || editingItem.date));
    deleteCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, targetWeekStart, editingItem.id);
    setEditingItem(null);
    refreshPlans();
    onNotice?.("日程已删除");
  };

  const handleGenerate = async () => {
    if (!selectedOwner || isGenerating || selectedOwner.ownerType !== "character") return;
    const feedback = weekGenFeedback.trim();
    setShowGenerateConfirm(false);
    setIsGenerating(true);
    const result = await generateWeeklyCalendarSchedule(
      selectedOwner.ownerType, selectedOwner.ownerId, weekStart,
      feedback ? { feedback } : undefined,
    );
    setIsGenerating(false);
    if (!result.success) {
      onNotice?.(result.error || "生成失败");
      return;
    }
    refreshPlans();
    onNotice?.(feedback ? "已按反馈调整本周日程" : "本周日程已生成");
  };

  // 单日重roll：只重排选中的那一天，可写反馈（"下午别排训练"之类）
  const handleGenerateDay = async () => {
    if (!selectedOwner || isGenerating || selectedOwner.ownerType !== "character") return;
    const targetDate = view === "detail" ? selectedDate : todayIso;
    const feedback = dayGenFeedback.trim();
    setDayGenOpen(false);
    setIsGenerating(true);
    const result = await generateDayCalendarSchedule(
      selectedOwner.ownerType, selectedOwner.ownerId, weekStart, targetDate,
      feedback || undefined,
    );
    setIsGenerating(false);
    if (!result.success) {
      onNotice?.(result.error || "重排失败");
      return;
    }
    refreshPlans();
    onNotice?.(`${targetDate.slice(5).replace("-", "月")}日 已重新生成`);
  };

  // ── 今日世界：多角色联动日程 ──
  const handleGenerateWorld = async () => {
    const ids = Array.from(worldGenSelected);
    if (!ids.length || worldGenStage !== null) return;
    const targetDate = view === "detail" ? selectedDate : todayIso;
    setWorldGenStage("推演今日世界…");
    try {
      const result = await generateDailyWorld(targetDate, ids, {
        onProgress: (_stage, detail) => setWorldGenStage(detail ?? "生成中…"),
      });
      if (!result.success) {
        onNotice?.(result.error || "生成今日世界失败");
        return;
      }
      const total = Object.values(result.perCharacterItems ?? {}).reduce((a, b) => a + b, 0);
      const interactions = result.plan?.interactions.length ?? 0;
      onNotice?.(`今日世界已生成：${total} 条日程、${interactions} 场互动`);
      refreshPlans();
      setWorldGenOpen(false);
    } finally {
      setWorldGenStage(null);
    }
  };

  const handleToggleTodo = (item: CalendarScheduleItem, todoIndex: number) => {
    if (!selectedOwner || !item.todos?.[todoIndex]) return;
    upsertCalendarScheduleItem(selectedOwner.ownerType, selectedOwner.ownerId, getWeekStartIso(parseIsoDate(item.date)), {
      ...item,
      todos: item.todos.map((t, i) => i === todoIndex ? { ...t, done: !t.done } : t),
    });
    refreshPlans();
  };

  // ── 经期 ──
  const refreshMenstrual = () => {
    setMenstrualConfig(loadMenstrualConfig());
    setMenstrualRecords(loadMenstrualRecords());
  };

  const openMenstrualSettings = () => {
    setMenstrualDraft({
      cycleLength: String(menstrualConfig.cycleLength),
      periodLength: String(menstrualConfig.periodLength),
      periodCareEnabled: menstrualConfig.periodCareEnabled,
      periodCareCharacterIds: menstrualConfig.periodCareCharacterIds,
      periodCareLeadDays: String(menstrualConfig.periodCareLeadDays) as "1" | "2" | "3",
    });
    setShowMenstrualSettings(true);
  };

  const togglePeriodCareCharacter = (characterId: string) => {
    setMenstrualDraft(prev => {
      const selected = new Set(prev.periodCareCharacterIds);
      if (selected.has(characterId)) selected.delete(characterId);
      else selected.add(characterId);
      return { ...prev, periodCareCharacterIds: Array.from(selected) };
    });
  };

  const handleSaveMenstrualSettings = () => {
    const cycleLength = Number(menstrualDraft.cycleLength);
    const periodLength = Number(menstrualDraft.periodLength);
    const error = validateMenstrualSettings({ cycleLength, periodLength });
    if (error) {
      onNotice?.(error);
      return;
    }
    const availableCharacterIds = new Set(periodCareCharacterOptions.map(option => option.characterId));
    const periodCareCharacterIds = menstrualDraft.periodCareCharacterIds.filter(id => availableCharacterIds.has(id));
    if (menstrualDraft.periodCareEnabled && periodCareCharacterIds.length === 0) {
      onNotice?.("请选择至少一个已有聊天角色");
      return;
    }
    const savedConfig = saveMenstrualConfig({
      ...menstrualConfig,
      cycleLength,
      periodLength,
      periodCareEnabled: menstrualDraft.periodCareEnabled,
      periodCareCharacterIds,
      periodCareLeadDays: Number(menstrualDraft.periodCareLeadDays) as 1 | 2 | 3,
    });
    setMenstrualConfig(savedConfig);
    window.dispatchEvent(new CustomEvent("menstrual-period-care-updated"));
    setShowMenstrualSettings(false);
    onNotice?.("周期设置已保存");
  };

  const canCancelSelectedStart = menstrualSummary.currentPeriodStartDate === selectedDate && !menstrualSummary.todayFinished;
  const canStartSelected = !menstrualSummary.todayStarted && !menstrualSummary.isPeriodActive;
  const canCancelSelectedFinish = menstrualSummary.todayFinished;
  const canFinishSelected =
    menstrualSummary.isPeriodActive &&
    !!menstrualSummary.currentPeriodStartDate &&
    selectedDate >= menstrualSummary.currentPeriodStartDate &&
    !menstrualSummary.todayFinished;

  const cycleStateForSelected = cycleMap?.get(selectedDate) ?? null;
  const cycleSummaryLine = cycleStateForSelected
    ? `周期 · ${cycleStateForSelected.label || cycleStateForSelected.shortLabel}`
    : menstrualSummary.isPeriodActive && menstrualSummary.currentPeriodStartDate
      ? `本次经期从 ${formatSimpleDate(menstrualSummary.currentPeriodStartDate)} 开始`
      : menstrualSummary.latest
        ? null
        : "点「经期来了」开始记录与预测";

  // 详情页经期打卡行（仅用户视图）
  const cyclePanel = selectedOwner?.ownerType === "user" ? (
    <div className="calendar-cycle-line">
      <i className="calendar-cycle-dot" data-type={cycleStateForSelected?.type ?? "period"} aria-hidden="true" />
      <span className="calendar-cycle-line-text">{cycleSummaryLine ?? "周期记录"}</span>
      {canCancelSelectedStart ? (
        <button type="button" className="calendar-mini-btn" data-variant="primary" onClick={() => {
          setMenstrualConfig(cancelCurrentPeriodStart(selectedDate));
          setMenstrualRecords(loadMenstrualRecords());
          onNotice?.("已取消这一天的经期来了");
        }}>撤销来了</button>
      ) : (
        <button type="button" className="calendar-mini-btn" data-variant="primary" disabled={!canStartSelected} onClick={() => {
          setMenstrualConfig(startCurrentPeriod(selectedDate));
          setMenstrualRecords(loadMenstrualRecords());
          onNotice?.("已记录经期来了");
        }}>经期来了</button>
      )}
      {canCancelSelectedFinish ? (
        <button type="button" className="calendar-mini-btn" data-variant="primary" onClick={() => {
          const result = cancelFinishCurrentPeriod(selectedDate);
          if (!result.restored) {
            onNotice?.("这一天还没有记录经期走了");
            return;
          }
          setMenstrualConfig(result.config);
          setMenstrualRecords(result.records);
          onNotice?.("已取消这一天的经期走了");
        }}>撤销走了</button>
      ) : (
        <button type="button" className="calendar-mini-btn" data-variant="ghost" disabled={!canFinishSelected} onClick={() => {
          const result = finishCurrentPeriod(selectedDate);
          if (!result.saved) {
            onNotice?.("请先记录经期来了");
            return;
          }
          setMenstrualConfig(result.config);
          setMenstrualRecords(result.records);
          onNotice?.("已记录经期走了");
        }}>经期走了</button>
      )}
    </div>
  ) : null;

  const ownerStrip = (
    <section className="calendar-owner-strip hide-scrollbar">
      {owners.map(owner => (
        <button
          key={owner.key}
          type="button"
          className="calendar-owner-chip"
          data-active={owner.key === selectedKey ? "true" : undefined}
          onClick={() => {
            setFabMenuOpen(false);
            setSelectedKey(owner.key);
            const timeZone = owner.ownerType === "character"
              ? loadCharacters().find(character => character.id === owner.ownerId)?.timeZone
              : null;
            setSelectedDate(getZonedClock(timeZone).dateIso);
          }}
        >
          <Avatar src={owner.avatar || undefined} name={owner.name} size="md" />
          <span>{owner.name}</span>
        </button>
      ))}
    </section>
  );

  const openDetail = (date: string) => {
    setSelectedDate(date);
    setDetailKey(k => k + 1);
    setView("detail");
  };

  return (
    <div className="calendar-app-shell" data-calendar-theme={config.theme}>
      {appliedCalendarCss && <SessionCustomCSS css={appliedCalendarCss} scope=".calendar-app-shell" />}
      <div className="calendar-app">
        {view === "month" ? (
          <CalendarMonthPage
            todayIso={todayIso}
            zoneCity={zoneCity}
            localTimeLabel={zoneCity ? ownerClock.label : ""}
            itemsByDate={itemsByDate}
            cycleMap={cycleMap}
            ownerStrip={ownerStrip}
            onPickDay={openDetail}
            onClose={onClose}
            onOpenTheme={() => setShowThemePanel(true)}
          />
        ) : (
          <CalendarDetailPage
            key={detailKey}
            initialDate={selectedDate}
            todayIso={todayIso}
            timeZone={ownerTimeZone}
            zoneCity={zoneCity}
            itemsByDate={itemsByDate}
            cycleMap={cycleMap}
            cyclePanel={cyclePanel}
            daysPerPage={config.daysPerPage}
            onOpenDaysPicker={() => setShowDaysPanel(true)}
            onOpenCycleSettings={selectedOwner?.ownerType === "user" ? openMenstrualSettings : null}
            onBack={() => setView("month")}
            onSelectedChange={setSelectedDate}
            onEditItem={openEditItem}
            resolveCharName={(id) => owners.find(o => o.ownerId === id)?.name ?? id}
            worldByDate={worldByDate}
            onToggleTodo={handleToggleTodo}
          />
        )}

        {fabMenuOpen ? <div className="calendar-fab-backdrop" onClick={() => setFabMenuOpen(false)} /> : null}
        <div className="calendar-fab-stack">
          {fabMenuOpen ? (
            <div className="calendar-fab-menu" role="menu">
              <button
                type="button"
                className="calendar-fab-menu-item"
                onClick={() => {
                  setFabMenuOpen(false);
                  openNewDraft(view === "detail" ? selectedDate : todayIso);
                }}
              >
                <Plus size={15} />
                新增日程
              </button>
              <button
                type="button"
                className="calendar-fab-menu-item"
                disabled={worldGenStage !== null}
                onClick={() => {
                  setFabMenuOpen(false);
                  setWorldGenSelected(new Set(owners.filter(o => o.ownerType === "character").map(o => o.ownerId)));
                  setWorldGenOpen(true);
                }}
              >
                <Sparkles size={15} />
                {worldGenStage ? "生成中…" : "生成今日世界"}
              </button>
              {selectedOwner?.ownerType === "character" && (
                <>
                  <button
                    type="button"
                    className="calendar-fab-menu-item"
                    disabled={isGenerating}
                    onClick={() => {
                      setFabMenuOpen(false);
                      setDayGenOpen(true);
                    }}
                  >
                    <RefreshCw size={15} />
                    重排这一天
                  </button>
                  <button
                    type="button"
                    className="calendar-fab-menu-item"
                    disabled={isGenerating}
                    onClick={() => {
                      setFabMenuOpen(false);
                      setShowGenerateConfirm(true);
                    }}
                  >
                    <Wand2 size={15} />
                    {isGenerating ? "生成中…" : "AI 生成本周"}
                  </button>
                  <button
                    type="button"
                    className="calendar-fab-menu-item"
                    data-on={autoGenerateEnabled ? "true" : undefined}
                    onClick={() => {
                      setFabMenuOpen(false);
                      setShowAutoConfirm(true);
                    }}
                  >
                    <Bot size={15} />
                    每周自动生成
                    <i className="calendar-fab-menu-state">{autoGenerateEnabled ? "已开" : "已关"}</i>
                  </button>
                </>
              )}
            </div>
          ) : null}
          <button
            type="button"
            className="calendar-fab calendar-fab-primary"
            data-loading={isGenerating || worldGenStage !== null ? "true" : undefined}
            onClick={() => setFabMenuOpen(prev => !prev)}
            aria-label="日程操作菜单"
            aria-expanded={fabMenuOpen}
          >
            <Plus size={20} style={{ transform: fabMenuOpen ? "rotate(45deg)" : undefined, transition: "transform 0.2s" }} />
          </button>
        </div>
      </div>

      {showThemePanel && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowThemePanel(false)}>
          <div className="calendar-edit-modal calendar-theme-modal" onClick={e => e.stopPropagation()}>
            <div className="calendar-theme-modal-head">
              <strong>主题</strong>
              <button type="button" onClick={() => setShowThemePanel(false)} className="calendar-icon-btn" aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="calendar-theme-grid">
              {CALENDAR_THEMES.map(theme => (
                <button
                  key={theme.id}
                  type="button"
                  className="calendar-theme-option"
                  data-active={config.theme === theme.id ? "true" : undefined}
                  onClick={() => {
                    const nextConfig = { ...config, theme: theme.id };
                    setConfig(nextConfig);
                    saveCalendarConfig(nextConfig);
                  }}
                >
                  <span className="calendar-theme-swatch" data-theme-id={theme.id} aria-hidden="true" />
                  <span>{theme.name}</span>
                </button>
              ))}
            </div>

            <div className="calendar-theme-css-label">自定义 CSS</div>
            <textarea
              className="calendar-css-textarea"
              value={calendarCustomCss}
              onChange={e => setCalendarCustomCss(e.target.value)}
              placeholder="/* 输入 CSS 覆盖日历样式... */"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <div className="calendar-theme-css-actions">
              <CSSSchemeBar
                target="calendar"
                currentCSS={calendarCustomCss}
                onLoad={setCalendarCustomCss}
                btnStyle={{
                  width: 30,
                  height: 30,
                  border: "none",
                  background: "var(--c-calendar-surface)",
                  color: "var(--c-calendar-ink)",
                }}
                modalVars={{
                  panel: "var(--c-calendar-bg)",
                  border: "var(--c-calendar-surface-2)",
                  text: "var(--c-calendar-ink)",
                  textDim: "var(--c-calendar-sub)",
                  input: "var(--c-calendar-surface)",
                  inputBorder: "var(--c-calendar-surface-2)",
                  accent: "var(--c-calendar-today)",
                }}
              />
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setCalendarCustomCss(CALENDAR_CSS_EXAMPLE)}>示例</button>
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setCalendarCustomCss("")}>清空</button>
              <button type="button" className="calendar-block-btn" data-variant="primary" onClick={handleApplyCalendarCss}>应用</button>
            </div>
          </div>
        </div>
      )}

      {showDaysPanel && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowDaysPanel(false)}>
          <div className="calendar-edit-modal calendar-days-modal" onClick={e => e.stopPropagation()}>
            <div className="calendar-theme-modal-head">
              <strong>每页天数</strong>
              <button type="button" onClick={() => setShowDaysPanel(false)} className="calendar-icon-btn" aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="calendar-days-options">
              {CALENDAR_DAYS_PER_PAGE_OPTIONS.map(n => (
                <button
                  key={n}
                  type="button"
                  className="calendar-days-option"
                  data-active={config.daysPerPage === n ? "true" : undefined}
                  onClick={() => {
                    const nextConfig = { ...config, daysPerPage: n };
                    setConfig(nextConfig);
                    saveCalendarConfig(nextConfig);
                    setShowDaysPanel(false);
                  }}
                >
                  <b>{n}</b>
                  <span>{n === 1 ? "单日" : `${n} 天`}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {editingItem && (
        <CalendarEventEditModal
          draft={editingItem}
          onChange={next => setEditingItem(prev => (prev ? { ...prev, ...next } : next))}
          onSave={handleSaveDraft}
          onDelete={handleDeleteItem}
          onClose={() => setEditingItem(null)}
        />
      )}

      {showMenstrualSettings && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowMenstrualSettings(false)}>
          <div className="calendar-edit-modal calendar-menstrual-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header" data-ui="modal-header">
              <button onClick={() => setShowMenstrualSettings(false)} className="modal-header-btn modal-header-btn-muted" aria-label="返回">
                <ChevronLeft size={18} />
              </button>
              <span className="modal-header-title">周期设置</span>
              <button onClick={handleSaveMenstrualSettings} className="modal-header-btn modal-header-btn-action" aria-label="保存">
                <Check size={18} />
              </button>
            </div>

            <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10" data-ui="modal-body">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">周期长度</label>
                  <Input
                    type="number"
                    min={21}
                    max={60}
                    value={menstrualDraft.cycleLength}
                    onChange={e => setMenstrualDraft(prev => ({ ...prev, cycleLength: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="menu-desc ml-1">经期天数</label>
                  <Input
                    type="number"
                    min={2}
                    max={10}
                    value={menstrualDraft.periodLength}
                    onChange={e => setMenstrualDraft(prev => ({ ...prev, periodLength: e.target.value }))}
                  />
                </div>
              </div>

              <div className="calendar-menstrual-care-panel">
                <button
                  type="button"
                  className="calendar-menstrual-care-toggle"
                  data-active={menstrualDraft.periodCareEnabled ? "true" : undefined}
                  onClick={() => setMenstrualDraft(prev => ({ ...prev, periodCareEnabled: !prev.periodCareEnabled }))}
                >
                  <span className="calendar-menstrual-care-toggle-icon">
                    <HeartPulse size={16} />
                  </span>
                  <span className="calendar-menstrual-care-toggle-copy">
                    <strong>让TA关心我的经期</strong>
                    <span>只显示已有聊天会话的角色</span>
                  </span>
                  <span className="calendar-menstrual-pill-switch" aria-hidden="true">
                    <span className="calendar-menstrual-pill-switch-thumb" />
                  </span>
                </button>

                {menstrualDraft.periodCareEnabled ? (
                  <div className="calendar-menstrual-care-body">
                    <div className="calendar-menstrual-care-section">
                      <label className="menu-desc ml-1">提前多久关心</label>
                      <div className="calendar-period-care-lead-row">
                        {(["1", "2", "3"] as const).map(value => (
                          <button
                            key={value}
                            type="button"
                            className="calendar-period-care-lead"
                            data-active={menstrualDraft.periodCareLeadDays === value ? "true" : undefined}
                            onClick={() => setMenstrualDraft(prev => ({ ...prev, periodCareLeadDays: value }))}
                          >
                            {value}天
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="calendar-menstrual-care-section">
                      <label className="menu-desc ml-1">选择角色</label>
                      {periodCareCharacterOptions.length > 0 ? (
                        <div className="calendar-period-care-avatars">
                          {periodCareCharacterOptions.map(option => {
                            const selected = menstrualDraft.periodCareCharacterIds.includes(option.characterId);
                            return (
                              <button
                                key={option.characterId}
                                type="button"
                                className="calendar-period-care-avatar"
                                data-active={selected ? "true" : undefined}
                                onClick={() => togglePeriodCareCharacter(option.characterId)}
                              >
                                <Avatar src={option.avatar || undefined} name={option.name} size="md" />
                                <span>{option.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="calendar-menstrual-empty">已有聊天会话的角色会显示在这里。</div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

              {menstrualRecords.length > 0 ? (
                <div className="calendar-menstrual-modal-history">
                  <label className="menu-desc ml-1">最近完成的经期</label>
                  <div className="calendar-menstrual-modal-list">
                    {menstrualRecords.slice(0, 4).map(record => (
                      <div key={record.id} className="calendar-menstrual-modal-item">
                        <div>
                          <strong>{formatSimpleDate(record.startDate)} - {formatSimpleDate(record.endDate)}</strong>
                          <span>{record.startDate} 至 {record.endDate}</span>
                        </div>
                        <button
                          type="button"
                          className="calendar-menstrual-modal-delete"
                          onClick={() => {
                            setMenstrualRecords(deleteMenstrualRecord(record.id));
                            refreshMenstrual();
                            onNotice?.("经期记录已删除");
                          }}
                          aria-label="删除记录"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="calendar-menstrual-empty">还没有完成的经期记录。先在日程页点“经期来了”，结束时再点“经期走了”。</div>
              )}
            </div>
          </div>
        </div>
      )}

      {showGenerateConfirm && selectedOwner && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowGenerateConfirm(false)}>
          <div className="calendar-edit-modal calendar-confirm-dialog" onClick={e => e.stopPropagation()}>
            <Wand2 size={26} className="calendar-confirm-icon" />
            <div className="calendar-confirm-title">确认生成日程？</div>
            <div className="calendar-confirm-desc">
              将为 <strong>{selectedOwner.name}</strong> 生成一周日程并覆盖当前已有 AI 安排（手动添加的保留）。
              写了反馈的话不会整周推翻，只改受影响的日期。
            </div>
            <textarea
              className="calendar-css-textarea"
              style={{ minHeight: 64, marginTop: 10 }}
              value={weekGenFeedback}
              onChange={e => setWeekGenFeedback(e.target.value)}
              placeholder={"想怎么改？（可不填）\n例：周三下午别排训练，改成去逛街；周末排满一点"}
              spellCheck={false}
            />
            <div className="calendar-confirm-footer">
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setShowGenerateConfirm(false)}>取消</button>
              <button
                type="button"
                className="calendar-block-btn"
                data-variant="primary"
                data-loading={isGenerating ? "true" : undefined}
                onClick={handleGenerate}
                disabled={isGenerating}
                aria-busy={isGenerating}
              >
                {isGenerating ? "生成中…" : "确认"}
              </button>
            </div>
          </div>
        </div>
      )}

      {dayGenOpen && selectedOwner && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => !isGenerating && setDayGenOpen(false)}>
          <div className="calendar-edit-modal calendar-confirm-dialog" onClick={e => e.stopPropagation()}>
            <RefreshCw size={26} className="calendar-confirm-icon" />
            <div className="calendar-confirm-title">重排这一天</div>
            <div className="calendar-confirm-desc">
              将为 <strong>{selectedOwner.name}</strong> 重新生成{" "}
              <strong>{view === "detail" ? selectedDate : todayIso}</strong> 的日程，
              只影响当天的 AI 安排（手动添加的和其他天不动）
            </div>
            <textarea
              className="calendar-css-textarea"
              style={{ minHeight: 64, marginTop: 10 }}
              value={dayGenFeedback}
              onChange={e => setDayGenFeedback(e.target.value)}
              placeholder={"想怎么改？（可不填，不填就是换一版）\n例：下午的训练太累，改成去便利店摸鱼"}
              spellCheck={false}
            />
            <div className="calendar-confirm-footer">
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setDayGenOpen(false)} disabled={isGenerating}>取消</button>
              <button
                type="button"
                className="calendar-block-btn"
                data-variant="primary"
                data-loading={isGenerating ? "true" : undefined}
                onClick={handleGenerateDay}
                disabled={isGenerating}
                aria-busy={isGenerating}
              >
                {isGenerating ? "生成中…" : "重新生成"}
              </button>
            </div>
          </div>
        </div>
      )}

      {worldGenOpen && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => worldGenStage === null && setWorldGenOpen(false)}>
          <div className="calendar-edit-modal calendar-confirm-dialog" onClick={e => e.stopPropagation()}>
            <Sparkles size={26} className="calendar-confirm-icon" />
            <div className="calendar-confirm-title">生成今日世界</div>
            <div className="calendar-confirm-desc">
              为 <strong>{view === "detail" ? selectedDate : todayIso}</strong> 推演这群角色的一天：
              先出世界日纲（天气/氛围/互动），再逐角色生成日程，最后对齐同一场互动。
              <strong>主角</strong>逐个完整生成，<strong>配角</strong>合并成一次批量简版（省 token，每人最多 3 条）。
              当天已有 AI 日程会被覆盖，手动添加的保留。
            </div>
            <div className="calendar-worldgen-list">
              {([
                { label: "主角", list: owners.filter(o => o.ownerType === "character" && !o.isNpc) },
                { label: "配角 · 批量简版", list: owners.filter(o => o.ownerType === "character" && o.isNpc) },
              ] as const).map(group => group.list.length === 0 ? null : (
                <div key={group.label} className="calendar-worldgen-group">
                  <div className="calendar-worldgen-group-label">{group.label}（{group.list.length}）</div>
                  <div className="calendar-worldgen-group-grid">
                    {group.list.map(o => (
                      <button
                        key={o.ownerId}
                        type="button"
                        className={`calendar-worldgen-char${worldGenSelected.has(o.ownerId) ? " on" : ""}`}
                        disabled={worldGenStage !== null}
                        onClick={() => setWorldGenSelected(prev => {
                          const next = new Set(prev);
                          if (next.has(o.ownerId)) next.delete(o.ownerId);
                          else next.add(o.ownerId);
                          return next;
                        })}
                      >
                        <Avatar src={o.avatar || undefined} name={o.name} size="sm" />
                        <span>{o.name}</span>
                        {o.isNpc && <span className="calendar-worldgen-npc-tag">NPC</span>}
                        {worldGenSelected.has(o.ownerId) && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {owners.filter(o => o.ownerType === "character").length === 0 && (
                <div className="calendar-menstrual-empty">还没有角色卡</div>
              )}
            </div>
            {worldGenStage && <div className="calendar-worldgen-stage">{worldGenStage}</div>}
            <div className="calendar-confirm-footer">
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setWorldGenOpen(false)} disabled={worldGenStage !== null}>取消</button>
              <button
                type="button"
                className="calendar-block-btn"
                data-variant="primary"
                onClick={handleGenerateWorld}
                disabled={worldGenStage !== null || worldGenSelected.size === 0}
                aria-busy={worldGenStage !== null}
              >
                {worldGenStage ? "生成中…" : `生成（${worldGenSelected.size} 人）`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAutoConfirm && selectedOwner && (
        <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => setShowAutoConfirm(false)}>
          <div className="calendar-edit-modal calendar-confirm-dialog" onClick={e => e.stopPropagation()}>
            <Bot size={26} className="calendar-confirm-icon" />
            <div className="calendar-confirm-title">
              {autoGenerateEnabled ? "关闭自动生成？" : "开启自动生成？"}
            </div>
            <div className="calendar-confirm-desc">
              {autoGenerateEnabled
                ? "关闭后将不再自动为角色生成每周日程"
                : <>每周将自动为 <strong>{selectedOwner.name}</strong> 生成日程安排</>}
            </div>
            <div className="calendar-confirm-footer">
              <button type="button" className="calendar-block-btn" data-variant="ghost" onClick={() => setShowAutoConfirm(false)}>取消</button>
              <button
                type="button"
                className="calendar-block-btn"
                data-variant="primary"
                onClick={() => {
                  const next = !autoGenerateEnabled;
                  const nextConfig = { ...config, autoGenerateEnabled: next };
                  setConfig(nextConfig);
                  saveCalendarConfig(nextConfig);
                  setShowAutoConfirm(false);
                  onNotice?.(next ? "已开启每周自动生成" : "已关闭每周自动生成");
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
