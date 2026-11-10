"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Columns2, Settings2 } from "lucide-react";
import type { CalendarScheduleItem, DailyWorldPlan } from "@/lib/calendar-types";
import type { MenstrualDayState } from "@/lib/menstrual-storage";
import { formatIsoDate, parseIsoDate, timeToMinutes } from "@/lib/calendar-utils";
import { getZonedClock } from "@/lib/character-time";
import { getLunarInfoByIso } from "@/lib/lunar";

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];
const WEEK_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const HOUR_H = 48;
const DAY_MS = 86400000;
const STRIP_RADIUS = 8;   // 周条 ±8 周
const DAY_RADIUS = 21;    // 时间轴 ±21 天（7 天/页时也够滑三页，且整周对齐）

const addDaysIso = (iso: string, n: number) => formatIsoDate(new Date(parseIsoDate(iso).getTime() + n * DAY_MS));
const sundayStartOf = (iso: string) => {
  const d = parseIsoDate(iso);
  return addDaysIso(iso, -d.getDay());
};

type PositionedEvent = {
  item: CalendarScheduleItem;
  top: number;
  height: number;
  left: number;   // %
  width: number;  // %
};

/** 重叠事件“列分配”布局 */
function layoutDayEvents(items: CalendarScheduleItem[]): PositionedEvent[] {
  const sorted = [...items]
    .map(item => ({
      item,
      start: timeToMinutes(item.startTime),
      end: Math.max(timeToMinutes(item.endTime), timeToMinutes(item.startTime) + 25),
    }))
    .filter(entry => !Number.isNaN(entry.start) && !Number.isNaN(entry.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const results: PositionedEvent[] = [];
  let clusterMaxEnd = -1;
  let columnEnds: number[] = [];
  let clusterEntries: Array<{ entry: (typeof sorted)[number]; column: number }> = [];

  const flush = () => {
    const columnCount = Math.max(columnEnds.length, 1);
    for (const { entry, column } of clusterEntries) {
      results.push({
        item: entry.item,
        top: (entry.start / 60) * HOUR_H,
        height: Math.max(((entry.end - entry.start) / 60) * HOUR_H - 2, 20),
        left: (column / columnCount) * 100,
        width: 100 / columnCount,
      });
    }
    columnEnds = [];
    clusterEntries = [];
  };

  for (const entry of sorted) {
    if (clusterEntries.length > 0 && entry.start >= clusterMaxEnd) {
      flush();
      clusterMaxEnd = -1;
    }
    let column = columnEnds.findIndex(end => end <= entry.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(entry.end);
    } else {
      columnEnds[column] = entry.end;
    }
    clusterEntries.push({ entry, column });
    clusterMaxEnd = Math.max(clusterMaxEnd, entry.end);
  }
  flush();
  return results;
}

export function CalendarDetailPage({
  initialDate,
  todayIso,
  timeZone,
  zoneCity,
  itemsByDate,
  cycleMap,
  cyclePanel,
  daysPerPage,
  onOpenDaysPicker,
  onOpenCycleSettings,
  onBack,
  onSelectedChange,
  onEditItem,
  resolveCharName,
  worldByDate,
  onToggleTodo,
}: {
  initialDate: string;
  todayIso: string;
  /** Selected character's IANA zone. Empty follows the phone clock. */
  timeZone?: string | null;
  /** Short city shown on today's column when the zone differs from the phone. */
  zoneCity?: string;
  itemsByDate: Map<string, CalendarScheduleItem[]>;
  cycleMap: Map<string, MenstrualDayState> | null;
  /** 经期打卡行（仅用户视图传入），渲染在周条下方 */
  cyclePanel: ReactNode;
  /** 时间轴一页显示的天数（1/2/3/5/7） */
  daysPerPage: number;
  /** 打开“每页天数”选择弹窗 */
  onOpenDaysPicker: () => void;
  /** 周期设置入口（仅用户视图传入），渲染在右上角 */
  onOpenCycleSettings: (() => void) | null;
  onBack: () => void;
  onSelectedChange: (iso: string) => void;
  onEditItem: (item: CalendarScheduleItem) => void;
  /** 参与者 id → 显示名（"与XX一起"徽标用） */
  resolveCharName?: (id: string) => string;
  /** 各日期的世界日纲（"今日世界"生成结果），key=YYYY-MM-DD */
  worldByDate?: Map<string, DailyWorldPlan>;
  /** 待办勾选切换（明细块里直接点） */
  onToggleTodo?: (item: CalendarScheduleItem, todoIndex: number) => void;
}) {
  const [center, setCenter] = useState(initialDate);
  const [selectedIso, setSelectedIso] = useState(initialDate);
  const selectedRef = useRef(initialDate);

  const stripRef = useRef<HTMLDivElement>(null);
  const tlHRef = useRef<HTMLDivElement>(null);
  const tlHeadRef = useRef<HTMLDivElement>(null);
  const tlVRef = useRef<HTMLDivElement>(null);
  const suppressRef = useRef(false);
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const weeks = useMemo(() => {
    const base = sundayStartOf(center);
    return Array.from({ length: STRIP_RADIUS * 2 + 1 }, (_, i) => addDaysIso(base, (i - STRIP_RADIUS) * 7));
  }, [center]);

  const days = useMemo(
    () => Array.from({ length: DAY_RADIUS * 2 + 1 }, (_, i) => addDaysIso(center, i - DAY_RADIUS)),
    [center],
  );
  const daysRef = useRef(days);
  daysRef.current = days;
  const dppRef = useRef(daysPerPage);
  dppRef.current = daysPerPage;

  // ── 选中高亮（黑/红圆 + 双日灰胶囊），命令式定位 ──
  const paintSelection = (animate: boolean, prevIso?: string) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.querySelectorAll<HTMLElement>(".calendar-strip-bubble").forEach(b => { b.style.display = "none"; });
    strip.querySelectorAll(".calendar-strip-cell.is-selected").forEach(c => c.classList.remove("is-selected"));
    const sel = selectedRef.current;
    const panel = strip.querySelector<HTMLElement>(`[data-week="${sundayStartOf(sel)}"]`);
    if (!panel) return;
    const cell = panel.querySelector<HTMLElement>(`[data-date="${sel}"]`);
    if (!cell) return;
    cell.classList.add("is-selected");
    const bubble = panel.querySelector<HTMLElement>(".calendar-strip-bubble");
    if (!bubble) return;
    const x = cell.offsetLeft + cell.offsetWidth / 2 - 24;
    bubble.style.display = "block";
    bubble.classList.toggle("is-today", sel === todayIso);
    const samePanelPrev = prevIso && sundayStartOf(prevIso) === sundayStartOf(sel);
    if (animate && samePanelPrev && !reducedMotion) {
      const prevCell = panel.querySelector<HTMLElement>(`[data-date="${prevIso}"]`);
      const x0 = prevCell ? prevCell.offsetLeft + prevCell.offsetWidth / 2 - 24 : x;
      bubble.style.transform = `translateX(${x}px)`;
      bubble.animate(
        [
          { transform: `translateX(${x0}px) scale(1)` },
          { transform: `translateX(${(x0 + x) / 2}px) scale(0.55)` },
          { transform: `translateX(${x}px) scale(1)` },
        ],
        { duration: 230, easing: "cubic-bezier(0.3, 0.7, 0.35, 1)" },
      );
    } else if (animate && !reducedMotion) {
      bubble.style.transform = `translateX(${x}px)`;
      bubble.animate(
        [
          { transform: `translateX(${x}px) scale(0.4)`, opacity: 0.4 },
          { transform: `translateX(${x}px) scale(1)`, opacity: 1 },
        ],
        { duration: 180, easing: "ease-out" },
      );
    } else {
      bubble.style.transform = `translateX(${x}px)`;
    }
  };

  const updateRangePill = (fIdx: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.querySelectorAll<HTMLElement>(".calendar-strip-range").forEach(p => { p.style.display = "none"; });
    const list = daysRef.current;
    const base = Math.max(0, Math.min(list.length - 1, Math.floor(fIdx)));
    const frac = fIdx - Math.floor(fIdx);
    const d0 = list[base];
    if (!d0) return;
    const panel = strip.querySelector<HTMLElement>(`[data-week="${sundayStartOf(d0)}"]`);
    if (!panel) return;
    const pill = panel.querySelector<HTMLElement>(".calendar-strip-range");
    if (!pill) return;
    const cellW = panel.clientWidth / 7;
    pill.style.display = "block";
    pill.style.width = `${cellW * dppRef.current}px`;
    pill.style.transform = `translateX(${(parseIsoDate(d0).getDay() + frac) * cellW}px)`;
  };

  const snapStripTo = (iso: string, smooth: boolean) => {
    const strip = stripRef.current;
    if (!strip) return;
    const panel = strip.querySelector<HTMLElement>(`[data-week="${sundayStartOf(iso)}"]`);
    if (!panel) return;
    strip.scrollTo({ left: panel.offsetLeft - strip.offsetLeft, behavior: smooth ? "smooth" : "auto" });
  };

  const snapTimelineTo = (iso: string, smooth: boolean) => {
    const tl = tlHRef.current;
    if (!tl) return;
    const idx = daysRef.current.indexOf(iso);
    if (idx < 0) return;
    suppressRef.current = true;
    tl.scrollTo({ left: idx * (tl.clientWidth / dppRef.current), behavior: smooth ? "smooth" : "auto" });
    window.setTimeout(() => { suppressRef.current = false; }, smooth ? 420 : 60);
  };

  const applySelection = (iso: string, opts?: { fromStrip?: boolean; fromTimeline?: boolean }) => {
    const prev = selectedRef.current;
    if (iso === prev) return;
    if (!daysRef.current.includes(iso)) {
      selectedRef.current = iso;
      setSelectedIso(iso);
      onSelectedChange(iso);
      setCenter(iso);
      return;
    }
    selectedRef.current = iso;
    setSelectedIso(iso);
    onSelectedChange(iso);
    paintSelection(true, prev);
    if (opts?.fromStrip) snapTimelineTo(iso, true);
    if (!opts?.fromTimeline) snapStripTo(iso, true);
  };

  // 数据范围（weeks/days）变化后：重新定位所有滚动与高亮
  useEffect(() => {
    requestAnimationFrame(() => {
      const sel = selectedRef.current;
      snapStripTo(sel, false);
      snapTimelineTo(sel, false);
      paintSelection(false);
      updateRangePill(daysRef.current.indexOf(sel));
      if (tlVRef.current && tlVRef.current.scrollTop === 0) {
        // 默认视角从 08:00 开始，往上滚动可查看更早时间
        tlVRef.current.scrollTop = 8 * HOUR_H;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center]);

  // 每页天数变化后：按新列宽重新对齐选中日
  const didMountDppRef = useRef(false);
  useEffect(() => {
    if (!didMountDppRef.current) {
      didMountDppRef.current = true;
      return;
    }
    requestAnimationFrame(() => {
      snapTimelineTo(selectedRef.current, false);
      updateRangePill(daysRef.current.indexOf(selectedRef.current));
    });
  }, [daysPerPage]);

  // 时间轴横向滚动：灰胶囊逐帧跟随；索引变化立即联动选中
  const handleTimelineScroll = () => {
    const tl = tlHRef.current;
    if (!tl) return;
    if (tlHeadRef.current) tlHeadRef.current.scrollLeft = tl.scrollLeft;
    const colW = tl.clientWidth / dppRef.current;
    if (colW <= 0) return;
    const fIdx = tl.scrollLeft / colW;
    updateRangePill(fIdx);
    if (suppressRef.current) return;
    const idx = Math.round(fIdx);
    const iso = daysRef.current[Math.max(0, Math.min(daysRef.current.length - 1, idx))];
    if (iso && iso !== selectedRef.current) {
      const prev = selectedRef.current;
      selectedRef.current = iso;
      setSelectedIso(iso);
      onSelectedChange(iso);
      paintSelection(true, prev);
      snapStripTo(iso, true);
    }
  };

  // 当前时间红线：跟选中角色的时区，每分钟刷新
  const [nowMinutes, setNowMinutes] = useState(() => getZonedClock(timeZone).minutes);
  useEffect(() => {
    const tick = () => setNowMinutes(getZonedClock(timeZone).minutes);
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [timeZone]);
  const nowTop = (nowMinutes / 60) * HOUR_H;
  const nowLabel = `${String(Math.floor(nowMinutes / 60)).padStart(2, "0")}:${String(nowMinutes % 60).padStart(2, "0")}`;

  const gotoToday = () => {
    if (!daysRef.current.includes(todayIso)) {
      selectedRef.current = todayIso;
      setSelectedIso(todayIso);
      onSelectedChange(todayIso);
      setCenter(todayIso);
      return;
    }
    applySelection(todayIso, { fromStrip: true });
  };

  const selectedDate = parseIsoDate(selectedIso);
  const backLabel = `${selectedDate.getMonth() + 1}月`;

  return (
    <div className="calendar-page calendar-page-detail">
      <div className="calendar-apple-topbar">
        <button type="button" className="calendar-pill-btn calendar-back-btn" onClick={onBack}>
          <span aria-hidden="true">‹</span> {backLabel}
        </button>
        <span className="calendar-topbar-space" />
        <button type="button" className="calendar-icon-btn" onClick={onOpenDaysPicker} aria-label="每页天数">
          <Columns2 size={17} />
        </button>
        {onOpenCycleSettings ? (
          <button type="button" className="calendar-icon-btn" onClick={onOpenCycleSettings} aria-label="周期设置">
            <Settings2 size={17} />
          </button>
        ) : null}
      </div>

      <div className="calendar-weekday-head calendar-strip-head" aria-hidden="true">
        {WEEKDAY_CN.map(w => (
          <span key={w}>{w}</span>
        ))}
      </div>

      <div className="calendar-week-strip hide-scrollbar" ref={stripRef}>
        {weeks.map(weekStart => (
          <div key={weekStart} className="calendar-strip-panel" data-week={weekStart}>
            <i className="calendar-strip-range" style={{ display: "none" }} aria-hidden="true" />
            <i className="calendar-strip-bubble" style={{ display: "none" }} aria-hidden="true" />
            {Array.from({ length: 7 }, (_, i) => {
              const iso = addDaysIso(weekStart, i);
              const d = parseIsoDate(iso);
              const lunar = getLunarInfoByIso(iso);
              const cycle = cycleMap?.get(iso) ?? null;
              return (
                <button
                  key={iso}
                  type="button"
                  className="calendar-strip-cell"
                  data-date={iso}
                  data-today={iso === todayIso ? "true" : undefined}
                  onClick={() => applySelection(iso, { fromStrip: true })}
                  aria-label={`${d.getMonth() + 1}月${d.getDate()}日`}
                >
                  <span className="calendar-strip-num">{d.getDate()}</span>
                  <span className="calendar-strip-lunar">{lunar?.cellLabel ?? ""}</span>
                  {cycle ? <i className="calendar-cycle-dot calendar-strip-cycle" data-type={cycle.type} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {cyclePanel}

      {/* 列头版头：固定在时间轴上方，横向随时间轴同步滚动 */}
      <div className="calendar-tl-headrow">
        <div className="calendar-tl-headrow-gutter" aria-hidden="true" />
        <div
          className="calendar-tl-headrow-days hide-scrollbar"
          ref={tlHeadRef}
          style={{ "--tl-day-w": `${100 / daysPerPage}%` } as CSSProperties}
        >
          {days.map(iso => {
            const d = parseIsoDate(iso);
            const lunar = getLunarInfoByIso(iso);
            return (
              <div
                key={iso}
                className="calendar-tl-day-head"
                data-today={iso === todayIso ? "true" : undefined}
                title={iso === todayIso && timeZone ? timeZone : undefined}
              >
                {daysPerPage >= 5 ? (
                  <>
                    <b>{d.getDate()}日</b>
                    <span>{WEEK_LABEL[d.getDay()]}</span>
                  </>
                ) : (
                  <>
                    <b>{d.getMonth() + 1}月{d.getDate()}日 – {WEEK_LABEL[d.getDay()]}</b>
                    <span>{lunar ? `${lunar.monthLabel}${lunar.isFirstDay ? "" : lunar.dayLabel}` : ""}</span>
                  </>
                )}
                {iso === todayIso && zoneCity ? <em className="calendar-tl-zone">{zoneCity}</em> : null}
                {(() => {
                  const world = worldByDate?.get(iso);
                  if (!world) return null;
                  const nameOf = (id: string) => id === "__user__" ? "用户" : (resolveCharName?.(id) ?? id);
                  return (
                    <div className="calendar-tl-world" data-compact={daysPerPage >= 5 ? "true" : undefined}>
                      {world.weather || world.vibe ? (
                        <div className="calendar-tl-world-meta">
                          {[world.weather, world.vibe].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                      {world.interactions.slice(0, daysPerPage >= 5 ? 1 : 3).map(it => (
                        <div key={it.id} className="calendar-tl-world-evt" title={it.outcome ? `${it.what}（${it.outcome}）` : it.what}>
                          <i>{it.startTime ?? it.timeHint}</i>
                          <span>{it.participantIds.map(nameOf).join("×")}</span>
                          {/* what+结果必须包进可收缩元素：裸文本是匿名 flex item，nowrap 下收缩不了，
                              会把列头最小小内容宽度撑爆 → 当天列变宽、后续列全部错位 */}
                          <em>{it.what}{it.outcome ? ` → ${it.outcome}` : ""}</em>
                        </div>
                      ))}
                      {world.interactions.length > (daysPerPage >= 5 ? 1 : 3) && (
                        <div className="calendar-tl-world-more">+{world.interactions.length - (daysPerPage >= 5 ? 1 : 3)} 场互动</div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>

      <div className="calendar-tl-vscroll hide-scrollbar" ref={tlVRef}>
        <div className="calendar-tl-row">
          <div className="calendar-tl-gutter" aria-hidden="true">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h}>{String(h).padStart(2, "0")}:00</span>
            ))}
            <i className="calendar-now-badge" style={{ top: `${nowTop}px` }} title={timeZone || undefined}>{nowLabel}</i>
          </div>
          <div
            className="calendar-tl-hscroll hide-scrollbar"
            ref={tlHRef}
            onScroll={handleTimelineScroll}
            style={{ "--tl-day-w": `${100 / daysPerPage}%` } as CSSProperties}
          >
            {days.map(iso => {
              const positioned = layoutDayEvents(itemsByDate.get(iso) ?? []);
              return (
                <div key={iso} className="calendar-tl-day" data-today={iso === todayIso ? "true" : undefined}>
                  <div className="calendar-tl-body">
                    {iso === todayIso ? (
                      <i className="calendar-now-line" style={{ top: `${nowTop}px` }} aria-hidden="true" />
                    ) : null}
                    {positioned.map(pos => (
                      <button
                        key={pos.item.id}
                        type="button"
                        className="calendar-tl-event"
                        data-color={pos.item.colorKey}
                        style={{
                          top: `${pos.top}px`,
                          height: `${pos.height}px`,
                          left: `calc(${pos.left}% + 3px)`,
                          width: `calc(${pos.width}% - 6px)`,
                        }}
                        onClick={() => onEditItem(pos.item)}
                        aria-label={`${pos.item.startTime} ${pos.item.title}`}
                      >
                        <b>
                          {pos.item.emoji ? `${pos.item.emoji} ` : ""}{pos.item.title}
                          {(pos.item.participants?.length ?? 0) > 0 && (
                            <em className="calendar-tl-with">
                              与{pos.item.participants!.map(id => resolveCharName?.(id) ?? id).join("、")}
                            </em>
                          )}
                        </b>
                        <span>
                          {pos.item.startTime}–{pos.item.endTime}
                          {pos.item.location ? ` · ${pos.item.location}` : ""}
                          {pos.item.source === "generated" ? " · AI" : ""}
                        </span>
                        {pos.height >= 56 && pos.item.mood ? (
                          <i className="calendar-tl-mood">{pos.item.mood}</i>
                        ) : null}
                        {pos.height >= 76 && pos.item.note ? (
                          <i className="calendar-tl-note">{pos.item.note}</i>
                        ) : null}
                        {pos.height >= 92 && pos.item.todos?.length ? (
                          <span className="calendar-tl-todos">
                            {pos.item.todos.map((t, ti) => (
                              <em
                                key={ti}
                                data-done={t.done ? "true" : undefined}
                                onClick={e => {
                                  if (!onToggleTodo) return;
                                  e.stopPropagation();
                                  onToggleTodo(pos.item, ti);
                                }}
                              >
                                {t.done ? "☑" : "☐"}{t.text}
                              </em>
                            ))}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="calendar-float-bar">
        <button type="button" className="calendar-pill-btn" onClick={gotoToday}>
          今天
        </button>
      </div>
    </div>
  );
}
