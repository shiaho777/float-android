// lib/memory-migrations.ts
// 记忆条目的一次性 schema 迁移（幂等、可重复执行）。
//
// v1「证据层迁移」：给批次二之前写入的条目补上显式状态与传播范围
//   status: "unverified"  —— 旧版未核验：**没有证据编号**。不伪造、不猜测，
//                             内容本身仍然成立，因此照常参与召回（见 isRecallableEntry），
//                             只是被明确标出来，方便日后逐条核。
//   scope:  ["private"]   —— 没有来源记录，无法证明它是在群里公开说过的。
//                             "没记录"不能当成"可以随便传"，因此按最严处理。
//   revision: 1
//
// 迁移原则：
//   - 只加标记，**不删除、不改写正文**；任何一条都能用"恢复为有效"回到原样。
//   - 幂等：已有 status 的条目原样跳过；版本号只在整轮成功后写入，
//     中途失败下一次启动会重来。
//   - 不需要"迁移前先备份"才安全：迁移不破坏数据，且备份还原回来的旧条目
//     会在下一次启动被同样标记（幂等键在配置/条目里，不是一次性的全局开关）。

import { getAllCharacterIdsWithMemories, loadMemoryEntries, saveMemoryEntry } from "./memory-storage";
import { logMemoryTask, memorySwitchSnapshot } from "./memory-recall-log";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const MIGRATION_KEY = "ai_phone_mem_schema_migr";
const MIGRATION_VERSION = 1;

registerKvMigration(MIGRATION_KEY);

export function getMemorySchemaMigrationVersion(): number {
    const raw = kvGet(MIGRATION_KEY);
    return raw ? parseInt(raw, 10) || 0 : 0;
}

export type MemoryMigrationResult = {
    /** 这一轮是否真的跑了（版本已经是最新则为 false） */
    ran: boolean;
    /** 被标记的条目数 */
    migrated: number;
    /** 扫描到的条目总数 */
    scanned: number;
};

/**
 * 幂等地把旧条目升级到当前 schema。App 启动时调用一次（fire-and-forget），
 * 不要放进聊天热路径。
 */
export async function ensureMemorySchemaMigrated(): Promise<MemoryMigrationResult> {
    if (typeof window === "undefined") return { ran: false, migrated: 0, scanned: 0 };
    if (getMemorySchemaMigrationVersion() >= MIGRATION_VERSION) {
        return { ran: false, migrated: 0, scanned: 0 };
    }

    let migrated = 0;
    let scanned = 0;
    try {
        const now = new Date().toISOString();
        const characterIds = await getAllCharacterIdsWithMemories();
        for (const characterId of characterIds) {
            const entries = await loadMemoryEntries(characterId);
            for (const entry of entries) {
                scanned++;
                if (entry.metadata?.status) continue; // 已经迁移过
                await saveMemoryEntry({
                    ...entry,
                    metadata: {
                        ...entry.metadata,
                        status: "unverified",
                        scope: ["private"],
                        revision: typeof entry.metadata?.revision === "number" ? entry.metadata.revision : 1,
                        migratedAt: now,
                        migrationNote: "v1: pre-evidence entry marked unverified; no evidence id invented",
                    },
                });
                migrated++;
            }
        }
        kvSet(MIGRATION_KEY, String(MIGRATION_VERSION));
        logMemoryTask({
            task: "memory-schema-migration",
            switches: memorySwitchSnapshot(),
            action: "merge",
            outcome: `扫描 ${scanned} 条，标记 ${migrated} 条旧条目为「旧版未核验」（未伪造证据编号）`,
        });
    } catch (error) {
        // 不写版本号：下一次启动重来。迁移失败不影响正常使用。
        console.warn("[MemoryMigration] failed:", error);
    }
    return { ran: true, migrated, scanned };
}
