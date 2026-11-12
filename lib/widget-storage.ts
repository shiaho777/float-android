import type { IconId, IconPosition } from "@/lib/desktop-config";
import { PAGE_1_DEFAULT, PAGE_2_DEFAULT } from "@/lib/desktop-config";
import {
  GRID_COLS,
  GRID_ROWS,
  WIDGET_SIZE_CELLS,
  type WidgetInstance,
  type WidgetSize,
} from "@/lib/widget-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_widgets_v1";
registerKvMigration(STORAGE_KEY);

const DIY_TEMPLATES_KEY = "ai_phone_diy_templates_v1";
registerKvMigration(DIY_TEMPLATES_KEY);

const DEFAULT_WIDGETS: WidgetInstance[] = [
  // 第一页：大时钟 + 心情气泡
  { id: "default_widget_large_time", type: "largeTime", size: "2x4", page: 1, row: 1, col: 1 },
  { id: "default_widget_mood_pill", type: "moodPill", size: "1x4", page: 1, row: 3, col: 1 },
  // 第二页：个人名片 + iOS 操作菜单
  { id: "default_widget_my_space", type: "mySpace", size: "3x4", page: 2, row: 1, col: 1 },
  { id: "default_widget_ios_menu", type: "iosMenu", size: "1x4", page: 2, row: 4, col: 1 },
  // 第三页：天气卡 + 日历（日历占左半边，右半边是四个图标）
  { id: "default_widget_weather", type: "freestyleFrame68", size: "2x4", page: 3, row: 2, col: 1 },
  { id: "default_widget_calendar", type: "calendar", size: "2x2", page: 3, row: 4, col: 1 },
];

export function createDefaultWidgets(): WidgetInstance[] {
  return DEFAULT_WIDGETS.map((widget) => ({ ...widget }));
}

export function loadWidgets(): WidgetInstance[] {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return createDefaultWidgets();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidWidget).map((widget) => (
      // fortune / interviewMagazine 两个小组件已移除：落在桌面上的实例换成通用照片框，
      // 避免留下一个渲染不出来的空块。
      widget.type === "fortune" || widget.type === "interviewMagazine"
        ? { ...widget, type: "photo", size: widget.size === "2x4" ? "2x2" : widget.size }
        : widget
    ));
  } catch {
    return [];
  }
}

export function saveWidgets(widgets: WidgetInstance[]): void {
  kvSet(STORAGE_KEY, JSON.stringify(widgets));
}

import type { DIYWidgetTemplate } from "./widget-types";

export function loadDIYTemplates(): DIYWidgetTemplate[] {
  try {
    const raw = kvGet(DIY_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as DIYWidgetTemplate[];
  } catch {
    return [];
  }
}

export function saveDIYTemplates(templates: DIYWidgetTemplate[]): void {
  kvSet(DIY_TEMPLATES_KEY, JSON.stringify(templates));
}

function isValidWidget(w: unknown): w is WidgetInstance {
  if (!w || typeof w !== "object") return false;
  const o = w as Record<string, unknown>;
  const page = typeof o.page === "number" && Number.isInteger(o.page) && o.page >= 1 ? o.page : null;
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    typeof o.size === "string" &&
    page !== null &&
    typeof o.row === "number" &&
    typeof o.col === "number"
  );
}

/**
 * Build a 6x4 occupancy grid for a given page.
 * Each cell is either null (free), an icon ID string, or a widget ID string.
 */
export type OccupancyGrid = (string | null)[][];

export function buildOccupancyGrid(
  pageIcons: readonly IconPosition[],
  widgets: WidgetInstance[],
  page: number
): OccupancyGrid {
  const grid: OccupancyGrid = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => null)
  );

  // Place widgets
  for (const w of widgets) {
    if (w.page !== page) continue;
    const [rows, cols] = WIDGET_SIZE_CELLS[w.size];
    for (let dr = 0; dr < rows; dr++) {
      for (let dc = 0; dc < cols; dc++) {
        const r = w.row - 1 + dr;
        const c = w.col - 1 + dc;
        if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
          grid[r][c] = `widget:${w.id}`;
        }
      }
    }
  }

  // Place icons
  for (const icon of pageIcons) {
    const r = icon.row - 1;
    const c = icon.col - 1;
    if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS && grid[r][c] === null) {
      grid[r][c] = `icon:${icon.id}`;
    }
  }

  return grid;
}

/**
 * Check if a widget can be placed at the given position without collision.
 */
export function canPlaceWidget(
  grid: OccupancyGrid,
  size: WidgetSize,
  row: number,
  col: number
): boolean {
  const [rows, cols] = WIDGET_SIZE_CELLS[size];
  // Check bounds (row/col are 1-based)
  if (row < 1 || col < 1 || row + rows - 1 > GRID_ROWS || col + cols - 1 > GRID_COLS) {
    return false;
  }
  // Check all cells are free
  for (let dr = 0; dr < rows; dr++) {
    for (let dc = 0; dc < cols; dc++) {
      if (grid[row - 1 + dr][col - 1 + dc] !== null) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Place a widget: returns updated widgets array with the new widget added.
 */
export function placeWidget(
  widgets: WidgetInstance[],
  widget: Omit<WidgetInstance, "id">
): WidgetInstance[] {
  const id = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return [...widgets, { ...widget, id }];
}

/**
 * Remove a widget by ID.
 */
export function removeWidget(widgets: WidgetInstance[], widgetId: string): WidgetInstance[] {
  return widgets.filter((w) => w.id !== widgetId);
}

/**
 * Get the default page icons for a page number.
 */
export function getDefaultPageIcons(page: number): IconId[] {
  if (page === 1) return [...PAGE_1_DEFAULT];
  if (page === 2) return [...PAGE_2_DEFAULT];
  return [];
}
