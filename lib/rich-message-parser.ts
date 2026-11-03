/**
 * Shared rich-media message parser.
 *
 * Parse order:
 *   1. parseStateValues() → extract [好感度:72] etc.
 *   2. Extract [状态栏]...[/状态栏] display-only status panel
 *   3. Extract [内心]...[/内心] inner monologue
 *   4. split(/\n\n+/) → split by double newlines
 *   5. Parse each segment for rich-media markers (direct matching, no placeholders)
 */

import type { ChatMessage } from "./chat-storage";
import type { StateValue } from "./chat-storage";
import { parseStateValues, mergeStateValues } from "./state-value-parser";
import { stripActionShells } from "./action-parser";
import { stripTextToolDirectives } from "./text-tool-protocol";
import {
    formatCustomAppDirectiveSummary,
    getCustomAppDirectiveSyntaxHead,
    loadCustomAppChatDirectives,
    splitCustomAppDirectiveArgs,
    type RegisteredCustomAppChatDirective,
} from "./custom-app-chat-directives";

// ── Types ──────────────────────────────────────────────

export interface ParsedMessagePart {
    content: string;
    mediaType?: ChatMessage["mediaType"];
    mediaData?: ChatMessage["mediaData"];
}

export interface ParsedAIResponse {
    parts: ParsedMessagePart[];
    /** 与历史合并后的完整状态快照（用于状态链传递与下一轮提示词） */
    stateValues: StateValue[];
    /** 本轮回复实际输出的状态值（未合并历史；漏输出时为空，内心卡片按此渲染） */
    freshStateValues: StateValue[];
    statusPanel: string;
    innerMonologue: string;
}

// ── Rich-media patterns (non-global, for single match with index) ──

// 零宽空格/BOM 等不可见字符不属于 \s，trim() 删不掉；模型输出在媒体标记后夹带
// 这类字符时，会被切成一个"非空但渲染不可见"的段落，最终显示成一个空气泡。
// 不能直接从内容里删除这些字符——U+200D 是组合 emoji 的连接符，U+200C 在部分
// 文字里有语义——所以只在"判空"时把它们视同空白。
const INVISIBLE_OR_WHITESPACE_ONLY_RE = new RegExp(
    // eslint-disable-next-line no-misleading-character-class -- U+034F 在这里是要单独匹配的不可见字符，不是用来组合前一个字符的
    "^[\\s\\u00AD\\u034F\\u180E\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]*$",
);

/** 内容是否没有任何可见字符（空串、空白、零宽字符/BOM 等的任意组合） */
export function isInvisibleOrWhitespaceOnly(text: string): boolean {
    return INVISIBLE_OR_WHITESPACE_ONLY_RE.test(text);
}

const C = "\\s*[：:]\\s*"; // half-width or full-width colon, allowing surrounding spaces

// ── 协议标记归一化 ──────────────────────────────
// 双语输出契约是"外语原文|中文翻译"——模型容易把协议标签本身也"翻译"掉：
// [語音条:…]（日文汉字）、[音声:…]、[voice:…]、[内心独白]…、漏右括号、甚至倒退
// 输出旧版 {"voice_message": "…"} JSON。这类错法在提示词侧堵不完，这里统一把
// 近规范形态归一成规范标记再走严格解析：标签别名覆盖中/日/英常见变体，
// 全角【】→半角[]、参数内全角｜→|，未闭合的 [内心]/[状态栏] 在下一个空行处自愈。
const PROTOCOL_LABEL_ALIASES: Record<string, string> = {
    "语音条": "语音条", "語音条": "语音条", "語音條": "语音条", "音声条": "语音条",
    "语音消息": "语音条", "语音信息": "语音条", "语音": "语音条", "声音": "语音条",
    "音声": "语音条", "音声メッセージ": "语音条", "ボイス": "语音条", "ボイスメッセージ": "语音条",
    "voice": "语音条", "voice_message": "语音条", "voice message": "语音条",
    "voicemessage": "语音条", "voice_msg": "语音条", "voice note": "语音条", "audio": "语音条",
    "内心": "内心", "內心": "内心", "内心独白": "内心", "心声": "内心", "心理": "内心",
    "独白": "内心", "心里话": "内心", "inner": "内心", "inner_monologue": "内心",
    "inner monologue": "内心", "monologue": "内心", "thought": "内心", "thoughts": "内心", "inner voice": "内心",
    "状态栏": "状态栏", "狀態欄": "状态栏", "状态": "状态栏", "狀態": "状态栏",
    "status": "状态栏", "statusbar": "状态栏", "status_bar": "状态栏", "status bar": "状态栏",
    "照片": "照片", "相片": "照片", "图片": "照片", "圖片": "照片", "写真": "照片",
    "photo": "照片", "image": "照片", "picture": "照片", "pic": "照片", "img": "照片",
    "表情包": "表情包", "表情": "表情包", "贴纸": "表情包", "貼紙": "表情包",
    "sticker": "表情包", "stamp": "表情包", "スタンプ": "表情包",
    "位置": "位置", "地点": "位置", "地點": "位置", "场所": "位置", "場所": "位置", "location": "位置",
    "红包": "红包", "紅包": "红包", "red_packet": "红包", "redpacket": "红包",
    "red packet": "红包", "red_envelope": "红包", "red envelope": "红包",
    "转账": "转账", "轉賬": "转账", "转帐": "转账", "transfer": "转账",
    "礼物": "礼物", "禮物": "礼物", "gift": "礼物", "プレゼント": "礼物",
    "名片": "名片", "联系人": "名片", "連絡人": "名片", "联络人": "名片",
    "contact": "名片", "contact_card": "名片", "contact card": "名片",
    "引用": "引用", "quote": "引用", "reply": "引用",
    "音乐": "音乐", "音樂": "音乐", "music": "音乐", "song": "音乐",
    "音乐分享": "音乐分享", "代付请求": "代付请求", "代付": "代付请求",
    "payment_request": "代付请求", "payment request": "代付请求",
    "线下见面邀请": "线下见面邀请", "邀请线下见面": "邀请线下见面", "邀请见面": "邀请见面",
    "见面邀请": "线下见面邀请", "meetup": "线下见面邀请",
    "好友申请": "好友申请", "发送好友申请": "好友申请", "好友请求": "好友申请",
    "添加好友": "好友申请", "加好友": "好友申请", "重新添加": "好友申请",
    "friend_request": "好友申请", "friend request": "好友申请", "friendrequest": "好友申请",
    "好友验证": "好友申请", "friend_apply": "好友申请",
    // 撤回是无参数标记：[撤回]、[撤回上一条]、[recall] 都归一到规范名
    "撤回": "撤回", "撤回上一条": "撤回", "撤回消息": "撤回", "撤回刚才": "撤回",
    "recall": "撤回", "retract": "撤回", "undo": "撤回", "unsend": "撤回",
};

// [label:args] 或 【label:args】形态的整体 token；inner 不含括号与换行，保证
// 单 token 不跨行不嵌套（嵌套括号留给行尾兜底规则处理，见 RICH_PATTERNS 末位）。
const BRACKET_TOKEN_RE = /[\[【]([^\[\]【】\n]{1,500}?)[\]】]/g;

// 全部别名编成一次 alternation（长的在前，防 "语音消息" 被 "语音" 截胡）。
const PROTOCOL_LABEL_ALT = Object.keys(PROTOCOL_LABEL_ALIASES)
    .sort((a, b) => b.length - a.length)
    .map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
// 未闭合标记头：`[語音条:` 一路写到行尾没有右括号——整体 token 正则碰不到它，
// 但把标签头归一成规范名后，行尾兜底规则（RICH_PATTERNS 末位）就能接住。
const LOOSE_LABEL_HEAD_RE = new RegExp(`[\\[【]\\s*(${PROTOCOL_LABEL_ALT})\\s*(?=[：:])`, "gi");

/** 未闭合块自愈：找到没有配对的 [tag]，在下一个空行边界或文末补 [/tag]；
 *  同时删掉没有配对开启的孤立 [/tag]（否则闭合标签会漏成正文）。 */
function autoCloseBracketBlock(text: string, tag: string): string {
    let result = text;
    for (let guard = 0; guard < 8; guard++) {
        const openIdx = result.indexOf(`[${tag}]`);
        if (openIdx < 0) break;
        const afterOpen = openIdx + tag.length + 2;
        const closeIdx = result.indexOf(`[/${tag}]`, afterOpen);
        const nextOpen = result.indexOf(`[${tag}]`, afterOpen);
        // 已闭合（close 存在且早于下一个 open）→ 跳过这段继续检查后面的
        if (closeIdx >= 0 && (nextOpen === -1 || closeIdx < nextOpen)) {
            // 把已闭合段从检查范围切掉：在副本里继续查后半段
            const tail = result.slice(closeIdx + tag.length + 3);
            const tailFixed = autoCloseBracketBlock(tail, tag);
            if (tailFixed === tail) return result;
            result = result.slice(0, closeIdx + tag.length + 3) + tailFixed;
            continue;
        }
        // 未闭合：下一个空行边界优先，其次文末
        const rest = result.slice(afterOpen);
        const boundary = rest.indexOf("\n\n");
        const insertAt = boundary >= 0 ? afterOpen + boundary : result.length;
        result = result.slice(0, insertAt) + `[/${tag}]` + result.slice(insertAt);
    }
    // 孤立闭合标签清理：线性扫深度，[/tag] 在 depth=0 时丢弃
    const parts = result.split(new RegExp(`(\\[${tag}\\]|\\[\\/${tag}\\])`));
    let depth = 0;
    let cleaned = "";
    for (const p of parts) {
        if (p === `[${tag}]`) { depth++; cleaned += p; }
        else if (p === `[/${tag}]`) { if (depth > 0) { depth--; cleaned += p; } }
        else cleaned += p;
    }
    return cleaned;
}

export function normalizeProtocolMarkup(text: string): string {
    if (!text) return text;
    let out = text;

    // 旧存档/旧模型回退输出的 {"voice_message":"…"}（含数组包裹形态）→ 现行语音条标记
    out = out.replace(
        /\[?\s*\{[^{}]*"(?:voice_message|voiceMessage|voice_msg|audio_message|voice|audio)"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}\s*\]?/gi,
        (_whole, content: string) => {
            let decoded = content;
            try { decoded = JSON.parse(`"${content}"`); } catch { /* 保留原文 */ }
            return `\n\n[语音条:${decoded}]\n\n`;
        },
    );

    // 括号 token 归一化：全角括号→半角、标签别名→规范名、参数内全角｜→|
    out = out.replace(BRACKET_TOKEN_RE, (whole, inner: string) => {
        const m = inner.match(/^(\/?)\s*([^\[\]【】\n：:|/]{1,24}?)\s*([：:][\s\S]*)?$/);
        if (!m) return whole;
        const canonical = PROTOCOL_LABEL_ALIASES[m[2].toLowerCase()];
        if (!canonical) return whole;
        if (m[1] === "/") return `[/${canonical}]`;
        const args = (m[3] || "").replace(/｜/g, "|");
        return `[${canonical}${args}]`;
    });

    // 未闭合标记头归一化：让行尾兜底规则只需认规范标签名
    out = out.replace(LOOSE_LABEL_HEAD_RE, (_w, label: string) => `[${PROTOCOL_LABEL_ALIASES[label.toLowerCase()]}`);

    // 未闭合的结构块自愈（内心/状态栏配对标签被"吃掉"是最常见的泄漏源）
    out = autoCloseBracketBlock(out, "内心");
    out = autoCloseBracketBlock(out, "状态栏");
    return out;
}

/** 行尾兜底构建：已知标记头但缺右括号时的宽松解析，形状与各严格规则一致。 */
function buildLooseMarkerPart(label: string, args: string): ParsedMessagePart {
    const arg = args.trim();
    switch (label) {
        case "语音条":
            return { content: "", mediaType: "audio" as const, mediaData: { label: arg } };
        case "照片": {
            const head = arg.match(/^(使用参考图|不使用参考图)\s*[：:]\s*([\s\S]+)$/);
            return {
                content: "",
                mediaType: "image" as const,
                mediaData: { label: head ? head[2].trim() : arg, useReferenceImage: head?.[1] === "使用参考图" },
            };
        }
        case "表情包":
            return { content: "", mediaType: "sticker" as const, mediaData: { label: arg } };
        case "位置":
            return { content: "", mediaType: "location" as const, mediaData: { label: arg } };
        case "名片":
            return { content: "", mediaType: "contact_card" as const, mediaData: { contactCardName: arg, label: arg } };
        case "音乐分享":
            return { content: "", mediaType: "music_share" as const, mediaData: { musicTitle: arg, label: arg } };
        case "音乐": {
            const sep = arg.indexOf("-");
            return {
                content: "",
                mediaType: "music" as const,
                mediaData: {
                    musicTitle: sep > 0 ? arg.slice(0, sep).trim() : arg,
                    musicArtist: sep > 0 ? arg.slice(sep + 1).trim() : "",
                    label: arg,
                },
            };
        }
        case "红包": case "转账": {
            const m = arg.match(/^(\d+(?:\.\d+)?)\s*[：:]\s*([\s\S]*)$/);
            const isRed = label === "红包";
            return {
                content: "",
                mediaType: isRed ? ("red_packet" as const) : ("transfer" as const),
                mediaData: {
                    amount: m ? parseFloat(m[1]) : 0,
                    label: (m ? m[2].trim() : arg) || label,
                    status: "pending" as const,
                },
            };
        }
        case "礼物": {
            const m = arg.match(/^([^：:]+?)(?:\s*[：:]\s*(?:送给)?\s*(.+))?$/);
            const giftName = (m?.[1] || arg).trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName, label: giftName,
                    recipientName: m?.[2]?.trim() || "",
                    giftMerchantLabel: "角色赠礼", giftPriceLabel: "心意礼物",
                    giftSentAt: new Date().toISOString(),
                },
            };
        }
        case "好友申请":
            return { content: "", mediaType: "friend_request" as const, mediaData: { label: arg, friendRequestStatus: "pending" as const } };
        case "引用":
            return { content: "", mediaType: "quote" as const, mediaData: { quotePreview: arg } };
        case "代付请求": {
            const m = arg.match(/^(\d+(?:\.\d+)?)\s*[：:]\s*([\s\S]*)$/);
            return {
                content: "",
                mediaType: "payment_request" as const,
                mediaData: {
                    amount: m ? parseFloat(m[1]) : 0,
                    paymentRequestAmountLabel: m?.[1] || "",
                    paymentRequestItemsText: m ? m[2].trim() : arg,
                    label: "代付请求",
                    status: "pending" as const,
                    paymentRequestedAt: new Date().toISOString(),
                },
            };
        }
        default:
            return { content: `[${label}]` };
    }
}

function parseMuteMinutes(num?: string, unit?: string): number {
    const n = parseInt(num || "", 10);
    if (!Number.isFinite(n) || n <= 0) return 10;
    if (unit === "天") return n * 1440;
    if (unit === "小时") return n * 60;
    return n;
}

const RICH_PATTERNS: {
    regex: RegExp;
    build: (m: RegExpMatchArray) => ParsedMessagePart;
}[] = [
    {
        // 3段格式：[红包:金额:个数:留言]
        regex: new RegExp(`\\[红包${C}(\\d+(?:\\.\\d+)?)${C}(\\d+)${C}([^\\]]*)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "red_packet",
            mediaData: { amount: parseFloat(m[1]), count: parseInt(m[2], 10), label: m[3] || "恭喜发财", status: "pending" },
        }),
    },
    {
        // 2段格式（向后兼容）：[红包:金额:留言]
        regex: new RegExp(`\\[红包${C}(\\d+(?:\\.\\d+)?)${C}([^\\]]*)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "red_packet",
            mediaData: { amount: parseFloat(m[1]), count: 1, label: m[2] || "恭喜发财", status: "pending" },
        }),
    },
    {
        // 兼容两种格式：[转账:金额:留言] (1:1) 和 [转账:金额:留言:转账人:收款人] (群聊)
        regex: /\[转账[：:](\d+(?:\.\d+)?)[：:]([^\]：:]*?)(?:[：:]([^\]：:]*?)[：:]([^\]]*?))?\]/,
        build: (m) => ({
            content: "",
            mediaType: "transfer",
            mediaData: {
                amount: parseFloat(m[1]),
                label: m[2]?.trim() || "转账",
                status: "pending" as const,
                senderName: m[3]?.trim() || "",
                recipientName: m[4]?.trim() || "",
            },
        }),
    },
    {
        // [代付请求:总金额:商品名/详情/价格/数量; 商品名/详情/价格/数量]
        regex: /\[代付请求[：:](\d+(?:\.\d+)?)[：:]([^\]]+)\]/,
        build: (m) => ({
            content: "",
            mediaType: "payment_request" as const,
            mediaData: {
                amount: parseFloat(m[1]),
                paymentRequestAmountLabel: m[1],
                paymentRequestItemsText: m[2].trim(),
                label: "代付请求",
                status: "pending" as const,
                paymentRequestedAt: new Date().toISOString(),
            },
        }),
    },
    {
        // 群聊赠礼：[礼物:商品名:收礼人]，兼容旧格式：[礼物:商品名:送给收礼人]
        regex: new RegExp(`\\[礼物${C}([^\\]：:]+)${C}(?:送给)?([^\\]]+)\\]`),
        build: (m) => {
            const giftName = m[1].trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName,
                    label: giftName,
                    recipientName: m[2].trim(),
                    giftMerchantLabel: "角色赠礼",
                    giftPriceLabel: "心意礼物",
                    giftSentAt: new Date().toISOString(),
                },
            };
        },
    },
    {
        // 私聊赠礼：[礼物:商品名]
        regex: new RegExp(`\\[礼物${C}([^\\]]+)\\]`),
        build: (m) => {
            const giftName = m[1].trim();
            return {
                content: "",
                mediaType: "gift" as const,
                mediaData: {
                    giftName,
                    label: giftName,
                    giftMerchantLabel: "角色赠礼",
                    giftPriceLabel: "心意礼物",
                    giftSentAt: new Date().toISOString(),
                },
            };
        },
    },
    {
        // 推荐联系人名片：[名片:角色名]。名字在渲染时按推荐人同世界实时解析，
        // 查无此人也放行成卡——点击后可现场生成该角色档案（幻觉转建档）。
        regex: new RegExp(`\\[名片${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "contact_card" as const,
            mediaData: { contactCardName: m[1].trim(), label: m[1].trim() },
        }),
    },
    {
        regex: new RegExp(`\\[照片${C}(使用参考图|不使用参考图)${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "image",
            mediaData: { label: m[2].trim(), useReferenceImage: m[1] === "使用参考图" },
        }),
    },
    {
        regex: new RegExp(`\\[照片${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "image",
            mediaData: { label: m[1].trim(), useReferenceImage: false },
        }),
    },
    {
        regex: new RegExp(`\\[位置${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "location",
            mediaData: { label: m[1] },
        }),
    },
    {
        regex: /\[([^\]]+)拍了拍([^\]]+)\]/,
        build: (m) => ({
            content: "",
            mediaType: "poke" as const,
            mediaData: { pokeSender: m[1]?.trim() || "", pokeTarget: m[2]?.trim() || "" },
        }),
    },
    {
        regex: new RegExp(`\\[表情包${C}([^\\]]+)\\]`),
        build: (m) => {
            const name = m[1].trim();
            return {
                content: "",
                mediaType: "sticker" as const,
                mediaData: { label: name },
            };
        },
    },
    {
        regex: new RegExp(`\\[引用${C}([^\\]]+)\\](.+)`),
        build: (m) => ({
            content: m[2].trim(),
            mediaType: "quote" as const,
            mediaData: { quotePreview: m[1].trim() },
        }),
    },
    {
        // [音乐:歌名-歌手] or [音乐:歌名]
        regex: new RegExp(`\\[音乐${C}([^\\]]+)\\]`),
        build: (m) => {
            const raw = m[1].trim();
            const sep = raw.indexOf("-");
            const title = sep > 0 ? raw.slice(0, sep).trim() : raw;
            const artist = sep > 0 ? raw.slice(sep + 1).trim() : "";
            return {
                content: "",
                mediaType: "music" as const,
                mediaData: { musicTitle: title, musicArtist: artist, label: raw },
            };
        },
    },
    {
        // [音乐分享:歌名] — AI shares a song as a card
        regex: new RegExp(`\\[音乐分享${C}([^\\]]+)\\]`),
        build: (m) => {
            const title = m[1].trim();
            return {
                content: "",
                mediaType: "music_share" as const,
                mediaData: { musicTitle: title, label: title },
            };
        },
    },
    {
        // [语音条:文字内容] — voice message
        regex: new RegExp(`\\[语音条${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "audio" as const,
            mediaData: { label: m[1].trim() },
        }),
    },
    {
        regex: /\[我向[^\]]+发起了语音通话\]/,
        build: () => ({ content: "", mediaType: "voice_call" as const }),
    },
    {
        regex: /\[我向[^\]]+发起了视频通话\]/,
        build: () => ({ content: "", mediaType: "video_call" as const }),
    },
    {
        // 角色主动撤回自己上一条消息：[撤回] —— 不产生气泡，入库层收回最近一条 assistant 消息
        regex: /\[撤回[^\]]*\]/,
        build: () => ({ content: "", mediaType: "recall" as const }),
    },
    {
        // 被拉黑角色发出的好友申请：[好友申请:留言] —— 卡片化，接受即解除拉黑
        regex: new RegExp(`\\[好友申请${C}([^\\]]+)\\]`),
        build: (m) => ({
            content: "",
            mediaType: "friend_request" as const,
            mediaData: { label: m[1].trim(), friendRequestStatus: "pending" as const },
        }),
    },
    {
        // 私聊角色主动发起线下见面邀请。固定标记不展示，转为可交互卡片。
        regex: /\[(?:线下见面邀请|邀请线下见面|邀请见面)\]/,
        build: () => ({
            content: "他想邀请你见面，是否同意？",
            mediaType: "meeting_invite" as const,
            mediaData: { meetingInviteStatus: "pending" as const },
        }),
    },
    // 群聊带主语宾语的格式（优先匹配）
    {
        regex: /\[([^\]]+)领取了([^\]]+)的红包\]/,
        build: (m) => ({ content: "", mediaType: "accept_red_packet" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)退回了([^\]]+)的红包\]/,
        build: (m) => ({ content: "", mediaType: "decline_red_packet" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:接受|领取)了([^\]]+)的转账\]/,
        build: (m) => ({ content: "", mediaType: "accept_transfer" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:拒收|退回)了([^\]]+)的转账\]/,
        build: (m) => ({ content: "", mediaType: "decline_transfer" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:接受|同意|支付|代付)了([^\]]+)的代付\]/,
        build: (m) => ({ content: "", mediaType: "accept_payment_request" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+)(?:拒绝|拒收|退回)了([^\]]+)的代付\]/,
        build: (m) => ({ content: "", mediaType: "decline_payment_request" as const, mediaData: { claimer: m[1]?.trim(), owner: m[2]?.trim() } }),
    },
    // 群管理操作（权限在 processGroupParts 校验，无权限的标签直接丢弃）
    {
        regex: /\[([^\]]+?)将群主转让给了?([^\]]+?)\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "transfer_owner" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)将([^\]]+?)设为了?管理员\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "set_admin" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)取消了([^\]]+?)的管理员\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "unset_admin" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)将([^\]]+?)移出了?群聊\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "kick" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        regex: /\[([^\]]+?)邀请([^\]]+?)加入了?群聊\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "invite" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    {
        // [A将B禁言30分钟]（必须先于下面的宽松模式，否则 "A将B禁言了1天" 会被错误拆分）
        regex: /\[([^\]：:]+?)将([^\]：:]+?)禁言(?:了)?\s*(\d+)?\s*(分钟|小时|天)?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        // [A禁言了B:30分钟] / [A禁言了B]（默认10分钟）
        regex: /\[([^\]：:]+?)禁言了([^\]：:]+?)(?:[：:]\s*(\d+)\s*(分钟|小时|天))?\]/,
        build: (m) => ({
            content: "",
            mediaType: "group_admin_notice" as const,
            mediaData: {
                adminAction: "mute" as const,
                adminActorName: m[1]?.trim(),
                adminTargetName: m[2]?.trim(),
                adminMuteMinutes: parseMuteMinutes(m[3], m[4]),
            },
        }),
    },
    {
        regex: /\[([^\]]+?)解除了([^\]]+?)的禁言\]/,
        build: (m) => ({ content: "", mediaType: "group_admin_notice" as const, mediaData: { adminAction: "unmute" as const, adminActorName: m[1]?.trim(), adminTargetName: m[2]?.trim() } }),
    },
    // 1:1 简单格式（兼容）
    {
        regex: /\[领取红包\]/,
        build: () => ({ content: "", mediaType: "accept_red_packet" as const }),
    },
    {
        regex: /\[拒收红包\]/,
        build: () => ({ content: "", mediaType: "decline_red_packet" as const }),
    },
    {
        regex: /\[(?:接受|领取)转账\]/,
        build: () => ({ content: "", mediaType: "accept_transfer" as const }),
    },
    {
        regex: /\[拒收转账\]/,
        build: () => ({ content: "", mediaType: "decline_transfer" as const }),
    },
    {
        regex: /\[接受代付\]/,
        build: () => ({ content: "", mediaType: "accept_payment_request" as const }),
    },
    {
        regex: /\[拒绝代付\]/,
        build: () => ({ content: "", mediaType: "decline_payment_request" as const }),
    },
    {
        // 末位兜底：已知标记头但缺右括号（如 "[语音条:内容" 一路写到行尾）。
        // 严格规则全部失配时按"到行尾"吃掉标记，避免整段原文泄进气泡。
        // 放最后——同一位置命中时列表靠前的严格规则优先。
        regex: new RegExp(
            `\\[(语音条|照片|表情包|位置|名片|音乐分享|音乐|红包|转账|礼物|引用|代付请求|好友申请)${C}([^\\]\\n]+)`,
        ),
        build: (m) => buildLooseMarkerPart(m[1], m[2]),
    },
];

type RichPatternCandidate = {
    index: number;
    matchText: string;
    build: () => ParsedMessagePart;
};

function syntaxArgLabels(syntax: string | undefined): string[] {
    const text = String(syntax ?? "").trim();
    const body = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
    const parts = body.split(/[：:]/).map(item => item.trim()).filter(Boolean);
    return parts.slice(1).map((item, index) => (
        item
            .replace(/[<>{}\[\]【】]/g, "")
            .replace(/^(参数|内容)$/, `参数${index + 1}`)
            .slice(0, 24)
            || `参数${index + 1}`
    ));
}

type DirectiveCardInterpolationContext = {
    args: string[];
    argLabels: string[];
    raw: string;
    summary: string;
    directive: RegisteredCustomAppChatDirective;
};

function buildDirectiveCardTokenMap(ctx: DirectiveCardInterpolationContext): Map<string, string> {
    const tokens = new Map<string, string>();
    tokens.set("raw", ctx.raw);
    tokens.set("summary", ctx.summary);
    tokens.set("directive", ctx.directive.label);
    tokens.set("label", ctx.directive.label);
    tokens.set("app", ctx.directive.appName);
    tokens.set("appName", ctx.directive.appName);
    ctx.args.forEach((arg, index) => {
        const oneBased = String(index + 1);
        tokens.set(`arg${oneBased}`, arg);
        tokens.set(`参数${oneBased}`, arg);
        tokens.set(oneBased, arg);
        const label = ctx.argLabels[index];
        if (label) tokens.set(label, arg);
    });
    return tokens;
}

function interpolateDirectiveCardValue(value: unknown, tokens: Map<string, string>): unknown {
    if (typeof value === "string") {
        return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, token: string) => {
            const key = token.trim();
            return tokens.has(key) ? tokens.get(key)! : match;
        });
    }
    if (Array.isArray(value)) {
        return value.map(item => interpolateDirectiveCardValue(item, tokens));
    }
    if (value && typeof value === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = interpolateDirectiveCardValue(item, tokens);
        }
        return result;
    }
    return value;
}

function interpolateDirectiveCardLayout(
    card: unknown,
    ctx: DirectiveCardInterpolationContext,
): Record<string, unknown> | null {
    if (!card || typeof card !== "object" || Array.isArray(card)) return null;
    return interpolateDirectiveCardValue(card, buildDirectiveCardTokenMap(ctx)) as Record<string, unknown>;
}

function buildCustomAppDirectivePart(
    directive: RegisteredCustomAppChatDirective,
    args: string[],
    raw: string,
): ParsedMessagePart {
    const summary = formatCustomAppDirectiveSummary(directive, args);
    const title = directive.title || directive.label;
    const argLabels = syntaxArgLabels(directive.syntax);
    const defaultLayout = {
        appLabel: directive.appLabel || directive.appName,
        title,
        subtitle: "",
        body: "",
        status: directive.status || "待确认",
        accentColor: directive.accentColor || "",
        sections: args.length > 0 ? [{
            rows: args.map((arg, index) => ({
                label: argLabels[index] || `参数${index + 1}`,
                value: arg,
            })),
        }] : [],
        actions: directive.actions && directive.actions.length > 0
            ? directive.actions
            : [{ label: "查看", style: "default" }],
    };
    const customLayout = interpolateDirectiveCardLayout(directive.card, {
        args,
        argLabels,
        raw,
        summary,
        directive,
    });
    return {
        content: summary,
        mediaType: "app_card",
        mediaData: {
            appId: directive.appId,
            appName: directive.appName,
            appCardTitle: title,
            appCardBody: "",
            appCardSummary: summary,
            appCardTone: directive.tone,
            appDirectiveId: directive.id,
            appDirectiveLabel: directive.label,
            appDirectiveArgs: args,
            appDirectiveRaw: raw,
            appSceneId: directive.sceneId,
            appSceneTag: directive.sceneTag,
            appTags: directive.tags,
            appHistoryText: summary,
            appCardLayout: customLayout
                ? { ...defaultLayout, ...customLayout }
                : defaultLayout,
        },
    };
}

function findBuiltInRichCandidate(segment: string): RichPatternCandidate | null {
    let best: { index: number; m: RegExpMatchArray; build: (m: RegExpMatchArray) => ParsedMessagePart } | null = null;
    for (const { regex, build } of RICH_PATTERNS) {
        const m = segment.match(regex);
        if (m && m.index !== undefined && (best === null || m.index < best.index)) {
            best = { index: m.index, m, build };
        }
    }
    if (!best) return null;
    const candidate = best;
    return {
        index: best.index,
        matchText: best.m[0],
        build: () => candidate.build(candidate.m),
    };
}

function findCustomAppRichCandidate(segment: string): RichPatternCandidate | null {
    const directives = loadCustomAppChatDirectives();
    if (directives.length === 0) return null;
    const bySyntaxHead = new Map(directives.map(item => [getCustomAppDirectiveSyntaxHead(item.syntax), item]));
    const bracketPattern = /\[([^\]\n：:]{1,24})([：:][^\]\n]*)?\]/g;
    let match: RegExpExecArray | null;
    while ((match = bracketPattern.exec(segment)) !== null) {
        const directive = bySyntaxHead.get(match[1].trim());
        if (!directive) continue;
        const args = splitCustomAppDirectiveArgs(match[2] || "");
        const raw = match[0];
        return {
            index: match.index,
            matchText: raw,
            build: () => buildCustomAppDirectivePart(directive, args, raw),
        };
    }
    return null;
}

// ── Structured hidden block extraction ───────────────────

function extractBracketBlock(text: string, tag: string): { cleaned: string; content: string } {
    let content = "";
    let cleaned = text;
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`\\[${escapedTag}\\]([\\s\\S]*?)\\[\\/${escapedTag}\\]`, "g");

    let match;
    while ((match = rx.exec(cleaned)) !== null) {
        const block = match[1].trim();
        if (!block) continue;
        if (content) content += "\n\n";
        content += block;
    }
    cleaned = cleaned.replace(rx, "").trim();

    return { cleaned, content };
}

// ── Segment parser ──────────────────────────────────────

/**
 * Parse a segment for rich-media markers.
 * If found, splits into before-text + media + recurse(after-text).
 * If not found, pushes as plain text.
 */
function parseSegment(segment: string, parts: ParsedMessagePart[]) {
    // Pick the rich marker that appears EARLIEST in the text, not the first
    // pattern that happens to match. Otherwise, when an earlier-in-text marker
    // (e.g. [表情包:x]) belongs to a pattern listed after a later-in-text marker
    // (e.g. [...拍了拍...]), the earlier marker lands in the un-parsed `before`
    // chunk and leaks as literal text. Ties keep list order (priority).
    const builtIn = findBuiltInRichCandidate(segment);
    const customApp = findCustomAppRichCandidate(segment);
    const best = customApp && (!builtIn || customApp.index < builtIn.index) ? customApp : builtIn;

    if (best) {
        const before = segment.slice(0, best.index).trim();
        const after = segment.slice(best.index + best.matchText.length).trim();

        // `before` is guaranteed marker-free (we chose the earliest marker).
        if (before) parts.push({ content: before });
        parts.push(best.build());
        if (after) parseSegment(after, parts);
        return;
    }

    // No rich media — plain text
    parts.push({ content: segment });
}

// ── Main parser ──────────────────────────────────────────

export function parseAIResponse(rawText: string, previousState: StateValue[]): ParsedAIResponse {
    const acceptedAvatarRecommendation = /[\[【]\s*接受头像推荐\s*[\]】]/.test(rawText);
    const declinedAvatarRecommendation = /[\[【]\s*拒绝头像推荐\s*[\]】]/.test(rawText);
    // 0. FIRST: extract ```html blocks and <style>+HTML before any processing
    const htmlBlockPlaceholders: { placeholder: string; original: string }[] = [];
    let protected_ = rawText;
    // Protect ```html...``` blocks
    protected_ = protected_.replace(/```html\s*\n[\s\S]*?```/g, (match) => {
        const placeholder = `\x00HTML_BLOCK_${htmlBlockPlaceholders.length}\x00`;
        htmlBlockPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });
    // Protect <style>...</style> and following HTML until next double-newline + non-HTML,
    // 或者撞上 [/状态栏]、[/内心] 的闭合标签。
    // 闭合标签这一支不能省：AI 按契约在 [状态栏] 里直出 HTML 时，HTML 和闭合标签之间
    // 通常只有单换行、没有空行可停，保护段就会一路吞到 $——把 [/状态栏] 连同它后面的
    // 聊天正文一起卷进占位符。闭合标签在下面 extractBracketBlock 跑之前就没了，状态栏
    // 提取不到，整块连标签带 HTML 全泄进气泡。（"要空一行才正常"就是撞的这里。）
    protected_ = protected_.replace(/<style[\s\S]*?<\/style>[\s\S]*?(?=\n\n[^<\x00]|\s*\[\/(?:状态栏|内心)\]|$)/gi, (match) => {
        const placeholder = `\x00HTML_BLOCK_${htmlBlockPlaceholders.length}\x00`;
        htmlBlockPlaceholders.push({ placeholder, original: match });
        return placeholder;
    });

    // Helper to restore placeholders
    const restore = (text: string) => {
        let r = text;
        for (const { placeholder, original } of htmlBlockPlaceholders) {
            r = r.split(placeholder).join(original);
        }
        return r;
    };

    // 0.5. 协议标记归一化：别名/全角括号/未闭合块/旧 JSON 语音统一成规范形态。
    //    放在 HTML 保护之后（占位符不含括号，不会被误伤）、状态值与块提取之前——
    //    下游所有正则只需认规范名。
    protected_ = normalizeProtocolMarkup(protected_);

    // 1. Parse state values
    const parsedSV = parseStateValues(protected_);
    const stateValues = mergeStateValues(previousState, parsedSV.stateValues);

    // 1.5. Strip AI hallucination XML/bracket action shells
    let actionCleaned = stripActionShells(parsedSV.cleanText)
        .replace(/[\[【]\s*(?:接受|拒绝)头像推荐\s*[\]】]/g, "")
        .trim();
    // 模型只返回控制标记时也保留一条自然可见的答复；否则没有消息落库，
    // 共享消息层便无法执行这次头像选择。
    if (!actionCleaned && acceptedAvatarRecommendation) actionCleaned = "我换上了你推荐的头像。";
    if (!actionCleaned && declinedAvatarRecommendation) actionCleaned = "我想继续使用现在的头像。";

    // 2. Extract display-only status panel, then inner monologue
    const status = extractBracketBlock(actionCleaned, "状态栏");
    const mono = extractBracketBlock(status.cleaned, "内心");

    // 2.1. Collapse residual blank lines left by tag extraction
    const postCleaned = mono.cleaned.replace(/\n{3,}/g, "\n\n").trim();

    // 2.5. Merge [引用:...] with following reply text even if separated by newlines
    const mergedText = postCleaned.replace(/(\[引用[：:][^\]]+\])\s*\n+\s*/g, "$1");

    // 2.6. Collapse blank lines around [表情包:...] so stickers stay in the same segment as adjacent text
    const stickerMerged = mergedText
        .replace(/\n\n+(?=\[表情包[：:][^\]]+\])/g, "\n")
        .replace(/(\[表情包[：:][^\]]+\])\n\n+/g, "$1\n");

    // 3. Split by double newlines (placeholders still in place)
    const segments = stickerMerged.split(/\n\n+/).map(s => s.trim()).filter(Boolean);

    // 4. Parse each segment
    const parts: ParsedMessagePart[] = [];
    for (const seg of segments) {
        parseSegment(seg, parts);
    }

    // 5. Restore HTML block placeholders and keep unknown bracket protocols as plain text.
    //    Strip tool directives (获取指令/执行动作) from display content too: a
    //    directive-only segment would otherwise survive as a non-empty part, render
    //    as an empty bubble after the display layer strips it, and capture the inner
    //    monologue (which then has nowhere to attach). Stripping here makes such a
    //    part empty → filtered out → inner monologue lands on the first real reply.
    const cleaned = parts.map(p => {
        if (p.mediaType) return p;
        const display = stripTextToolDirectives(restore(p.content));
        return { ...p, content: display };
    }).filter(p => p.mediaType || !isInvisibleOrWhitespaceOnly(p.content));

    return {
        parts: cleaned,
        stateValues,
        freshStateValues: parsedSV.stateValues,
        statusPanel: restore(status.content),
        innerMonologue: restore(mono.content),
    };
}
