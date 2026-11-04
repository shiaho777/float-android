// Float → Pneuma 更名后的旧标识兼容。
// 旧版写进 localStorage 的键在启动时搬到新键名；旧备份恢复时也按同一张表改名，
// 这样无论数据从哪条路进来，落地的都只有新键名。

const LEGACY_LOCAL_STORAGE_KEYS: Readonly<Record<string, string>> = {
    float_keyboard_auto_send_v1: "pneuma_keyboard_auto_send_v1",
    float_update_dl_v1: "pneuma_update_dl_v1",
};

/** 旧键名映射到新键名；不是旧键原样返回。 */
export function renameLegacyStorageKey(key: string): string {
    return LEGACY_LOCAL_STORAGE_KEYS[key] ?? key;
}

/**
 * 把旧键搬到新键名。新键已有值时以新值为准，只删旧键。
 * 写新键失败（配额满等）时保留旧键，下次启动再试，不丢数据。
 */
export function migrateLegacyLocalStorageKeys(): void {
    if (typeof window === "undefined") return;
    for (const [oldKey, newKey] of Object.entries(LEGACY_LOCAL_STORAGE_KEYS)) {
        try {
            const value = window.localStorage.getItem(oldKey);
            if (value === null) continue;
            if (window.localStorage.getItem(newKey) === null) window.localStorage.setItem(newKey, value);
            window.localStorage.removeItem(oldKey);
        } catch (error) {
            console.warn(`[legacy-brand-migration] failed to migrate ${oldKey}:`, error);
        }
    }
}
