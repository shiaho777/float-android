// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import { trackWrite } from "./pending-writes";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // ── 防误清防线 ──────────────────────────────────────────
        // 迁移标记在易失的 localStorage，真实数据在更持久的 IndexedDB。标记可能
        // 单独消失（清「缓存」、隐私工具、配额逐出）。这里任何一步出错（包括
        // localStorage 配额满导致 setItem 抛错）都绝不允许落入下方「全新安装」的
        // 迁移分支——那个分支会把空的 localStorage 当成真数据返回并删掉旧键，
        // 水合后的第一次全量保存（dbReplaceSessions = clear + put）就会把
        // IndexedDB 里的真实会话/联系人整表清掉，也就是「小手机全部变成初始
        // 状态」的事故。
        let indexedDbHasData = false;
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            indexedDbHasData = existingCount > 0;
        } catch (err) {
            // 探测失败（被占用/配额/瞬时错误）≠ 空库：改走带重试的 IndexedDB
            // 直读；仍失败就抛错保持「未水合」状态——所有写路径会自动退化为
            // 只增不改（见 chat-storage.ts），宁可见空也不能用空数据覆盖真库。
            console.warn("[ChatDB] Pre-migration IndexedDB check failed; recovering directly:", err);
            const recovered = await loadFromIndexedDbWithRetries();
            if (recovered) {
                markMigrated();
                return recovered;
            }
            throw new Error(`[ChatDB] 无法读取本地聊天数据库（${
                err instanceof Error ? err.message : String(err)
            }），已保持未水合状态以避免覆盖真实数据`, { cause: err });
        }

        if (indexedDbHasData) {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            // 标记写失败（localStorage 配额满）只是性能问题，绝不能连带
            // 丢弃已读出的 IndexedDB 数据。
            markMigrated();
            console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return { messages: fallbackMessages, sessions: fallbackSessions, contacts: fallbackContacts };
        }
    }

    // Already migrated: load from IndexedDB (with retries)
    const loaded = await loadFromIndexedDbWithRetries();
    if (!loaded) {
        throw new Error("[ChatDB] Failed to load after 3 attempts");
    }
    return loaded;
}

/** 写迁移标记；失败（如 localStorage 配额满）只是性能问题，不应升级成数据事故。 */
function markMigrated(): void {
    try {
        window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
    } catch (err) {
        console.warn("[ChatDB] Failed to persist migration flag:", err);
    }
}

/** 从 IndexedDB 读取全部数据，失败重试最多 3 次；全部失败返回 null（由调用方决定是否抛错）。 */
async function loadFromIndexedDbWithRetries(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
} | null> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    return null;
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    trackWrite(chatDb.messages.put(msg)).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    trackWrite(chatDb.messages.bulkPut(msgs)).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

// 可等待、错误上抛、分块提交的批量写入。导入聊天记录这类大批量落库必须
// 感知真实结果（配额满/写入失败要能反馈给用户），且分块避免巨型单事务
// 卡死主线程；每块之间自然让出事件循环，页面保持可响应。
const DB_BULK_PUT_CHUNK = 2000;
export async function dbBulkPutMessages(msgs: ChatMessage[]): Promise<void> {
    if (msgs.length === 0) return;
    for (let start = 0; start < msgs.length; start += DB_BULK_PUT_CHUNK) {
        await chatDb.messages.bulkPut(msgs.slice(start, start + DB_BULK_PUT_CHUNK));
    }
}

export function dbDeleteMessage(id: string): void {
    trackWrite(chatDb.messages.delete(id)).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    trackWrite(chatDb.messages.where("sessionId").equals(sessionId).delete())
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    trackWrite(chatDb.messages.bulkDelete(ids)).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    trackWrite(chatDb.sessions.put(session)).catch(err => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
    trackWrite(chatDb.sessions.bulkPut(sessions)).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
    trackWrite(chatDb.transaction("rw", chatDb.sessions, async () => {
        await chatDb.sessions.clear();
        await chatDb.sessions.bulkPut(sessions);
    })).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
}

export function dbDeleteSession(id: string): void {
    trackWrite(chatDb.sessions.delete(id)).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    trackWrite(chatDb.contacts.bulkPut(contacts)).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    trackWrite(chatDb.contacts.clear()).catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    trackWrite(chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    })).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}
