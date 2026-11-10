"use client";

// 工坊文件卡：小坊用「电脑文件 op=send」交付文件时，工具行下方出现的卡片。
// 内容按需从角色电脑 Worker 拉取（不占本地存储），支持预览（文本/图片）与保存。

import { useState } from "react";
import { Download, Eye, FileText, Loader2 } from "lucide-react";
import { agentComputerRequest } from "@/lib/agent-computer";
import { downloadFile } from "@/lib/download-utils";
import type { QaFileCardInfo } from "@/lib/qa-computer-tools";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const HTML_EXT = /\.(html?)$/i;
const TEXT_EXT = /\.(txt|md|markdown|json|js|ts|tsx|css|html|htm|csv|log|xml|yml|yaml|ini|conf|mjs)$/i;

function mimeFor(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
        txt: "text/plain", md: "text/markdown", json: "application/json",
        html: "text/html", htm: "text/html",
    };
    return map[ext] || "application/octet-stream";
}

export function QaFileCard({ file }: { file: QaFileCardInfo }) {
    const [busy, setBusy] = useState<"" | "view" | "save">("");
    const [error, setError] = useState("");
    // 大文件拉取耗时可能超过 iOS 分享卡的用户激活窗口：失败时攥住 blob，
    // 让用户再点一次（新激活）直接弹分享——与数据导出的两段式同一思路
    const [ready, setReady] = useState<{ blob: Blob; name: string } | null>(null);
    const [preview, setPreview] = useState<{ kind: "text" | "image" | "html"; content: string; truncated?: boolean } | null>(null);
    // HTML 预览默认渲染网页，可切到源码
    const [htmlSourceView, setHtmlSourceView] = useState(false);
    const previewable = IMAGE_EXT.test(file.name) || TEXT_EXT.test(file.name);

    const save = async () => {
        setBusy("save");
        setError("");
        let blob: Blob | null = null;
        try {
            const data = await agentComputerRequest<{ base64: string }>("read_base64", file.workspace, { path: file.path });
            const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
            blob = new Blob([bytes], { type: mimeFor(file.name) });
            // iOS 走系统分享卡、其余平台走常规下载，统一交给家里的下载工具
            await downloadFile(blob, file.name);
            setReady(null);
        } catch (err) {
            if (blob) {
                setReady({ blob, name: file.name });
            } else {
                setError(err instanceof Error ? err.message : String(err));
            }
        } finally {
            setBusy("");
        }
    };

    const saveReady = async () => {
        if (!ready) return;
        try {
            await downloadFile(ready.blob, ready.name);
            setReady(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const view = async () => {
        if (!previewable) { void save(); return; }
        setBusy("view");
        setError("");
        try {
            if (IMAGE_EXT.test(file.name)) {
                const data = await agentComputerRequest<{ base64: string }>("read_base64", file.workspace, { path: file.path });
                setPreview({ kind: "image", content: `data:${mimeFor(file.name)};base64,${data.base64}` });
            } else if (HTML_EXT.test(file.name)) {
                // 走 base64 拿完整内容再解码：文本接口有截断，HTML 截断会渲染成残页
                const data = await agentComputerRequest<{ base64: string }>("read_base64", file.workspace, { path: file.path });
                const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
                setHtmlSourceView(false);
                setPreview({ kind: "html", content: new TextDecoder().decode(bytes) });
            } else {
                const data = await agentComputerRequest<{ content: string; truncated: boolean }>("read", file.workspace, { path: file.path, maxChars: 50000 });
                setPreview({ kind: "text", content: data.content, truncated: data.truncated });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy("");
        }
    };

    return (
        <div className="qa-file-card">
            <button type="button" className="qa-file-card-main" onClick={() => void view()}>
                <span className="qa-file-card-icon"><FileText size={18} /></span>
                <span className="qa-file-card-name">{file.name}</span>
            </button>
            <div className="qa-file-card-actions">
                {previewable && (
                    <button type="button" className="qa-file-card-btn" aria-label="查看" onClick={() => void view()}>
                        {busy === "view" ? <Loader2 size={15} className="qa-spin" /> : <Eye size={15} />}
                    </button>
                )}
                <button type="button" className="qa-file-card-btn" aria-label="保存" onClick={() => void save()}>
                    {busy === "save" ? <Loader2 size={15} className="qa-spin" /> : <Download size={15} />}
                </button>
            </div>
            {ready && (
                <button type="button" className="qa-file-card-ready" onClick={() => void saveReady()}>
                    文件已就绪 · 点此保存
                </button>
            )}
            {error && <div className="qa-file-card-error">{error}</div>}

            {preview && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setPreview(null)}>
                    <div className="modal-dialog" data-ui="modal-dialog" style={{ maxHeight: "76vh", display: "flex", flexDirection: "column" }}
                        onClick={event => event.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</h3>
                        </div>
                        <div className="modal-body" data-ui="modal-body" style={{ overflowY: "auto", minHeight: 0, ...(preview.kind === "html" && !htmlSourceView ? { padding: 0, display: "flex" } : null) }}>
                            {preview.kind === "image" ? (
                                <img src={preview.content} alt={file.name} style={{ maxWidth: "100%", borderRadius: 8 }} />
                            ) : preview.kind === "html" && !htmlSourceView ? (
                                <iframe
                                    title={file.name}
                                    sandbox="allow-scripts"
                                    srcDoc={preview.content}
                                    style={{ border: 0, width: "100%", height: "56vh", flex: 1, background: "#fff", borderRadius: 8 }}
                                />
                            ) : (
                                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: 14, lineHeight: 1.8, margin: 0 }}>
                                    {preview.content}{preview.truncated ? "\n…（文件较长，完整内容请保存后查看）" : ""}
                                </pre>
                            )}
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            {preview.kind === "html" && (
                                <button className="ui-btn" onClick={() => setHtmlSourceView(v => !v)}>
                                    {htmlSourceView ? "预览网页" : "查看源码"}
                                </button>
                            )}
                            <button className="ui-btn" onClick={() => setPreview(null)}>关闭</button>
                            <button className="ui-btn ui-btn-primary" onClick={() => void save()}>保存</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
