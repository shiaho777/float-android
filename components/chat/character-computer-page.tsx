"use client";

// 「TA 的电脑」：翻看某个角色云端电脑（角色电脑 Worker 的 char:<id> 工作区）里的文件。
// 只读视角 + 下载；写入永远由角色自己完成，保持"这是 TA 的电脑"的感觉。
// 排版对齐聊天信息页：menu-group 卡片 + chat-info-icon 彩色圆片 + 默认 menu-label 字号。

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ChevronRight, FileText, Folder, Image as ImageIcon, Loader2 } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { agentComputerRequest, characterWorkspace } from "@/lib/agent-computer";
import { downloadFile as saveFileToDevice } from "@/lib/download-utils";

type Entry = { name: string; dir: boolean };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const TEXT_EXT = /\.(txt|md|markdown|json|js|ts|tsx|css|html|htm|csv|log|xml|yml|yaml|ini|conf)$/i;

function joinPath(base: string, name: string): string {
    return base === "/" ? `/${name}` : `${base}/${name}`;
}

function parentOf(path: string): string {
    const index = path.lastIndexOf("/");
    return index <= 0 ? "/" : path.slice(0, index);
}

function mimeFor(name: string): string {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const map: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
        txt: "text/plain", md: "text/markdown", json: "application/json",
    };
    return map[ext] || "application/octet-stream";
}

const iconStyle = (color: string): CSSProperties => ({ "--icon-color": color } as CSSProperties);

export function CharacterComputerPage({ characterId, characterName, onClose }: {
    characterId: string;
    characterName: string;
    onClose: () => void;
}) {
    const workspace = characterWorkspace(characterId);
    const [path, setPath] = useState("/");
    const [entries, setEntries] = useState<Entry[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [busyFile, setBusyFile] = useState("");
    // 大文件拉取耗时可能超过 iOS 分享卡的用户激活窗口：失败时攥住 blob 待二次点击
    const [readySave, setReadySave] = useState<{ blob: Blob; name: string } | null>(null);
    const [preview, setPreview] = useState<{ name: string; kind: "text" | "image"; content: string; truncated?: boolean } | null>(null);

    const load = useCallback(async (target: string) => {
        setLoading(true);
        setError("");
        try {
            const data = await agentComputerRequest<{ entries: Entry[] }>("list", workspace, { path: target });
            const sorted = [...data.entries].sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name, "zh"));
            setEntries(sorted);
            setPath(target);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [workspace]);

    useEffect(() => { void load("/"); }, [load]);

    const downloadFile = useCallback(async (name: string, fromPath: string) => {
        const filePath = joinPath(fromPath, name);
        setBusyFile(name);
        setError("");
        let blob: Blob | null = null;
        try {
            const data = await agentComputerRequest<{ base64: string }>("read_base64", workspace, { path: filePath });
            const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
            blob = new Blob([bytes], { type: mimeFor(name) });
            // iOS 走系统分享卡、其余平台走常规下载，统一交给家里的下载工具
            await saveFileToDevice(blob, name);
            setReadySave(null);
        } catch (err) {
            if (blob) setReadySave({ blob, name });
            else setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyFile("");
        }
    }, [workspace]);

    const saveReadyFile = async () => {
        if (!readySave) return;
        try {
            await saveFileToDevice(readySave.blob, readySave.name);
            setReadySave(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const openFile = async (name: string) => {
        const filePath = joinPath(path, name);
        // 非图非文本的二进制文件没有预览意义，直接保存
        if (!IMAGE_EXT.test(name) && !TEXT_EXT.test(name)) { void downloadFile(name, path); return; }
        setBusyFile(name);
        setError("");
        try {
            if (IMAGE_EXT.test(name)) {
                const data = await agentComputerRequest<{ base64: string }>("read_base64", workspace, { path: filePath });
                setPreview({ name, kind: "image", content: `data:${mimeFor(name)};base64,${data.base64}` });
            } else {
                const data = await agentComputerRequest<{ content: string; truncated: boolean }>("read", workspace, { path: filePath, maxChars: 50000 });
                setPreview({ name, kind: "text", content: data.content, truncated: data.truncated });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyFile("");
        }
    };

    const atRoot = path === "/";
    const title = atRoot ? `${characterName}的电脑` : (path.split("/").pop() || characterName);

    return (
        <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "var(--c-page-body-bg, #ffffff)" }}>
            <PageShell title={title} onBack={() => { if (atRoot) onClose(); else void load(parentOf(path)); }}>
                <div className="page-menu chat-info-menu" style={{ paddingTop: 12 }}>
                    {readySave && (
                        <div className="menu-group">
                            <button className="menu-item" onClick={() => void saveReadyFile()}>
                                <span className="menu-label" style={{ color: "var(--c-primary, #2563eb)" }}>《{readySave.name}》已就绪 · 点此保存</span>
                            </button>
                        </div>
                    )}
                    {error && (
                        <div className="menu-group">
                            <div className="menu-item"><span className="menu-desc" style={{ color: "var(--c-danger)" }}>{error}</span></div>
                        </div>
                    )}

                    {loading && !entries && (
                        <div style={{ display: "flex", justifyContent: "center", padding: "48px 0" }}>
                            <Loader2 size={20} className="animate-spin" />
                        </div>
                    )}

                    {entries && entries.length > 0 && (
                        <div className="menu-group">
                            {entries.map(entry => (
                                <button key={entry.name} className="menu-item"
                                    onClick={() => entry.dir ? void load(joinPath(path, entry.name)) : void openFile(entry.name)}>
                                    <span className="chat-info-icon" style={iconStyle(entry.dir ? "#e8b339" : IMAGE_EXT.test(entry.name) ? "#7c9a92" : "#5b7b64")}>
                                        {entry.dir
                                            ? <Folder size={22} strokeWidth={1.75} />
                                            : IMAGE_EXT.test(entry.name)
                                                ? <ImageIcon size={22} strokeWidth={1.75} />
                                                : <FileText size={22} strokeWidth={1.75} />}
                                    </span>
                                    <div className="menu-label-group" style={{ minWidth: 0 }}>
                                        <span className="menu-label" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                                        {!entry.dir && <span className="menu-desc">点击查看，可保存</span>}
                                    </div>
                                    <div className="menu-right">
                                        {busyFile === entry.name
                                            ? <Loader2 size={16} className="animate-spin" />
                                            : <ChevronRight size={16} />}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}

                    {entries && entries.length === 0 && !error && (
                        <div style={{ padding: "64px 24px", textAlign: "center" }}>
                            <div style={{ fontSize: 34, marginBottom: 10 }}>💻</div>
                            <div className="menu-label">{atRoot ? "TA 还没有在电脑上存过东西" : "这个文件夹是空的"}</div>
                            <div className="menu-desc" style={{ marginTop: 6 }}>
                                {atRoot ? "等 TA 在聊天里用过自己的电脑，再来看看吧" : ""}
                            </div>
                        </div>
                    )}
                </div>
            </PageShell>

            {preview && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setPreview(null)}>
                    <div className="modal-dialog" data-ui="modal-dialog" style={{ maxHeight: "76vh", display: "flex", flexDirection: "column" }}
                        onClick={event => event.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview.name}</h3>
                        </div>
                        <div className="modal-body" data-ui="modal-body" style={{ overflowY: "auto", minHeight: 0 }}>
                            {preview.kind === "image"
                                ? <img src={preview.content} alt={preview.name} style={{ maxWidth: "100%", borderRadius: 8 }} />
                                : (
                                    <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", fontSize: 14, lineHeight: 1.8, margin: 0 }}>
                                        {preview.content}{preview.truncated ? "\n…（文件较长，完整内容请保存后查看）" : ""}
                                    </pre>
                                )}
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button className="ui-btn" onClick={() => setPreview(null)}>关闭</button>
                            <button className="ui-btn ui-btn-primary" onClick={() => { void downloadFile(preview.name, path); }}>保存</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
