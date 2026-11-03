"use client";

// 资源集市所见即所得编辑器：编辑时直接看到颜色/字号/加粗/贴纸的实际效果，
// 用户永远看不到 [红]...[/红] 这类原始标记——标记只是对外存储格式，
// 提交时由 DOM 序列化产生（详情页仍用 RichText 安全渲染回来）。
//
// 实现要点：
// - contentEditable 完全非受控：React 只在打开时写一次 innerHTML，之后不再碰内容，
//   否则中文输入法组词会被打断、光标会乱跳（移动端尤其明显）。
// - 加粗/颜色/字号走 execCommand：浏览器自己处理选区拆分与"再点一次取消"，
//   比手写 Range 手术在 iOS 上稳得多；产出的样式在序列化时统一归一化。
// - 粘贴强制纯文本，外部 HTML 进不来；序列化只认识我们自己的几种标记，
//   所以存进仓库的内容天然是干净的。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { RICH_COLORS } from "./rich-text";
import { STICKERS, stickerDataUrl } from "./pixel-stickers";

/** 字号标记 ↔ CSS。编辑器统一用 em，与详情页的显示效果一致；
 *  execCommand 产出的是 x-large/small 关键字，插入后会被归一化成 em。 */
const CSS_BY_SIZE_TAG: Record<string, string> = { 大: "1.3em", 小: "0.85em" };
const SIZE_TAG_BY_CSS: Record<string, string> = {
    "1.3em": "大", "0.85em": "小",
    "x-large": "大", small: "小",
};
/** execCommand fontSize 的档位（1-7） */
const EXEC_SIZE_LEVEL: Record<string, string> = { 大: "5", 小: "2" };

export type RichEditorHandle = {
    /** 取当前内容的标记文本（提交/校验用） */
    getMarkup: () => string;
    /** 覆盖内容（打开对话框、清空时用） */
    setMarkup: (markup: string) => void;
    /** 对选中文字套用标记；没选中返回 false */
    applyTag: (tag: string) => boolean;
    /** 清掉选中文字的颜色/字号/加粗，回到默认；没选中返回 false */
    clearFormat: () => boolean;
    /** 在光标处插入贴纸 */
    insertSticker: (name: string) => void;
    focus: () => void;
};

// ── 标记 → HTML（编辑器初始内容） ──

function escapeHtml(text: string): string {
    return text.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
}

function openTagHtml(tag: string): string | null {
    if (RICH_COLORS[tag]) return `<span style="color: ${RICH_COLORS[tag]};">`;
    if (tag === "粗") return `<span style="font-weight: bold;">`;
    if (CSS_BY_SIZE_TAG[tag]) return `<span style="font-size: ${CSS_BY_SIZE_TAG[tag]};">`;
    return null;
}

const TOKEN_RE = /\[(\/?)([^[\]/\s]{1,6})\]/g;

export function markupToHtml(markup: string): string {
    let html = "";
    const stack: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((match = TOKEN_RE.exec(markup)) !== null) {
        const [raw, slash, tag] = match;
        html += escapeHtml(markup.slice(cursor, match.index)).replace(/\n/g, "<br>");
        cursor = match.index + raw.length;
        if (!slash && STICKERS[tag]) {
            html += `<img data-sticker="${escapeHtml(tag)}" src="${stickerDataUrl(tag)}" alt="${escapeHtml(tag)}" style="display:inline;height:1.25em;vertical-align:-0.22em;">`;
            continue;
        }
        const open = openTagHtml(tag);
        if (!open) { html += escapeHtml(raw); continue; }   // 未注册标记原样显示
        if (!slash) { stack.push(tag); html += open; }
        else if (stack[stack.length - 1] === tag) { stack.pop(); html += "</span>"; }
        else html += escapeHtml(raw);
    }
    html += escapeHtml(markup.slice(cursor)).replace(/\n/g, "<br>");
    while (stack.length) { stack.pop(); html += "</span>"; }
    return html;
}

// ── HTML → 标记（提交时序列化） ──

function normalizeColor(value: string): string {
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
    if (rgb) {
        return "#" + [rgb[1], rgb[2], rgb[3]]
            .map(n => Number(n).toString(16).padStart(2, "0")).join("");
    }
    const hex = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
    if (/^#[0-9a-f]{3}$/.test(hex)) return "#" + hex.slice(1).split("").map(c => c + c).join("");
    return "";
}

const COLOR_TAG_BY_HEX: Record<string, string> = Object.fromEntries(
    Object.entries(RICH_COLORS).map(([tag, hex]) => [hex.toLowerCase(), tag]));

/** 元素上生效的标记（同时认识 execCommand 的产物与我们自己写的样式） */
function tagsForElement(el: HTMLElement): string[] {
    const tags: string[] = [];
    const weight = el.style.fontWeight;
    if (el.tagName === "B" || el.tagName === "STRONG"
        || weight === "bold" || (weight !== "" && Number(weight) >= 600)) {
        tags.push("粗");
    }
    const colorTag = COLOR_TAG_BY_HEX[normalizeColor(el.style.color || el.getAttribute("color") || "")];
    if (colorTag) tags.push(colorTag);
    const sizeTag = SIZE_TAG_BY_CSS[el.style.fontSize];
    if (sizeTag) tags.push(sizeTag);
    return tags;
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "TR"]);

function serialize(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").replace(/\u00a0/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    if (el.tagName === "BR") return "\n";
    const sticker = el.dataset.sticker;
    if (sticker) return STICKERS[sticker] ? `[${sticker}]` : "";
    let inner = Array.from(el.childNodes).map(serialize).join("");
    for (const tag of tagsForElement(el).reverse()) inner = `[${tag}]${inner}[/${tag}]`;
    // 浏览器在回车时会造 <div> 块，等价于换行
    return BLOCK_TAGS.has(el.tagName) ? `\n${inner}` : inner;
}

export function htmlToMarkup(root: HTMLElement): string {
    const text = Array.from(root.childNodes).map(serialize).join("");
    return text.replace(/^\n/, "");
}

// ── 选区操作 ──

/** 把 execCommand 产出的 x-large/small 换成 em，编辑器所见与详情页一致 */
function normalizeSizes(root: HTMLElement): void {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style*='font-size']"))) {
        const tag = SIZE_TAG_BY_CSS[el.style.fontSize];
        if (tag) el.style.fontSize = CSS_BY_SIZE_TAG[tag];
    }
}

/** DOM 位置 → 纯文本偏移（贴纸 <img> 不计长度，与 clearMarkupRange 口径一致） */
function textOffsetOf(root: HTMLElement, container: Node, offset: number): number {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let total = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (node === container) return total + offset;
        total += (node.nodeValue ?? "").length;
    }
    // 选区端点落在元素上（比如贴纸前后）：数它前面的文本
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(container, offset);
    return range.toString().length;
}

/** 纯文本偏移 → 选中这一段 */
function selectTextRange(root: HTMLElement, from: number, to: number): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let startNode: Node | null = null, startOffset = 0, endNode: Node | null = null, endOffset = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const len = (node.nodeValue ?? "").length;
        if (!startNode && seen + len >= from) { startNode = node; startOffset = from - seen; }
        if (!endNode && seen + len >= to) { endNode = node; endOffset = to - seen; }
        seen += len;
    }
    if (!startNode || !endNode) return;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = typeof window === "undefined" ? null : window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function selectionInside(root: HTMLElement): Range | null {
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range : null;
}

/** 一个"字符单位"：普通字符，或一枚贴纸（贴纸是原子，不可再拆） */
type MarkupUnit = { text: string; tags: string[] };

/** 标记串 → 逐单位展开（每个单位记着它身上盖着哪些标记） */
function explodeMarkup(markup: string): MarkupUnit[] {
    const units: MarkupUnit[] = [];
    const stack: string[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    const pushText = (text: string) => {
        for (const ch of text) units.push({ text: ch, tags: [...stack] });
    };
    while ((match = TOKEN_RE.exec(markup)) !== null) {
        const [raw, slash, tag] = match;
        pushText(markup.slice(cursor, match.index));
        cursor = match.index + raw.length;
        if (STICKERS[tag] && !slash) {
            units.push({ text: raw, tags: [...stack] });   // 贴纸整体算一个单位
        } else if (slash) {
            const at = stack.lastIndexOf(tag);
            if (at !== -1) stack.splice(at, 1);
        } else if (openTagHtml(tag)) {
            stack.push(tag);
        } else {
            pushText(raw);   // 不认识的标记按普通文字处理，与渲染侧一致
        }
    }
    pushText(markup.slice(cursor));
    return units;
}

/** 逐单位 → 标记串（相邻同标记的合并成一段） */
function assembleMarkup(units: MarkupUnit[]): string {
    let out = "";
    let open: string[] = [];
    for (const unit of units) {
        // 先关掉不再需要的（从最内层往外关）
        let keep = 0;
        while (keep < open.length && keep < unit.tags.length && open[keep] === unit.tags[keep]) keep++;
        for (let i = open.length - 1; i >= keep; i--) out += `[/${open[i]}]`;
        for (let i = keep; i < unit.tags.length; i++) out += `[${unit.tags[i]}]`;
        open = [...unit.tags];
        out += unit.text;
    }
    for (let i = open.length - 1; i >= 0; i--) out += `[/${open[i]}]`;
    return out;
}

/** 单位序列里，一枚贴纸只占 1 个"字符位"——与 DOM 里的文本偏移对不上，所以单独算 */
function unitTextLength(unit: MarkupUnit): number {
    return STICKERS[unit.text.replace(/[[\]]/g, "")] ? 0 : unit.text.length;
}

/**
 * 把标记串里 [from, to) 这段纯文本上的格式（颜色/字号/加粗）清掉，两侧不动。
 * from/to 是"纯文本偏移"，贴纸不计入长度（与 DOM 里的文本节点偏移口径一致）。
 *
 * 为什么不在 DOM 上做：
 *  · document.execCommand("removeFormat") 实测（Chromium）在被清的那段含内联贴纸
 *    <img> 时会清错位置——选中"甲"却把后面的"乙"清了；各浏览器实现本就不一致，
 *    iOS Safari 只会更不可控。
 *  · 自己用 Range 抽取再放回也不行：抽完插入点仍然留在原来的颜色 span 内部，
 *    放回去等于没清，要正确就得手写"在选区边界劈开各层祖先"，同样容易踩浏览器差异。
 *  · 也不能靠"再套一个黑色/正常字号的标记"还原：那只是在外层 [红] 里再套一层，
 *    序列化时内层认不出被丢掉，文字仍在 [红] 里。
 * 在标记串上做，结果只由这几十行代码决定，浏览器怎么想都一样。
 */
export function clearMarkupRange(markup: string, from: number, to: number): string {
    if (to <= from) return markup;
    const units = explodeMarkup(markup);
    let offset = 0;
    for (const unit of units) {
        const len = unitTextLength(unit);
        // 贴纸不占文本长度，判定要严格"夹在选区内部"：端点上的贴纸（比如选中
        // 贴纸右边那个字）不该被牵连——字号标记是会改变贴纸大小的，清错看得见。
        // 代价是"只选中一枚贴纸"清不掉它的格式：那种选区算出来 from === to，
        // 上游会直接判定为空选区。贴纸本来也只有字号看得出差别，可以接受。
        const inside = len === 0
            ? offset > from && offset < to
            : offset >= from && offset < to;
        if (inside) unit.tags = [];
        offset += len;
    }
    return assembleMarkup(units);
}

export const RichEditor = forwardRef<RichEditorHandle, {
    className?: string;
    placeholder?: string;
    singleLine?: boolean;
    ariaLabel?: string;
    /** 内容变化时回传标记（供外部做校验/提交，不回写 DOM） */
    onChange?: (markup: string) => void;
}>(function RichEditor({ className, placeholder, singleLine, ariaLabel, onChange }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const composingRef = useRef(false);

    const emit = useCallback(() => {
        const root = rootRef.current;
        if (!root || composingRef.current) return;
        const markup = htmlToMarkup(root);
        // 空态标记给 CSS 用：浏览器会在"空"的编辑区留一个 <br>，:empty 靠不住
        root.toggleAttribute("data-empty", markup.trim() === "");
        onChange?.(markup);
    }, [onChange]);

    // 挂载时同步一次，保证外部状态与（空的）编辑器一致
    useEffect(() => { emit(); }, [emit]);

    useImperativeHandle(ref, () => ({
        getMarkup: () => (rootRef.current ? htmlToMarkup(rootRef.current) : ""),
        setMarkup: (markup: string) => {
            if (rootRef.current) rootRef.current.innerHTML = markupToHtml(markup);
            emit();
        },
        focus: () => rootRef.current?.focus(),
        applyTag: (tag: string) => {
            const root = rootRef.current;
            if (!root) return false;
            const range = selectionInside(root);
            if (!range || range.collapsed) return false;
            root.focus();
            try { document.execCommand("styleWithCSS", false, "true"); } catch { /* 老浏览器忽略 */ }
            if (tag === "粗") {
                document.execCommand("bold");
            } else if (RICH_COLORS[tag]) {
                document.execCommand("foreColor", false, RICH_COLORS[tag]);
            } else if (EXEC_SIZE_LEVEL[tag]) {
                document.execCommand("fontSize", false, EXEC_SIZE_LEVEL[tag]);
                normalizeSizes(root);
            } else {
                return false;
            }
            emit();
            return true;
        },
        // 恢复默认没法靠"再套一个标记"实现：给选区套黑色或正常字号只会在原来的
        // 颜色 span 里再套一层，序列化时内层认不出标记被丢掉，文字仍留在外层
        // [红] 里。
        //
        // 也不能用 document.execCommand("removeFormat")：实测（Chromium）当被清的
        // 那段里含有内联贴纸 <img> 时，它会清错位置——选中"甲"却把后面的"乙"清了。
        // execCommand 的实现本来各家就不一致，iOS Safari 只会更不可控。
        //
        // 所以自己做：把选区抽出来，递归剥掉格式元素（保留文字、贴纸、换行），
        // 再放回原处。Range 抽取时会自动把跨边界的 span 切开，正是我们要的。
        clearFormat: () => {
            const root = rootRef.current;
            if (!root) return false;
            const range = selectionInside(root);
            if (!range || range.collapsed) return false;
            const from = textOffsetOf(root, range.startContainer, range.startOffset);
            const to = textOffsetOf(root, range.endContainer, range.endOffset);
            if (to <= from) return false;
            root.innerHTML = markupToHtml(clearMarkupRange(htmlToMarkup(root), from, to));
            root.focus();
            selectTextRange(root, from, to);   // 选区留在原处，方便接着改
            emit();
            return true;
        },
        insertSticker: (name: string) => {
            const root = rootRef.current;
            if (!root || !STICKERS[name]) return;
            const img = document.createElement("img");
            img.dataset.sticker = name;
            img.src = stickerDataUrl(name);
            img.alt = name;
            // 全局样式里 img 是 block，贴纸必须显式改回 inline 才能跟文字同行
            img.style.display = "inline";
            img.style.height = "1.25em";
            img.style.verticalAlign = "-0.22em";

            root.focus();
            const range = selectionInside(root);
            if (range) {
                range.deleteContents();
                range.insertNode(img);
                range.setStartAfter(img);
                range.collapse(true);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
            } else {
                root.appendChild(img);
            }
            emit();
        },
    }), [emit, onChange]);

    return (
        <div
            ref={rootRef}
            className={className}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label={ariaLabel}
            data-placeholder={placeholder}
            onInput={emit}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; emit(); }}
            onBlur={emit}
            onKeyDown={e => { if (singleLine && e.key === "Enter") e.preventDefault(); }}
            onPaste={e => {
                // 只收纯文本，外部富文本/HTML 一律不进编辑器
                e.preventDefault();
                const text = e.clipboardData.getData("text/plain");
                document.execCommand("insertText", false, singleLine ? text.replace(/\s*\n\s*/g, " ") : text);
            }}
        />
    );
});
