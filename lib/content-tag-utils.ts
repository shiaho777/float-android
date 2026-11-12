import type { Prompt } from "./settings-types";
import { CONTENT_APP_LABELS } from "./settings-types";
import {
    CHECKPHONE_TAG_PROFILES,
    getCheckPhonePromptSecondaryTagLabel,
} from "./checkphone-config";

const EXTRA_TAG_LABELS: Record<string, string> = {
    add_friend: "加好友",
    offline: "线下",
    followup: "追发",
    timed_wake: "稍后主动联系",
    period_care: "经期关心",
    text: "文字",
    voice: "语音",
    video: "视频",
    post: "发帖",
    generate: "生成",
    comment: "评论",
    reply: "回复",
    npc: "NPC互动",
    npc_reply: "NPC回复",
    layout: "布局",
    full: "完整",
    items: "物品",
    entries: "日记生成",
    explore: "探索",
    annotate: "标注",
    discuss: "讨论",
    activity: "角色浏览互动",
    reaction: "用户笔记反应",
    mention: "@提及回复",
    manifest: "清单",
    notes: "笔记",
    notewall: "便签墙",
    notewall_reply: "便签墙回复",
    cocreate: "共创",
    action: "动作",
    tool: "工具",
    archive: "结束章节",
    write: "正文创作",
};

export type TagProfile = {
    id: string;
    label: string;
    tags: string[];
};

export type TagMinorProfile = TagProfile;

export type TagGroupProfile = {
    id: string;
    label: string;
    tags: string[];
    minors: TagMinorProfile[];
};

const commonMinor = (majorId: string, tags: string[]): TagMinorProfile => ({
    id: `${majorId}_common`,
    label: "通用",
    tags,
});

const profile = (majorId: string, minorId: string, minorLabel: string, tags: string[]): TagMinorProfile => ({
    id: `${majorId}_${minorId}`,
    label: minorLabel,
    tags,
});

export const CONTENT_SCOPE_TAG_GROUPS: TagGroupProfile[] = [
    {
        id: "universal",
        label: "通用",
        tags: [],
        minors: [{ id: "universal_common", label: "通用", tags: [] }],
    },
    {
        id: "chat",
        label: "聊天",
        tags: ["chat"],
        minors: [
            commonMinor("chat", ["chat"]),
            profile("chat", "text", "文字", ["chat", "text"]),
            profile("chat", "voice", "语音", ["chat", "voice"]),
            profile("chat", "video", "视频", ["chat", "video"]),
            profile("chat", "offline", "线下", ["chat", "offline"]),
            profile("chat", "followup", "追发", ["chat", "followup"]),
            profile("chat", "timed_wake", "稍后主动联系", ["chat", "timed_wake"]),
            profile("chat", "period_care", "经期关心", ["chat", "period_care"]),
        ],
    },
    {
        id: "moments",
        label: "朋友圈",
        tags: ["moments"],
        minors: [
            commonMinor("moments", ["moments"]),
            profile("moments", "post", "发帖", ["moments", "post"]),
            profile("moments", "comment", "评论", ["moments", "comment"]),
            profile("moments", "reply", "回复", ["moments", "reply"]),
            profile("moments", "npc", "NPC互动", ["moments", "npc"]),
            profile("moments", "npc_reply", "NPC回复", ["moments", "npc_reply"]),
        ],
    },
    {
        id: "group_chat",
        label: "群聊",
        tags: ["group_chat"],
        minors: [
            commonMinor("group_chat", ["group_chat"]),
            profile("group_chat", "text", "文字", ["group_chat", "text"]),
            profile("group_chat", "offline", "线下", ["group_chat", "offline"]),
        ],
    },
    {
        id: "diary",
        label: "手记",
        tags: ["diary"],
        minors: [
            commonMinor("diary", ["diary"]),
            profile("diary", "entries", "日记生成", ["diary", "entries"]),
            profile("diary", "notewall", "便签墙生成", ["diary", "notewall"]),
            profile("diary", "notewall_reply", "便签墙回复", ["diary", "notewall_reply"]),
        ],
    },
    {
        id: "xiaohongshu",
        label: "小红书",
        tags: ["xiaohongshu"],
        minors: [
            commonMinor("xiaohongshu", ["xiaohongshu"]),
            profile("xiaohongshu", "activity", "角色浏览互动", ["xiaohongshu", "activity"]),
            profile("xiaohongshu", "reaction", "用户笔记反应", ["xiaohongshu", "reaction"]),
            profile("xiaohongshu", "comment", "评论回复", ["xiaohongshu", "comment"]),
            profile("xiaohongshu", "mention", "@提及回复", ["xiaohongshu", "mention"]),
        ],
    },
    { id: "story", label: "剧情", tags: ["story"], minors: [commonMinor("story", ["story"])] },
    { id: "vn", label: "漫卷", tags: ["vn"], minors: [commonMinor("vn", ["vn"])] },
    { id: "calendar", label: "日历", tags: ["calendar"], minors: [commonMinor("calendar", ["calendar"])] },
    { id: "game", label: "游戏", tags: ["game"], minors: [commonMinor("game", ["game"])] },
    { id: "add_friend", label: "加好友", tags: ["add_friend"], minors: [commonMinor("add_friend", ["add_friend"])] },
    {
        id: "checkphone",
        label: "查手机",
        tags: ["checkphone"],
        minors: CHECKPHONE_TAG_PROFILES.map((item) => ({
            id: item.id,
            label: item.tags.length > 1 ? resolveContentTagLabel(item.tags[1]) : "通用",
            tags: item.tags,
        })),
    },
    {
        id: "reading",
        label: "阅读",
        tags: ["reading"],
        minors: [
            commonMinor("reading", ["reading"]),
            profile("reading", "annotate", "标注", ["reading", "annotate"]),
            profile("reading", "discuss", "讨论", ["reading", "discuss"]),
        ],
    },
    {
        id: "cocreate",
        label: "共创",
        tags: ["cocreate"],
        minors: [
            commonMinor("cocreate", ["cocreate"]),
            profile("cocreate", "write", "正文创作", ["cocreate", "write"]),
            profile("cocreate", "discuss", "讨论", ["cocreate", "discuss"]),
            profile("cocreate", "action", "可执行动作", ["cocreate", "action"]),
        ],
    },
];

export const CONTENT_SCOPE_TAG_PROFILES: TagProfile[] = [
    ...CONTENT_SCOPE_TAG_GROUPS.flatMap((group) => group.minors.map((minor) => ({
        id: minor.id,
        label: minor.tags.length === 0 ? "通用（所有功能）" : `${group.label}${minor.tags.length > 1 ? ` · ${minor.label}` : ""}`,
        tags: minor.tags,
    }))),
];

const LEGACY_TAG_MIGRATIONS = new Map<string, string[]>([
    [JSON.stringify(["chat", "chat-text"]), ["chat", "text"]],
    [JSON.stringify(["chat", "chat-voice"]), ["chat", "voice"]],
    [JSON.stringify(["chat", "chat-video"]), ["chat", "video"]],
    [JSON.stringify(["moments_npc"]), ["moments", "npc"]],
    [JSON.stringify(["朋友圈", "NPC回复"]), ["moments", "npc_reply"]],
    [JSON.stringify(["diary", "entries_generate"]), ["diary", "entries"]],
    [JSON.stringify(["diary", "notewall_generate"]), ["diary", "notewall"]],
    [JSON.stringify(["xiaohongshu", "character_activity"]), ["xiaohongshu", "activity"]],
    [JSON.stringify(["xiaohongshu", "user_post_reaction"]), ["xiaohongshu", "reaction"]],
    [JSON.stringify(["xiaohongshu", "comment_reply"]), ["xiaohongshu", "comment"]],
    [JSON.stringify(["xiaohongshu", "mention_reply"]), ["xiaohongshu", "mention"]],
]);

export function normalizePromptScopeTags(tags: unknown): string[] | undefined {
    const normalized = normalizeTags(tags);
    if (!normalized) return undefined;
    const migrated = LEGACY_TAG_MIGRATIONS.get(JSON.stringify(normalized));
    return migrated ? [...migrated] : normalized;
}

export function normalizeTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const normalized = Array.from(
        new Set(
            tags
                .map((tag) => String(tag).trim())
                .filter(Boolean),
        ),
    );
    return normalized.length > 0 ? normalized : undefined;
}

export function areTagsEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export function resolveContentTagLabel(tag: string): string {
    return EXTRA_TAG_LABELS[tag]
        ?? getCheckPhonePromptSecondaryTagLabel(tag)
        ?? CONTENT_APP_LABELS[tag as keyof typeof CONTENT_APP_LABELS]
        ?? tag;
}

export function getPromptTags(prompt: Pick<Prompt, "tags" | "featureTag" | "followUpOnly">): string[] {
    const normalizedTags = normalizePromptScopeTags(prompt.tags);
    if (normalizedTags) return normalizedTags;
    const tags: string[] = [];
    if (prompt.featureTag) tags.push(prompt.featureTag);
    if (prompt.followUpOnly) tags.push("followup");
    return tags;
}

export function getTagProfileId(tags: string[], profiles: TagProfile[] = CONTENT_SCOPE_TAG_PROFILES): string {
    const matched = profiles.find((profile) => areTagsEqual(profile.tags, tags));
    return matched?.id ?? "__custom__";
}

export function getTagsLabel(tags: string[], profiles: TagProfile[] = CONTENT_SCOPE_TAG_PROFILES): string {
    if (tags.length === 0) return "通用";
    const matched = profiles.find((profile) => areTagsEqual(profile.tags, tags));
    if (matched) return matched.label;
    return tags.map((tag) => resolveContentTagLabel(tag)).join(" · ");
}

export function matchesActiveTags(requiredTags: string[] | null | undefined, activeTags: string[]): boolean {
    if (!requiredTags || requiredTags.length === 0) return true;
    return requiredTags.every((tag) => activeTags.includes(tag));
}

export function filterTagScopedItems<T extends { tags?: string[] }>(items: T[], activeTags: string[]): T[] {
    return items.filter((item) => matchesActiveTags(item.tags, activeTags));
}

export function getActiveAppTags(
    appId: string,
    options?: { appTags?: string[]; followUpCount?: number },
): string[] {
    if (options?.appTags) return [...options.appTags];
    return [appId, ...((options?.followUpCount ?? 0) > 0 ? ["followup"] : [])];
}
