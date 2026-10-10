// lib/memory-storage.ts
// IndexedDB persistence for long-term memory entries + short-term events + localStorage config.

import type { MemoryEntry, MemoryConfig, MemorySurfacedRecord } from "./memory-types";
import { DEFAULT_MEMORY_BUDGET, DEFAULT_MEMORY_CONFIG, LEGACY_UNBOUNDED_MEMORY_BUDGET, MEMORY_BUDGET_SCHEMA_VERSION } from "./memory-types";
import { kvGet, kvSet, kvRemove, registerKvMigration, registerDynamicPrefix } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

// ── Long-term memory DB (unchanged from v1) ──

const DB_NAME = "ai_phone_memory_db_v1";
const DB_VERSION = 3;
const STORE_NAME = "memories";

const CONFIG_KEY = "ai_phone_memory_config_v1";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function ensureMemoryIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_character_type")) {
        store.createIndex("by_character_type", ["characterId", "type"], { unique: false });
    }
    if (!store.indexNames.contains("by_character_created")) {
        store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
    }
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    // Open at >= DB_VERSION: a backup restore may have bumped the stored version
    // higher, and opening at a fixed lower version would throw a VersionError.
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        } else {
            store = tx!.objectStore(STORE_NAME);
        }
        ensureMemoryIndexes(store);
    }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ── Long-term Entry CRUD ──

export async function saveMemoryEntry(entry: MemoryEntry): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

// ── 注入记账（kv 小记录，按条目 id）──
//
// 为什么不写进记忆记录本身：那要整条 put（把 embedding 大字段重新序列化一遍），
// 而且用的是召回时的旧快照——并发编辑会被旧内容覆盖，期间被删掉的条目会被复活。
// 放 kv 里每次只写两个数；删条目留下的孤儿记录无害（没有对应条目就不会被读到）。

const SURFACED_PREFIX = "ai_phone_mem_surfaced_";

function readSurfacedRecord(entryId: string): MemorySurfacedRecord | null {
    const raw = kvGet(SURFACED_PREFIX + entryId);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as { count?: unknown; at?: unknown };
        const count = typeof parsed?.count === "number" && Number.isFinite(parsed.count) && parsed.count > 0
            ? Math.floor(parsed.count)
            : 0;
        return { count, at: typeof parsed?.at === "string" ? parsed.at : "" };
    } catch {
        return null; // 单条坏数据不影响召回
    }
}

/** 读取一批条目的注入记账（缺省 = 从未提起）。 */
export function loadMemorySurfacedRecords(entryIds: string[]): Map<string, MemorySurfacedRecord> {
    const records = new Map<string, MemorySurfacedRecord>();
    if (typeof window === "undefined") return records;
    for (const id of entryIds) {
        const record = readSurfacedRecord(id);
        if (record) records.set(id, record);
    }
    return records;
}

/**
 * 记账：本轮真正进了提示词的记忆。
 * 同步写 kv 内存缓存 + fire-and-forget 落盘（kv-db 内部已挂 pending-writes，
 * 页面隐藏/被杀前会被排空），绝不阻塞生成。
 */
export function markMemorySurfaced(entryIds: string[], surfacedAt: string): void {
    if (typeof window === "undefined") return;
    for (const entryId of entryIds) {
        if (!entryId) continue;
        const previous = readSurfacedRecord(entryId);
        kvSet(SURFACED_PREFIX + entryId, JSON.stringify({
            count: (previous?.count ?? 0) + 1,
            at: surfacedAt,
        }));
    }
}

/**
 * 清除一批条目的注入记账。条目被作废/归档/改写后，旧的记账不再有意义——
 * 留着它只会让"新鲜度"这一维继续参考一条已经不作数的历史。
 */
export function clearMemorySurfacedRecords(entryIds: string[]): void {
    if (typeof window === "undefined") return;
    for (const entryId of entryIds) {
        if (entryId) kvRemove(SURFACED_PREFIX + entryId);
    }
}

export async function loadMemoryEntries(characterId: string): Promise<MemoryEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let entries: MemoryEntry[];
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const idx = store.index("by_character");
            entries = await runRequest(idx.getAll(characterId));
        } catch {
            const tx = db.transaction(STORE_NAME, "readonly");
            const allEntries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
            entries = allEntries.filter(entry => entry.characterId === characterId);
        }
        entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return entries;
    } finally {
        db.close();
    }
}

export async function loadMemoryEntriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntries(characterId);
    return entries.filter(entry => entry.type === type);
}

export async function deleteMemoryEntry(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteMemoryEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) {
            store.delete(id);
        }
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteCharacterMemories(characterId: string): Promise<void> {
    const entries = await loadMemoryEntries(characterId);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function deleteCharacterMemoriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<void> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function getAllCharacterIdsWithMemories(): Promise<string[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const entries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
        const ids = new Set<string>();
        for (const e of entries) ids.add(e.characterId);
        return Array.from(ids);
    } finally {
        db.close();
    }
}

export async function getMemoryCount(characterId: string): Promise<number> {
    const entries = await loadMemoryEntries(characterId);
    return entries.length;
}

export async function getMemoryCountByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<number> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    return entries.length;
}

// ── Config (localStorage for fast sync access) ──

export function loadMemoryConfig(): MemoryConfig {
    if (typeof window === "undefined") return { ...DEFAULT_MEMORY_CONFIG };
    try {
        const raw = kvGet(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_MEMORY_CONFIG };
        const merged: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...JSON.parse(raw) };
        if (migrateMemoryBudgetSchema(merged)) saveMemoryConfig(merged);
        return merged;
    } catch {
        return { ...DEFAULT_MEMORY_CONFIG };
    }
}

/**
 * 注入预算的版本迁移：把"不限量"时代的默认预算（100000）收敛到能被讲完的量级。
 *
 * 判断依据是**配置自己带的版本号**，不是"这台设备上迁移过一次"的全局标记——
 * 全局标记会让"还原旧备份回来"这条路再也修不回来（备份里的配置又是 100000，
 * 标记还在，迁移永不重跑，等于把缺陷原样恢复）。
 *
 * 应用写过的配置一律带当前版本号（见 saveMemoryConfig），所以用户手调的 100000
 * 不会被误改成默认值。
 */
function migrateMemoryBudgetSchema(config: MemoryConfig): boolean {
    if (config.budgetSchemaVersion === MEMORY_BUDGET_SCHEMA_VERSION) return false;
    const budgetKeys = ["shortTermTokenBudget", "coreMemoryTokenBudget", "longTermTokenBudget"] as const;
    for (const key of budgetKeys) {
        if (config[key] === LEGACY_UNBOUNDED_MEMORY_BUDGET) {
            config[key] = DEFAULT_MEMORY_BUDGET[key];
        }
    }
    // 版本号一定要打上：默认值本身已是新值，也要落一次版本，否则每次读取都会重走一遍
    config.budgetSchemaVersion = MEMORY_BUDGET_SCHEMA_VERSION;
    return true;
}

export function saveMemoryConfig(config: MemoryConfig): void {
    if (typeof window === "undefined") return;
    // 写上当前版本号：凡应用保存过的配置都不再被迁移——用户把预算调到 100000
    // 也永久保留；只有"旧版本写的、或从旧备份还原回来的"配置才会被迁移一次。
    kvSet(CONFIG_KEY, JSON.stringify({ ...config, budgetSchemaVersion: MEMORY_BUDGET_SCHEMA_VERSION }));
}

// ── Per-character event counter (localStorage) ──

const EVENT_COUNTER_PREFIX = "ai_phone_mem_evt_count_";
const LAST_SUMMARY_TS_PREFIX = "ai_phone_mem_last_sum_";
const CORE_COUNTER_PREFIX = "ai_phone_mem_core_count_";
const LAST_CORE_SUMMARY_TS_PREFIX = "ai_phone_mem_last_core_sum_";
const LAST_CONSOLIDATION_TS_PREFIX = "ai_phone_mem_last_consol_";
registerKvMigration(CONFIG_KEY);
registerDynamicPrefix(SURFACED_PREFIX);
registerDynamicPrefix(EVENT_COUNTER_PREFIX);
registerDynamicPrefix(LAST_SUMMARY_TS_PREFIX);
registerDynamicPrefix(CORE_COUNTER_PREFIX);
registerDynamicPrefix(LAST_CORE_SUMMARY_TS_PREFIX);
registerDynamicPrefix(LAST_CONSOLIDATION_TS_PREFIX);

export function getEventCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(EVENT_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementEventCounter(characterId: string): number {
    const next = getEventCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(EVENT_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetEventCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(EVENT_COUNTER_PREFIX + characterId, "0");
}

export function getLastSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_SUMMARY_TS_PREFIX + characterId, ts);
}

export function getCoreMemoryCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(CORE_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementCoreMemoryCounter(characterId: string): number {
    const next = getCoreMemoryCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(CORE_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetCoreMemoryCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(CORE_COUNTER_PREFIX + characterId, "0");
}

export function getLastCoreSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_CORE_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastCoreSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_CORE_SUMMARY_TS_PREFIX + characterId, ts);
}

export function getLastConsolidatedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_CONSOLIDATION_TS_PREFIX + characterId) || null;
}

export function setLastConsolidatedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_CONSOLIDATION_TS_PREFIX + characterId, ts);
}
