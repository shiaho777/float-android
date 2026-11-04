// 「收起键盘自动触发回复」的独立配置。
// 刻意不复用 settings-storage：整个功能只由新增文件 + 少量纯插入组成，
// 与主设置文件互不影响，全部关闭时行为与原版完全一致。
//
// 开关和等待秒数都按聊天窗口（sessionId）各存各的：设置页本来就是单个聊天的，
// 在哪拨开就只对哪个聊天生效，「这个角色开、那个角色不开」天然成立。
const CONFIG_KEY = "pneuma_keyboard_auto_send_v1";

export interface KeyboardAutoSendConfig {
    /** 按会话的开关。缺省 = 关（不改变任何存量行为）。key = sessionId。 */
    sessionEnabled: Record<string, boolean>;
    /** 按会话的等待时长（毫秒）。缺省用 DEFAULT_DEBOUNCE_MS。key = sessionId。 */
    sessionDebounceMs: Record<string, number>;
}

export const MIN_AUTO_SEND_DEBOUNCE_MS = 0;
export const MAX_AUTO_SEND_DEBOUNCE_MS = 30_000;
export const DEFAULT_DEBOUNCE_MS = 1000;

const DEFAULT_CONFIG: KeyboardAutoSendConfig = {
    sessionEnabled: {},
    sessionDebounceMs: {},
};

export function normalizeDebounceMs(value: unknown, fallback = DEFAULT_DEBOUNCE_MS): number {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(MIN_AUTO_SEND_DEBOUNCE_MS, Math.min(MAX_AUTO_SEND_DEBOUNCE_MS, Math.round(raw)));
}

export function loadKeyboardAutoSendConfig(): KeyboardAutoSendConfig {
    if (typeof window === "undefined") return { sessionEnabled: {}, sessionDebounceMs: {} };
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return { sessionEnabled: {}, sessionDebounceMs: {} };
        const saved = JSON.parse(raw) as Partial<KeyboardAutoSendConfig>;
        const enabledMap: Record<string, boolean> = {};
        if (saved.sessionEnabled && typeof saved.sessionEnabled === "object") {
            for (const [key, value] of Object.entries(saved.sessionEnabled)) {
                if (typeof value === "boolean") enabledMap[key] = value;
            }
        }
        const debounceMap: Record<string, number> = {};
        if (saved.sessionDebounceMs && typeof saved.sessionDebounceMs === "object") {
            for (const [key, value] of Object.entries(saved.sessionDebounceMs)) {
                const ms = Number(value);
                if (Number.isFinite(ms)) debounceMap[key] = normalizeDebounceMs(ms);
            }
        }
        return { sessionEnabled: enabledMap, sessionDebounceMs: debounceMap };
    } catch {
        return { sessionEnabled: {}, sessionDebounceMs: {} };
    }
}

function saveConfig(config: KeyboardAutoSendConfig): void {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* ignore */ }
}

/** 该会话是否开启了收起键盘自动触发（缺省关）。 */
export function isKeyboardAutoSendEnabled(sessionId: string): boolean {
    return loadKeyboardAutoSendConfig().sessionEnabled[sessionId] === true;
}

export function setSessionKeyboardAutoSendEnabled(sessionId: string, enabled: boolean): void {
    const config = loadKeyboardAutoSendConfig();
    const enabledMap = { ...config.sessionEnabled };
    if (enabled) enabledMap[sessionId] = true;
    else delete enabledMap[sessionId];
    saveConfig({ ...config, sessionEnabled: enabledMap });
}

/** 取该会话生效的等待时长：存过用存的，否则用默认 1 秒。 */
export function getKeyboardAutoSendDebounceMs(sessionId?: string): number {
    const config = loadKeyboardAutoSendConfig();
    if (sessionId && sessionId in config.sessionDebounceMs) {
        return config.sessionDebounceMs[sessionId];
    }
    return DEFAULT_DEBOUNCE_MS;
}

/** 写该会话的等待时长；传 null 表示清掉、回到默认。 */
export function setSessionKeyboardAutoSendDebounce(sessionId: string, ms: number | null): void {
    const config = loadKeyboardAutoSendConfig();
    const debounceMap = { ...config.sessionDebounceMs };
    if (ms === null) {
        delete debounceMap[sessionId];
    } else {
        debounceMap[sessionId] = normalizeDebounceMs(ms);
    }
    saveConfig({ ...config, sessionDebounceMs: debounceMap });
}
