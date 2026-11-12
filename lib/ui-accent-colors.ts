import type { ContentAppId } from "@/lib/settings-types";

export const BINDING_ACCENTS = {
    api: "#2F80ED",
    voice: "#7C3AED",
    preset: "#D83F87",
    worldBook: "#2F80ED",
    regex: "#F37A12",
    identity: "#2FA52F",
    memory: "#5B4DDB",
    embedding: "#18A957",
} as const;

export const CONTENT_APP_ACCENTS: Record<ContentAppId, string> = {
    chat: "#22A85A",
    diary: "#2F80ED",
    music: "#8B5CF6",
    reading: "#2563EB",
    forum: "#F97316",
    cocreate: "#C8B58A",
    story: "#EC4899",
    game: "#3B82F6",
    xiaohongshu: "#E11D48",
    checkphone: "#6366F1",
    shopping: "#F59E0B",
    calendar: "#E8554A",
    moments: "#06B6D4",
    group_chat: "#22C55E",
    vn: "#7C3AED",
};
