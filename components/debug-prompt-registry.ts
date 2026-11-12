export type ExtraPromptAppId =
    | "checkphone"
    | "reading"
    | "diary"
    | "xiaohongshu"
    | "cocreate"
    | "shopping"
;

export type ExtraPromptAppDefinition = {
    id: ExtraPromptAppId;
    label: string;
    emptyText: string;
};

export const EXTRA_PROMPT_APPS: ExtraPromptAppDefinition[] = [
    { id: "checkphone", label: "查手机", emptyText: "选择角色与查手机 APP 后点击「预览」" },
    { id: "reading", label: "阅读", emptyText: "选择角色、书籍、章节和任务后点击「预览」" },
    { id: "diary", label: "日记", emptyText: "选择角色后点击「预览」查看日记 Prompt" },
    { id: "xiaohongshu", label: "小红书", emptyText: "选择角色与小红书任务后点击「预览」" },
    { id: "cocreate", label: "共创", emptyText: "选择共创模式后点击「预览」" },
    { id: "shopping", label: "购物", emptyText: "选择购物任务后点击「预览」" },
];

export const EXTRA_PROMPT_APP_LABELS = Object.fromEntries(
    EXTRA_PROMPT_APPS.map((item) => [item.id, item.label]),
) as Record<ExtraPromptAppId, string>;
