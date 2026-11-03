import {
  CHAT_MESSAGE_PUSHED_EVENT,
  loadChatMessages,
  bulkUpsertImportedMessages,
  type ChatMessage,
  type ChatSession,
} from "./chat-storage";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "./chat-asset-storage";
import { isMediaStoreRef, loadMediaBlob, storeMediaBlob } from "./media-cache-storage";

type EmbeddedMedia = {
  kind: "media-store" | "image-asset";
  dataUrl: string;
};

type ChatRecordFile = {
  type: "float-chat-records";
  version: 1;
  exportedAt: string;
  session: {
    id: string;
    contactId: string;
    name: string;
    isGroup: boolean;
  };
  messages: ChatMessage[];
  media: Record<string, EmbeddedMedia>;
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("媒体读取失败"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1] || "application/octet-stream" });
  } catch {
    return null;
  }
}

function collectMessageMediaCandidates(messages: ChatMessage[]): Array<{ ref: string; kind: EmbeddedMedia["kind"] }> {
  const candidates = new Map<string, EmbeddedMedia["kind"]>();
  for (const message of messages) {
    const direct = message.mediaUrl;
    if (direct && isMediaStoreRef(direct)) candidates.set(direct, "media-store");
    const generated = message.mediaData?.imageGenerationMediaRef;
    if (generated && isMediaStoreRef(generated)) candidates.set(generated, "media-store");
    const imageAsset = message.mediaData?.xiaohongshuImageAssetId;
    if (imageAsset && !imageAsset.startsWith("http") && !imageAsset.startsWith("data:")) {
      candidates.set(imageAsset, "image-asset");
    }
  }
  return [...candidates].map(([ref, kind]) => ({ ref, kind }));
}

function replaceDeep(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === "string") return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, replacements));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = replaceDeep(entry, replacements);
  }
  return output;
}

function isValidMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return typeof message.id === "string"
    && typeof message.sessionId === "string"
    && typeof message.role === "string"
    && typeof message.content === "string"
    && typeof message.createdAt === "string";
}

export async function createChatRecordExport(session: ChatSession, name: string): Promise<Blob> {
  const messages = loadChatMessages(session.id).map((message) => {
    const clone = JSON.parse(JSON.stringify(message)) as ChatMessage;
    delete clone.isTyping;
    return clone;
  });
  const media: Record<string, EmbeddedMedia> = {};
  for (const candidate of collectMessageMediaCandidates(messages)) {
    if (candidate.kind === "media-store") {
      const stored = await loadMediaBlob(candidate.ref).catch(() => null);
      if (stored) media[candidate.ref] = { kind: candidate.kind, dataUrl: await blobToDataUrl(stored.blob) };
    } else {
      const dataUrl = await getChatImageFromIndexedDB(candidate.ref).catch(() => null);
      if (dataUrl) media[candidate.ref] = { kind: candidate.kind, dataUrl };
    }
  }
  const payload: ChatRecordFile = {
    type: "float-chat-records",
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      id: session.id,
      contactId: session.contactId,
      name,
      isGroup: session.isGroup === true,
    },
    messages,
    media,
  };
  return new Blob([JSON.stringify(payload)], { type: "application/json" });
}

export async function importChatRecordFile(
  file: File,
  targetSession: ChatSession,
): Promise<{ inserted: number; skipped: number; mediaRestored: number }> {
  const parsed = JSON.parse(await file.text()) as Partial<ChatRecordFile>;
  if (parsed.type !== "float-chat-records" || parsed.version !== 1 || !Array.isArray(parsed.messages)) {
    throw new Error("不是有效的 Float 聊天记录文件");
  }
  if (parsed.messages.length > 100_000) throw new Error("聊天记录超过 100000 条，请拆分后再导入");

  const mediaReplacements = new Map<string, string>();
  let mediaRestored = 0;
  for (const [oldRef, entry] of Object.entries(parsed.media || {})) {
    if (!entry || typeof entry !== "object" || typeof entry.dataUrl !== "string") continue;
    const blob = dataUrlToBlob(entry.dataUrl);
    if (!blob) continue;
    const nextRef = entry.kind === "image-asset"
      ? await saveChatImageToIndexedDB(blob)
      : await storeMediaBlob(
          blob,
          blob.type || "application/octet-stream",
          blob.type.startsWith("image/") ? "image" : blob.type.startsWith("audio/") ? "audio" : blob.type.startsWith("video/") ? "video" : "file",
        );
    mediaReplacements.set(oldRef, nextRef);
    mediaRestored += 1;
  }

  const validMessages = parsed.messages.filter(isValidMessage);
  const sourceSessionId = parsed.session?.id || "";
  const idReplacements = new Map<string, string>();
  for (const message of validMessages) {
    const nextId = sourceSessionId === targetSession.id
      ? message.id
      : `import_${targetSession.id}_${message.id}`;
    idReplacements.set(message.id, nextId);
  }
  const allReplacements = new Map([...mediaReplacements, ...idReplacements]);
  const baseOrder = loadChatMessages(targetSession.id).length;
  let skipped = parsed.messages.length - validMessages.length;
  // 先在内存里一次性完成全部字段的改写（媒体引用、消息 ID、目标会话、
  // 顺序号），再交给批量接口统一落库。旧的逐条 upsert 路径每条消息都会
  // 触发全量会话预览重算并对 sessions 表排队一次 clear+bulkPut，几千条
  // 记录就会冻结主线程、堆积上千个清表事务——那是导入后「数据被清空、
  // 小手机变成初始状态」的直接来源。
  const prepared = validMessages.map((source, index) => {
    const replaced = replaceDeep(source, allReplacements) as ChatMessage;
    return {
      ...replaced,
      id: idReplacements.get(source.id) || source.id,
      sessionId: targetSession.id,
      order: baseOrder + index,
      status: source.status || "sent",
    };
  });
  let inserted = 0;
  try {
    const result = await bulkUpsertImportedMessages(prepared);
    inserted = result.insertedCount;
    skipped += result.skippedCount;
  } catch (error) {
    // 落库失败必须如实抛出（批量写入按块提交，重试时已写入的部分会被
    // 自动去重跳过），绝不能吞掉错误让用户以为导入成功、重启后数据消失。
    throw new Error(`聊天记录写入本地数据库失败（已写入的部分在重试时会自动跳过）：${
      error instanceof Error ? error.message : String(error)
    }`, { cause: error });
  }
  if (inserted > 0 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: targetSession.id } }));
    window.dispatchEvent(new CustomEvent(CHAT_MESSAGE_PUSHED_EVENT, { detail: { imported: true, sessionId: targetSession.id } }));
  }
  return { inserted, skipped, mediaRestored };
}
