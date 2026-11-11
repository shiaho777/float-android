"use client";

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronLeft, Palette } from "lucide-react";
import type { CalendarScheduleItem } from "@/lib/calendar-types";
import type { MenstrualDayState } from "@/lib/menstrual-storage";
import { formatIsoDate } from "@/lib/calendar-utils";
import { getLunarInfoByIso } from "@/lib/lunar";

const MONTH_CN = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

type MonthCell = {
  iso: string;
  day: number;
  weekday: number;      // 0 = 周日
  lunarLabel: string;
  lunarFirst: boolean;
};

type MonthBlock = {
  ym: string;           // "2026-7"（月份为 0 基）
  year: number;
  month: number;        // 0 基
  firstWeekday: number;
  weeks: MonthCell[][];
};

/**
 * 构建 today ±12 个月的月历数据。
 *
 * 农历走的是 Intl 的 chinese 历法，每次 formatToParts 都不便宜；25 个月约 760 天，
 * 全量同步算要 70~90ms，会让日历首次打开明显卡一下。所以先只排出格子（withLunar=false），
 * 农历小字交给调用方在空闲时段补，首屏立刻出来。
 */
function buildMonths(todayIso: string, withLunar: boolean): MonthBlock[] {
  const today = new Date(`${todayIso}T00:00:00`);
  const blocks: MonthBlock[] = [];
  for (let m = -12; m <= 12; m++) {
    const first = new Date(today.getFullYear(), today.getMonth() + m, 1);
    const year = first.getFullYear();
    const month = first.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const weeks: MonthCell[][] = [];
    let week: MonthCell[] = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(year, month, day);
      if (week.length > 0 && d.getDay() === 0) {
        weeks.push(week);
        week = [];
      }
      week.push({
        iso: formatIsoDate(d),
        day,
        weekday: d.getDay(),
        lunarLabel: "",
        lunarFirst: false,
      });
    }
    if (week.length > 0) weeks.push(week);
    blocks.push({ ym: `${year}-${month}`, year, month, firstWeekday: first.getDay(), weeks });
  }
  return withLunar ? blocks.map(fillMonthLunar) : blocks;
}

/** 给一个月的格子补上农历小字（纯函数，返回新对象）。 */
function fillMonthLunar(block: MonthBlock): MonthBlock {
  return {
    ...block,
    weeks: block.weeks.map(week => week.map(cell => {
      const lunar = getLunarInfoByIso(cell.iso);
      return { ...cell, lunarLabel: lunar?.cellLabel ?? "", lunarFirst: lunar?.isFirstDay ?? false };
    })),
  };
}

type MonthBlockViewProps = {
  block: MonthBlock;
  todayIso: string;
  todayYm: string;
  itemsByDate: Map<string, CalendarScheduleItem[]>;
  cycleMap: Map<string, MenstrualDayState> | null;
  onPickDay: (iso: string) => void;
};

/**
 * 单个月份块。
 *
 * 日历一次要挂 25 个月。农历是空闲时分批补进来的，每次补完都要重新提交一次；
 * 如果整棵树一起重渲染，每次提交都是 4000+ 节点的协调。这里把月块 memo 掉，
 * 补哪几个月就只重渲染那几个月——提交被切碎，不会在补齐的瞬间卡住一次点击。
 */
const MonthBlockView = memo(function MonthBlockView({
  block,
  todayIso,
  todayYm,
  itemsByDate,
  cycleMap,
  onPickDay,
}: MonthBlockViewProps) {
  return (
    <div className="calendar-month-block" data-ym={block.ym}>
      <div
        className="calendar-month-label"
        style={{ "--label-offset": `${(block.firstWeekday / 7) * 100}%` } as CSSProperties}
      >
        <strong data-current={block.ym === todayYm ? "true" : undefined}>{block.month + 1}月</strong>
      </div>
      {block.weeks.map((week, wi) => (
        <div key={wi} className="calendar-month-week">
          {week.map(cell => {
            const items = itemsByDate.get(cell.iso);
            const cycle = cycleMap?.get(cell.iso) ?? null;
            return (
              <button
                key={cell.iso}
                type="button"
                className="calendar-month-cell"
                data-today={cell.iso === todayIso ? "true" : undefined}
                style={{ gridColumnStart: cell.weekday + 1 }}
                aria-label={`${block.month + 1}月${cell.day}日${items?.length ? `，${items.length}个日程` : ""}`}
                onClick={() => onPickDay(cell.iso)}
              >
                <span className="calendar-month-num">{cell.day}</span>
                <span className={`calendar-month-lunar${cell.lunarFirst ? " is-first" : ""}`}>{cell.lunarLabel}</span>
                <span className="calendar-month-dots" aria-hidden="true">
                  {cycle ? <i className="calendar-cycle-dot" data-type={cycle.type} /> : null}
                  {items && items.length > 0 ? <i className="calendar-event-dot" data-color={items[0].colorKey} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
});

export function CalendarMonthPage({
  todayIso,
  zoneCity,
  localTimeLabel,
  itemsByDate,
  cycleMap,
  ownerStrip,
  onPickDay,
  onClose,
  onOpenTheme,
}: {
  todayIso: string;
  /** City of the selected character's zone, when it differs from the phone. */
  zoneCity?: string;
  localTimeLabel?: string;
  itemsByDate: Map<string, CalendarScheduleItem[]>;
  cycleMap: Map<string, MenstrualDayState> | null;
  ownerStrip: ReactNode;
  onPickDay: (iso: string) => void;
  onClose: () => void;
  onOpenTheme: () => void;
}) {
  // 首帧只用骨架（不含农历），农历在空闲时分批补齐
  const skeletonMonths = useMemo(() => buildMonths(todayIso, false), [todayIso]);
  const [lunarMonths, setLunarMonths] = useState<{ iso: string; blocks: MonthBlock[] } | null>(null);
  const months = lunarMonths && lunarMonths.iso === todayIso ? lunarMonths.blocks : skeletonMonths;

  useEffect(() => {
    let cancelled = false;
    const pending = buildMonths(todayIso, false);
    let index = 0;
    type IdleWin = Window & {
      requestIdleCallback?: (cb: (d: { timeRemaining: () => number }) => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    const idleWin = window as IdleWin;
    let idleHandle = 0;
    let timer = 0;
    const schedule = (fn: () => void) => {
      if (typeof idleWin.requestIdleCallback === "function") idleHandle = idleWin.requestIdleCallback(() => fn(), { timeout: 1200 });
      else timer = window.setTimeout(fn, 80);
    };
    const step = (deadline?: { timeRemaining: () => number }) => {
      if (cancelled) return;
      const from = index;
      while (index < pending.length && (!deadline || deadline.timeRemaining() > 4)) {
        pending[index] = fillMonthLunar(pending[index]);
        index += 1;
      }
      // 每批填完就提交一次：月块是 memo 的，只有这批变了的月份会重渲染，
      // 所以提交本身很轻，也不会出现「补完最后一秒一次性替换 25 个月」的卡顿。
      // 数组必须换新（slice），否则同一个引用会被 React 判成没变化。
      if (index > from) setLunarMonths({ iso: todayIso, blocks: pending.slice() });
      if (index < pending.length) schedule(step);
    };
    schedule(step);
    return () => {
      cancelled = true;
      if (idleHandle) idleWin.cancelIdleCallback?.(idleHandle);
      window.clearTimeout(timer);
    };
  }, [todayIso]);
  const todayYm = useMemo(() => {
    const d = new Date(`${todayIso}T00:00:00`);
    return `${d.getFullYear()}-${d.getMonth()}`;
  }, [todayIso]);
  const [titleYm, setTitleYm] = useState(todayYm);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerH, setHeaderH] = useState(0);
  const headerHRef = useRef(0);
  headerHRef.current = headerH;
  const tickingRef = useRef(false);

  // 顶部玻璃悬浮层高度 → 滚动区 padding-top
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => setHeaderH(header.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const scrollToYm = (ym: string, smooth: boolean) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const block = scroller.querySelector<HTMLElement>(`[data-ym="${ym}"]`);
    if (!block) return;
    scroller.scrollTo({ top: block.offsetTop - headerHRef.current, behavior: smooth ? "smooth" : "auto" });
    setTitleYm(ym);
  };

  // 首次定位到当前月（等 header 量高后）
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current || headerH === 0) return;
    didInitRef.current = true;
    requestAnimationFrame(() => scrollToYm(todayYm, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerH]);

  const handleScroll = () => {
    if (tickingRef.current) return;
    tickingRef.current = true;
    requestAnimationFrame(() => {
      tickingRef.current = false;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const probe = scroller.scrollTop + headerHRef.current + 60;
      for (const child of Array.from(scroller.children) as HTMLElement[]) {
        if (!(child instanceof HTMLElement) || !child.dataset.ym) continue;
        if (child.offsetTop + child.offsetHeight > probe) {
          const ym = child.dataset.ym;
          setTitleYm(prev => (prev === ym ? prev : ym));
          break;
        }
      }
    });
  };

  const [titleYear, titleMonth] = titleYm.split("-").map(Number);

  return (
    <div className="calendar-page calendar-page-month">
      <div className="calendar-month-scroll hide-scrollbar" ref={scrollRef} onScroll={handleScroll} style={{ paddingTop: headerH }}>
        {months.map(block => (
          <MonthBlockView
            key={block.ym}
            block={block}
            todayIso={todayIso}
            todayYm={todayYm}
            itemsByDate={itemsByDate}
            cycleMap={cycleMap}
            onPickDay={onPickDay}
          />
        ))}
      </div>

      {/* 顶部玻璃悬浮层：周几及以上区域，日历内容从下方透出 */}
      <div className="calendar-month-header" ref={headerRef}>
        <div className="calendar-apple-topbar">
          <button type="button" className="calendar-pill-btn calendar-back-btn" onClick={onClose} aria-label="返回桌面">
            <ChevronLeft size={19} />
            {titleYear}年
          </button>
          <span className="calendar-topbar-space" />
          <button type="button" className="calendar-icon-btn" onClick={onOpenTheme} aria-label="主题与自定义">
            <Palette size={17} />
          </button>
        </div>

        {ownerStrip}

        <div className="calendar-month-title">
          <strong>{MONTH_CN[titleMonth] ?? ""}</strong>
        </div>
        <div className="calendar-weekday-head" aria-hidden="true">
          {WEEKDAY_CN.map(w => (
            <span key={w}>{w}</span>
          ))}
        </div>
      </div>

      {/* 底部渐隐模糊 */}
      <div className="calendar-bottom-fade" aria-hidden="true" />

      <div className="calendar-float-bar">
        <button
          type="button"
          className="calendar-pill-btn"
          onClick={() => scrollToYm(todayYm, true)}
          title={zoneCity && localTimeLabel ? `${zoneCity} ${localTimeLabel}` : undefined}
        >
          {zoneCity ? `今天 · ${zoneCity}` : "今天"}
        </button>
      </div>
    </div>
  );
}
