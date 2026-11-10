"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { LanguageIcon } from "@heroicons/react/24/solid";
import { marked } from "marked";
import { translateReasoningText } from "@/lib/reasoning-translate";
import { CustomStatusFrame } from "@/components/chat/custom-status-frame";
import { anchorGeneratedCss, scopeGeneratedCss } from "@/lib/css-scoper";

export type StoryVoiceSegment = {
    id: string;
    text: string;
    speaker?: string;
};

/** Standard HTML tags — anything not in this set gets stripped (content kept) */
const STANDARD_TAGS = new Set([
    "a","abbr","address","area","article","aside","audio","b","base","bdi","bdo",
    "blockquote","body","br","button","canvas","caption","cite","code","col",
    "colgroup","data","datalist","dd","del","details","dfn","dialog","div","dl",
    "dt","em","embed","fieldset","figcaption","figure","footer","form","h1","h2",
    "h3","h4","h5","h6","head","header","hgroup","hr","html","i","iframe","img",
    "input","ins","kbd","label","legend","li","link","main","map","mark","menu",
    "meta","meter","nav","noscript","object","ol","optgroup","option","output","p",
    "picture","pre","progress","q","rp","rt","ruby","s","samp","script","search",
    "section","select","slot","small","source","span","strong","style","sub",
    "summary","sup","table","tbody","td","template","textarea","tfoot","th",
    "thead","time","title","tr","track","u","ul","var","video","wbr",
    "svg","path","circle","rect","line","polyline","polygon","text","g","defs",
    "use","clippath","mask","filter","lineargradient","radialgradient","stop",
    "center","font","marquee","strike","tt","big",
]);

// 允许以 story_ 开头的自定义标签
function isSafeTag(tag: string) {
    const lower = tag.toLowerCase();
    return STANDARD_TAGS.has(lower) || lower.startsWith("story_");
}

// ── Content splitting: separate ```html blocks from regular content ──

type Segment =
    | { type: "markdown"; content: string }
    | { type: "html-page"; content: string }
    | { type: "fold"; label: string; content: string };

/** 折叠块：think/thinking（思维链）带「翻译」按钮与 中文/原文/对照 切换；其余折叠标签（summary、自定义等）不带 */
function StoryFoldBlock({ label, content, scopeClass, children }: {
    label: string;
    content: string;
    scopeClass: string;
    children: ReactNode;
}) {
    const canTranslate = /^(think|thinking)$/i.test(label.trim());
    const [translation, setTranslation] = useState<string | null>(null);
    const [translating, setTranslating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<"both" | "zh" | "orig">("both");
    // 折叠内容懒挂载：收起状态下 iframe 宽度为 0，高度桥会测出垃圾值并触发
    // vh 反馈环高度锁（表现为展开后一大段空白）。展开后才渲染内容即可避免。
    const [hasOpened, setHasOpened] = useState(false);
    const handleTranslate = async (e: { preventDefault(): void; stopPropagation(): void }) => {
        e.preventDefault();
        e.stopPropagation();
        if (translating) return;
        setTranslating(true);
        setError(null);
        try {
            const result = await translateReasoningText(content);
            if (result.content) { setTranslation(result.content); setViewMode("both"); }
            else setError(result.error || "翻译失败，请重试");
        } catch {
            setError("翻译失败，请重试");
        } finally {
            setTranslating(false);
        }
    };
    const pickMode = (mode: "both" | "zh" | "orig") => (e: { preventDefault(): void; stopPropagation(): void }) => {
        e.preventDefault();
        e.stopPropagation();
        setViewMode(mode);
    };
    return (
        <details
            className="story-fold-block"
            data-fold-tag={label}
            onToggle={(e) => { if (e.currentTarget.open) setHasOpened(true); }}
        >
            <summary>
                {label}
                {canTranslate && !translation && (
                    <button
                        type="button"
                        className="story-fold-translate-btn story-fold-translate-icon"
                        onClick={handleTranslate}
                        aria-label={translating ? "翻译中" : "翻译"}
                        title={translating ? "翻译中" : "翻译"}
                    >
                        {translating
                            ? <Loader2 size={13} className="story-fold-icon-spin" aria-hidden="true" />
                            : <LanguageIcon width={13} height={13} aria-hidden="true" />}
                    </button>
                )}
                {canTranslate && translation && (
                    <span className="story-fold-view-switch">
                        {([["zh", "中文"], ["orig", "原文"], ["both", "对照"]] as const).map(([mode, text]) => (
                            <button
                                key={mode}
                                type="button"
                                className="story-fold-translate-btn"
                                {...(viewMode === mode ? { "data-active": "" } : {})}
                                onClick={pickMode(mode)}
                            >{text}</button>
                        ))}
                    </span>
                )}
            </summary>
            <div className="story-fold-block__content">
                {error && <div className="story-fold-translate-error">{error}</div>}
                {translation && viewMode !== "orig" && (
                    <div className={viewMode === "both" ? "story-fold-translation" : undefined}>
                        <MarkdownSegment content={translation} scopeClass={scopeClass} />
                    </div>
                )}
                {(viewMode !== "zh" || !translation) && hasOpened ? children : null}
            </div>
        </details>
    );
}

function splitContent(text: string): Segment[] {
    if (!text) return [];
    const segments: Segment[] = [];
    const foldRx = /<!--RHR-FOLD:([^>]+)-->\s*([\s\S]*?)\s*<!--\/RHR-FOLD-->/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = foldRx.exec(text)) !== null) {
        segments.push(...splitNonFoldContent(text.slice(lastIndex, match.index)));
        const content = match[2].trim();
        if (content) segments.push({ type: "fold", label: match[1] || "fold", content });
        lastIndex = match.index + match[0].length;
    }
    segments.push(...splitNonFoldContent(text.slice(lastIndex)));
    return segments;
}

function splitNonFoldContent(text: string): Segment[] {
    const whole = text.trim();
    // 带脚本的生成页必须放进可执行脚本的隔离 iframe；Markdown 路径会为安全
    // 删除 script，正是剧情页 HTML 看起来“不能交互”的原因。
    if (whole && /<script\b/i.test(whole)) {
        return [{ type: "html-page", content: whole }];
    }
    const segments: Segment[] = [];
    const rx = /```html\s*\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rx.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index).trim();
        if (before) segments.push({ type: "markdown", content: before });
        const html = match[1].trim();
        if (html) segments.push({ type: "html-page", content: html });
        lastIndex = match.index + match[0].length;
    }
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ type: "markdown", content: remaining });
    return segments;
}

// ── Markdown segment: marked + scoped HTML rendering ──

/** Scope CSS inside every <style> block, including ones with attributes. */
function scopeStyles(html: string, scopeClass: string): string {
    const scopedBlocks: string[] = [];
    let next = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css: string) => {
        const token = `%%SCOPEDSTYLE${scopedBlocks.length}%%`;
        scopedBlocks.push(`<style>${scopeGeneratedCss(css, `.${scopeClass}`)}</style>`);
        return token;
    });
    // An unclosed <style> (a reply that is still streaming, or a card that never
    // closes the tag) would apply to the whole phone. Drop the tag; keep the text.
    next = next.replace(/<style\b[^>]*>/gi, "");
    next = next.replace(/<link\b[^>]*>/gi, (tag) => (
        /\brel\s*=\s*(['"]?)[^'"]*stylesheet\1/i.test(tag) ? "" : tag
    ));
    next = anchorGeneratedCss(next);
    for (let i = 0; i < scopedBlocks.length; i++) {
        next = next.replace(`%%SCOPEDSTYLE${i}%%`, scopedBlocks[i]);
    }
    return next;
}

// Configure marked for chat-style line breaks.
marked.setOptions({
    breaks: true,      // line breaks → <br>
    gfm: true,         // GitHub Flavored Markdown (tables, strikethrough)
});

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function parseLegacyStoryVoiceMarker(inner: string): { text: string; speaker?: string } {
    const normalized = inner.trim();
    const separator = normalized.match(/^([^：:\n]{1,32})[：:]\s*([\s\S]+)$/);
    if (!separator) return { text: normalized };
    return { speaker: separator[1].trim(), text: separator[2].trim() };
}

function MarkdownSegment({
    content,
    scopeClass,
    voiceIdPrefix,
    playingVoiceSegmentId,
}: {
    content: string;
    scopeClass: string;
    voiceIdPrefix?: string;
    playingVoiceSegmentId?: string | null;
}) {
    const html = useMemo(() => {
        const voicePlaceholders: Array<{ token: string; html: string }> = [];
        const semanticPlaceholders: Array<{ token: string; html: string }> = [];
        let voiceIndex = 0;
        const voicePrepared = voiceIdPrefix
            ? content.replace(/「([^」\n]+)」|⌈([^⌈⌋]+)⌋|“([^“”\n]+)”/g, (_whole, standardInner: string | undefined, legacyInner: string | undefined, curlyInner: string | undefined) => {
                // “……”按剧情格式约定是环境音效（非人声），不配语音按钮；
                // 其余“……”对白作为兼容识别，同样可点按朗读
                if (curlyInner != null && /^[…．.。・~～！!？?\s]+$/.test(curlyInner)) return _whole;
                const parsed = legacyInner == null
                    ? { text: (standardInner ?? curlyInner ?? "").trim(), speaker: undefined }
                    : parseLegacyStoryVoiceMarker(legacyInner);
                if (!parsed.text) return _whole;
                const id = `${voiceIdPrefix}:${voiceIndex++}`;
                const token = `STORYVOICEPLACEHOLDER${voicePlaceholders.length}END`;
                const speakerAttr = parsed.speaker
                    ? ` data-story-voice-speaker="${escapeHtmlAttribute(encodeURIComponent(parsed.speaker))}"`
                    : "";
                // 播放态不参与 HTML 生成（高亮与按钮状态由下方 DOM effect 切换）：
                // 朗读逐句切换时不再重跑整条 markdown/regex 管线，万字正文也不会卡死
                voicePlaceholders.push({
                    token,
                    html: `<span class="story-voice-segment" data-story-voice-segment="${escapeHtmlAttribute(id)}" data-story-voice-text="${escapeHtmlAttribute(encodeURIComponent(parsed.text))}"${speakerAttr}>「${escapeHtmlAttribute(parsed.text)}」<button type="button" class="story-voice-play" data-story-voice-play="${escapeHtmlAttribute(id)}" aria-label="朗读这句对白" title="播放"><span aria-hidden="true">▶</span></button></span>`,
                });
                return token;
            })
            : content;

        const scenePrepared = voicePrepared.replace(/^\s*【([^】\n]{1,80})】\s*$/gm, (_whole, label: string) => {
            const token = `STORYSCENEPLACEHOLDER${semanticPlaceholders.length}END`;
            semanticPlaceholders.push({
                token,
                html: `<div class="story-scene"><span aria-hidden="true">— </span>${escapeHtmlAttribute(label.trim())}<span aria-hidden="true"> —</span></div>`,
            });
            return token;
        });

        // 允许直接渲染用户定义的任意 <story_xxxx> 标签并支持其内部的 HTML
        // 此处不再强制转义替换，而是让它们作为合法的 HTML 标签保留下来。
        // 为了防止它们在后续被 sanitize 掉，我们需要把它们暂时替换为特殊占位符，
        // 等 sanitize 完毕后再还原。
        let customTagsPrepared = scenePrepared;
        const customTagPlaceholders: Array<{ token: string; html: string }> = [];
        
        customTagsPrepared = customTagsPrepared.replace(/<(story_[a-zA-Z0-9_-]+)([^>]*)>([\s\S]*?)<\/\1>/g, (wholeMatch, tagName, attrs, innerHTML) => {
            const token = `STORYCUSTOMTAGPLACEHOLDER${customTagPlaceholders.length}END`;
            // 不转义 innerHTML，允许用户在方案里直接写 <div class="..."> 等 HTML
            customTagPlaceholders.push({
                token,
                html: `<${tagName}${attrs}>${innerHTML}</${tagName}>`,
            });
            return token;
        });

        const semanticPrepared = customTagsPrepared.replace(/(^|[^~])~([^~\n<>{};]{1,60})~(?!~)/g, (_whole, prefix: string, emphasized: string) => {
            const token = `STORYACCENTPLACEHOLDER${semanticPlaceholders.length}END`;
            semanticPlaceholders.push({
                token,
                html: `<span class="story-accent">${escapeHtmlAttribute(emphasized)}</span>`,
            });
            return `${prefix}${token}`;
        });

        // 0. Pre-process:
        const preprocessed = semanticPrepared
            .replace(/<\/?([a-zA-Z][a-zA-Z0-9_-]*)[^>]*>/g, (match, tag) =>  // strip all non-standard HTML tags (keep content)
                isSafeTag(tag) ? match : "")
            .replace(/^[ \t]+/gm, "")                     // strip leading whitespace (prevents marked treating indented HTML as code blocks)
            .replace(/\n{3,}/g, "\n\n")                    // max 2 consecutive newlines
            .replace(/(>)\s*\n\n\s*(<)/g, "$1\n$2");       // remove blank lines between HTML tags

        // 1. Markdown → HTML
        const rawHtml = marked.parse(preprocessed, { async: false }) as string;

        // 2. Strip only <script> tags (security), keep everything else as-is
        //    No DOMPurify — regex-processed HTML is user-configured and trusted
        let clean = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

        // 2.5 单换行(<br>)后的行也做首行缩进：CSS text-indent 只作用于段落首行，
        //     标准的 each-line 关键字浏览器均未实现，这里在每个 <br> 后插入
        //     2em 占位符模拟；折叠块/系统消息内由 CSS 把占位符宽度归零
        clean = clean.replace(/<br\s*\/?>/gi, '<br><span class="story-br-indent"></span>');

        // 3. Scope <style> blocks to prevent CSS leaking
        const scoped = scopeStyles(clean, scopeClass);

        // 4. Clean up whitespace artifacts
        let trimmed = scoped
            .replace(/(<\/div>|<\/details>|<\/table>|<\/p>)\s*(<br\s*\/?>)\s*/gi, "$1")
            .replace(/(<br\s*\/?>){3,}/gi, "<br>")
            .replace(/<p>\s*<\/p>/gi, "")
            .replace(/<p>\s*(<br\s*\/?>)\s*<\/p>/gi, "");

        for (const placeholder of voicePlaceholders) {
            trimmed = trimmed.replace(placeholder.token, placeholder.html);
        }
        for (const placeholder of semanticPlaceholders) {
            trimmed = trimmed.replace(placeholder.token, placeholder.html);
        }
        for (const placeholder of customTagPlaceholders) {
            trimmed = trimmed.replace(placeholder.token, placeholder.html);
        }
        trimmed = trimmed.replace(/<em>/g, '<em class="story-thought">');

        return trimmed;
    }, [content, scopeClass, voiceIdPrefix]);

    // 朗读高亮：直接改 DOM，播放状态变化不再重建整段 innerHTML；
    // 长正文连续朗读时避免反复重排导致页面卡死
    const rootRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        root.querySelectorAll<HTMLElement>(".story-voice-segment.is-playing").forEach((element) => {
            element.classList.remove("is-playing");
            const button = element.querySelector<HTMLElement>(".story-voice-play");
            if (button) {
                button.setAttribute("aria-label", "朗读这句对白");
                button.setAttribute("title", "播放");
                const label = button.querySelector("span");
                if (label) label.textContent = "▶";
            }
        });
        if (!playingVoiceSegmentId) return;
        const selectorId = playingVoiceSegmentId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const active = root.querySelector<HTMLElement>(`.story-voice-segment[data-story-voice-segment="${selectorId}"]`);
        if (!active) return;
        active.classList.add("is-playing");
        const button = active.querySelector<HTMLElement>(".story-voice-play");
        if (button) {
            button.setAttribute("aria-label", "停止朗读");
            button.setAttribute("title", "停止");
            const label = button.querySelector("span");
            if (label) label.textContent = "■";
        }
    }, [playingVoiceSegmentId, html]);

    return <div ref={rootRef} className={scopeClass} style={{ whiteSpace: "normal" }} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Inline action click delegate ──
// Catches clicks on elements with data-action attribute inside MarkdownSegments
function useActionDelegate(containerRef: React.RefObject<HTMLDivElement | null>, onAction?: (text: string) => void) {
    useEffect(() => {
        if (!onAction) return;
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: MouseEvent) => {
            const target = (e.target as HTMLElement).closest("[data-action]");
            if (target) {
                e.preventDefault();
                e.stopPropagation();
                const action = target.getAttribute("data-action");
                if (action) onAction(action);
            }
        };
        el.addEventListener("click", handler, true);
        return () => el.removeEventListener("click", handler, true);
    }, [containerRef, onAction]);
}

function useStoryVoiceDelegate(
    containerRef: React.RefObject<HTMLDivElement | null>,
    onVoicePlay?: (segment: StoryVoiceSegment) => void,
) {
    useEffect(() => {
        if (!onVoicePlay) return;
        const el = containerRef.current;
        if (!el) return;
        const handler = (event: MouseEvent) => {
            const button = (event.target as HTMLElement).closest<HTMLElement>("[data-story-voice-play]");
            if (!button) return;
            const segment = button.closest<HTMLElement>("[data-story-voice-segment]");
            const id = button.dataset.storyVoicePlay;
            const encodedText = segment?.dataset.storyVoiceText;
            if (!id || !encodedText) return;
            event.preventDefault();
            event.stopPropagation();
            onVoicePlay({
                id,
                text: decodeURIComponent(encodedText),
                speaker: segment?.dataset.storyVoiceSpeaker
                    ? decodeURIComponent(segment.dataset.storyVoiceSpeaker)
                    : undefined,
            });
        };
        el.addEventListener("click", handler, true);
        return () => el.removeEventListener("click", handler, true);
    }, [containerRef, onVoicePlay]);
}

// ── HTML page segment: srcDoc iframe ──

interface HtmlPageProps {
    html: string;
    onOptionSelect?: (text: string) => void;
    htmlPageMode: "auto" | "contained";
    serifIframeFallback?: boolean;
}

function HtmlPageSegment({ html, onOptionSelect, htmlPageMode, serifIframeFallback }: HtmlPageProps) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState(0);
    const contained = htmlPageMode === "contained";
    // 高度反馈环检测：生成页里的 100vh/calc(100vh±x) 元素会随 iframe 高度一起
    // 变高（vh 以 iframe 视口为基准），测量→加高→再测量会无限增长，页面被
    // 每帧重排（拉到底时贴底逻辑还会跟着每帧强制滚动）。连续多次等步幅递增
    // 视为反馈环，锁住当前高度；内容真正变矮时解锁。
    const recentHeightsRef = useRef<{ h: number; t: number }[]>([]);
    const feedbackLockRef = useRef<number | null>(null);

    const srcDoc = useMemo(() => {
        // 高度桥接：照搬黑市剧场那套"按构造稳定"的做法——getBoundingClientRect 测真实
        // 内容、能缩回去；MutationObserver + 一堆事件捕捉任何变化(自定义按钮也行)；
        // body 高=内容高，父层改 iframe 高不反馈到内容 → 测出不变 → 天然不循环。
        // iframe 内部永远不滚（iOS 对 iframe 内部文档滚动的手势支持不可靠，生成页里的
        // fixed/100vh 元素会让整页划不动）；contained 模式改由外层同文档 div 滚动。
        // height:auto 把生成页常见的 height:100vh 压回内容高，保证测量与手势链正确。
        const bridge = `<style>html,body{overflow:hidden!important;height:auto!important;min-height:0!important}</style><script>(function(){function measure(){var b=document.body;if(!b)return 0;if(window.innerWidth<50)return 0;var br=b.getBoundingClientRect();var h=Math.max(br.height,b.scrollHeight||0);for(var i=0;i<b.children.length;i++){var c=b.children[i];var r=c.getBoundingClientRect();if(r.width||r.height)h=Math.max(h,r.bottom-br.top,c.scrollHeight||0)}return Math.ceil(h)}var animCount=0,animUntil=0;function isAnim(){return animCount>0&&Date.now()<animUntil}function animStart(){animCount++;animUntil=Date.now()+2000;schedule()}function animStop(){if(animCount>0)animCount--;schedule()}function send(){var h=measure();if(!h)return;window.parent.postMessage({type:"_rhr",h:h,anim:isAnim()},"*")}function schedule(){requestAnimationFrame(function(){send();requestAnimationFrame(send)})}window.addEventListener("load",schedule);window.addEventListener("resize",schedule);document.addEventListener("click",function(e){var t=e.target&&e.target.closest&&e.target.closest("[data-action]");if(t){var a=t.getAttribute("data-action");if(a){e.preventDefault();e.stopPropagation();window.parent.postMessage({type:"_rhr_opt",text:a},"*")}}window.parent.postMessage({type:"_rhr_act"},"*");schedule()},true);document.addEventListener("toggle",function(){window.parent.postMessage({type:"_rhr_act"},"*");schedule()},true);document.addEventListener("transitionrun",animStart,true);document.addEventListener("transitionend",animStop,true);document.addEventListener("transitioncancel",animStop,true);document.addEventListener("animationstart",animStart,true);document.addEventListener("animationend",animStop,true);document.addEventListener("animationcancel",animStop,true);if(window.MutationObserver)new MutationObserver(schedule).observe(document.documentElement,{attributes:true,childList:true,subtree:true,characterData:true});if(window.ResizeObserver){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body)}setTimeout(send,80);setTimeout(send,500);setTimeout(send,1600)})();<\/script>`;
        // 默认字体兜底：iframe 是独立文档，继承不到剧情页的宋体（--story-font），
        // UA 默认是无衬线（iOS 苹方）。把宋体默认值注入到文档最前面——生成页
        // 自己声明的 font-family 在后面，仍会覆盖这里，只兜底不强制。
        const fontFallback = `<style>body{font-family:"Songti SC","Source Han Serif SC","Noto Serif SC","STSong",Georgia,serif}</style>`;
        let h = html;
        // Convert basic markdown inside hidden data divs
        h = h.replace(
            /(<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/gi,
            (_m, open, content, close) => open + content
                .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                .replace(/\*(.+?)\*/g, "<em>$1</em>")
            + close
        );
        // Patch template JS: .textContent → .innerHTML so <strong>/<em> tags are preserved
        h = h.replace(/\.textContent\.trim\(\)/g, ".innerHTML.trim()");
        // 字体兜底放到文档最前，保证生成页自己的样式能覆盖它（仅剧情模式启用）
        if (serifIframeFallback) h = fontFallback + h;
        if (h.includes("</body>")) h = h.replace("</body>", bridge + "</body>");
        else h = h + bridge;
        return h;
    }, [html, contained, serifIframeFallback]);

    useEffect(() => {
        const handler = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== "object") return;
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
            // 用户在生成页里点了一下：手风琴展开、折叠这类高度暴涨是人主动触发的，
            // 不可能是 vh 自激（那个跟交互无关）。清掉锁与采样窗口，让随后的增高照常生效。
            if (e.data.type === "_rhr_act") {
                feedbackLockRef.current = null;
                recentHeightsRef.current = [];
                return;
            }
            if (e.data.type === "_rhr" && typeof e.data.h === "number") {
                const next = Math.max(e.data.h, 50);
                const lock = feedbackLockRef.current;
                if (lock !== null) {
                    if (next <= lock - 8) {
                        feedbackLockRef.current = null;
                        recentHeightsRef.current = [];
                    } else {
                        return; // 锁定期间忽略继续增高的测量
                    }
                }
                // CSS 过渡/动画进行中：内容每帧变高，形状和 vh 自激一模一样（连续小步递增），
                // 但它会随缓动曲线收敛。拿这些帧去做 runaway 判定必然误伤——一个 0.55s 的
                // max-height 过渡刚跑 6 帧（约 100ms）就会被判失控并锁死高度。
                // 直接跟随测量值，并清空窗口，免得过渡前后的样本被拼成一次假阳性。
                if (e.data.anim === true) {
                    recentHeightsRef.current = [];
                    setHeight(next);
                    return;
                }
                const recent = recentHeightsRef.current;
                // 桥每次变化会连发多条相同高度的消息，去重后再进窗口
                if (recent.length === 0 || recent[recent.length - 1].h !== next) {
                    recent.push({ h: next, t: Date.now() });
                    if (recent.length > 6) recent.shift();
                }
                // 1.2s 内连续 6 次小步幅递增 → 判定为 vh 反馈环（图片逐张加载等
                // 正常增高没有这么高的频率）
                const isRunaway = recent.length === 6
                    && recent[5].t - recent[0].t < 1200
                    && recent.every((v, i) => {
                        if (i === 0) return true;
                        const step = v.h - recent[i - 1].h;
                        return step > 0 && step < 400;
                    });
                if (isRunaway) {
                    // vh 内容想占满视口，锁一个接近整屏的稳定高度而不是初始小值。
                    // .story-stage 只有剧情模式有；栖所等场景退到外层滚动容器，
                    // 再退到整屏——拿整屏当视口会锁出一个比容器还高的值。
                    const viewport = iframeRef.current?.closest(".story-stage")?.clientHeight
                        || iframeRef.current?.parentElement?.clientHeight
                        || (typeof window !== "undefined" ? window.innerHeight : 600);
                    const locked = Math.max(recent[0].h, Math.round(viewport * 0.68));
                    feedbackLockRef.current = locked;
                    setHeight(locked);
                    return;
                }
                setHeight(next);
            }
            if (e.data.type === "_rhr_opt" && typeof e.data.text === "string") {
                onOptionSelect?.(e.data.text);
            }
        };
        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, [onOptionSelect]);

    const frame = (
        <iframe
            ref={iframeRef}
            srcDoc={srcDoc}
            title="HTML content"
            sandbox="allow-scripts"
            style={{
                width: "100%",
                height,
                border: "none",
                display: "block",
                borderRadius: 12,
            }}
        />
    );

    if (!contained) return frame;

    // contained：iframe 按内容全高撑开，滚动交给这个同文档的外层容器
    // （iOS 上 iframe 内部滚动手势不可靠，同文档滚动器则始终可靠）
    return (
        <div style={{
            maxHeight: "min(68vh, 560px)",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
            borderRadius: 12,
        }}>
            {frame}
        </div>
    );
}

// ── Main component ──

export interface StoryHtmlRendererProps {
    content: string;
    messageId: string;
    onOptionSelect?: (text: string) => void;
    htmlPageMode?: "auto" | "contained";
    /** 剧情模式：给 iframe 生成页注入宋体默认字体兜底 */
    serifIframeFallback?: boolean;
    onVoicePlay?: (segment: StoryVoiceSegment) => void;
    playingVoiceSegmentId?: string | null;
    statusRenderHtml?: string;
    theaterRenderHtml?: string;
}

function StoryHtmlRendererInner({ content, messageId, onOptionSelect, htmlPageMode = "auto", serifIframeFallback = false, onVoicePlay, playingVoiceSegmentId, statusRenderHtml, theaterRenderHtml }: StoryHtmlRendererProps) {
    const segments = useMemo(() => splitContent(content), [content]);
    const scopeClass = `smsg-${messageId.slice(-8)}`;
    const containerRef = useRef<HTMLDivElement>(null);
    useActionDelegate(containerRef, onOptionSelect);
    useStoryVoiceDelegate(containerRef, onVoicePlay);
    const voicePrefix = (suffix: string) => onVoicePlay ? `${messageId}:${suffix}` : undefined;

    return (
        <div className="story-richtext" ref={containerRef}>
            {segments.map((seg, i) => {
                if (seg.type === "html-page") {
                    return <HtmlPageSegment key={`hp-${i}`} html={seg.content} onOptionSelect={onOptionSelect} htmlPageMode={htmlPageMode} serifIframeFallback={serifIframeFallback} />;
                }
                if (seg.type === "fold") {
                    const tailKind = seg.label.toLowerCase() === "story_status"
                        ? "status"
                        : seg.label.toLowerCase() === "story_theater"
                            ? "theater"
                            : null;
                    const tailRenderHtml = tailKind === "status" ? statusRenderHtml : tailKind === "theater" ? theaterRenderHtml : "";
                    return (
                        <StoryFoldBlock key={`fold-${i}`} label={tailKind === "status" ? "状态栏" : tailKind === "theater" ? "小剧场" : seg.label} content={seg.content} scopeClass={scopeClass}>
                            {tailKind && tailRenderHtml ? (
                                <CustomStatusFrame
                                    html={tailRenderHtml}
                                    raw={seg.content}
                                    kind={tailKind}
                                    title={tailKind === "status" ? "剧情状态栏" : "剧情小剧场"}
                                />
                            ) : splitContent(seg.content).map((innerSeg, innerIndex) => {
                                if (innerSeg.type === "html-page") {
                                    return <HtmlPageSegment key={`fold-hp-${i}-${innerIndex}`} html={innerSeg.content} onOptionSelect={onOptionSelect} htmlPageMode={htmlPageMode} serifIframeFallback={serifIframeFallback} />;
                                }
                                if (innerSeg.type === "fold") {
                                    return (
                                        <StoryFoldBlock key={`fold-inner-${i}-${innerIndex}`} label={innerSeg.label} content={innerSeg.content} scopeClass={scopeClass}>
                                            <MarkdownSegment content={innerSeg.content} scopeClass={scopeClass} voiceIdPrefix={voicePrefix(`fold:${i}:${innerIndex}`)} playingVoiceSegmentId={playingVoiceSegmentId} />
                                        </StoryFoldBlock>
                                    );
                                }
                                return <MarkdownSegment key={`fold-md-${i}-${innerIndex}`} content={innerSeg.content} scopeClass={scopeClass} voiceIdPrefix={voicePrefix(`fold:${i}:${innerIndex}`)} playingVoiceSegmentId={playingVoiceSegmentId} />;
                            })}
                        </StoryFoldBlock>
                    );
                }
                return <MarkdownSegment key={`md-${i}`} content={seg.content} scopeClass={scopeClass} voiceIdPrefix={voicePrefix(`md:${i}`)} playingVoiceSegmentId={playingVoiceSegmentId} />;
            })}
        </div>
    );
}

export const StoryHtmlRenderer = memo(StoryHtmlRendererInner);
