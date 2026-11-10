// Tripo3D v2 官方 REST API 直连客户端（纯本地版：无服务端中转）。
// Android 走原生 OkHttp 无 CORS 限制；浏览器端需要 api.tripo3d.ai 允许跨域，
// 否则调用方会拿到 TypeError，由 UI 提示「直连失败」。

import { httpFetch } from "@/lib/native-http";

const TRIPO_API_BASE = "https://api.tripo3d.ai/v2/openapi";

type TripoErrorPayload = { code?: number; message?: string; suggestion?: string };

async function tripoRequest(
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await httpFetch(`${TRIPO_API_BASE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey.trim()}`, ...(init.headers || {}) },
    });
  } catch (error) {
    throw new Error(
      `Tripo API 直连失败（可能不允许跨域）：${error instanceof Error ? error.message : String(error)}`, { cause: error }
    );
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown> & TripoErrorPayload;
  const code = typeof data.code === "number" ? data.code : undefined;
  if (!res.ok || (code !== undefined && code !== 0)) {
    throw new Error(data.message || `Tripo API 错误 (HTTP ${res.status}${code !== undefined ? `, code ${code}` : ""})`);
  }
  return data;
}

function imageFileType(file: File): string {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "bmp", "gif"].includes(ext)) return ext;
  const mime = file.type.toLowerCase();
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

export async function tripoVerifyKey(apiKey: string): Promise<{ ok: boolean; balance?: number }> {
  const data = await tripoRequest(apiKey, "/user/balance", { method: "GET" });
  const inner = (data.data ?? {}) as Record<string, unknown>;
  return { ok: true, balance: typeof inner.balance === "number" ? inner.balance : undefined };
}

export async function tripoUploadImage(apiKey: string, file: File): Promise<{ token: string; type: string }> {
  const form = new FormData();
  form.set("file", file, file.name || `image.${imageFileType(file)}`);
  const data = await tripoRequest(apiKey, "/upload", { method: "POST", body: form });
  const inner = (data.data ?? {}) as Record<string, unknown>;
  const token = inner.image_token ?? inner.file_token;
  if (typeof token !== "string" || !token) throw new Error("图片上传成功但未返回 image_token");
  return { token, type: imageFileType(file) };
}

export type TripoTaskStatusResult = {
  status?: string;
  progress?: number;
  modelUrl?: string;
  error?: string;
};

export async function tripoCreateTask(apiKey: string, body: Record<string, unknown>): Promise<string> {
  const data = await tripoRequest(apiKey, "/task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const inner = (data.data ?? {}) as Record<string, unknown>;
  const taskId = inner.task_id;
  if (typeof taskId !== "string" || !taskId) throw new Error("未返回 task_id");
  return taskId;
}

export async function tripoTaskStatus(apiKey: string, taskId: string): Promise<TripoTaskStatusResult> {
  const data = await tripoRequest(apiKey, `/task/${encodeURIComponent(taskId)}`, { method: "GET" });
  const inner = (data.data ?? {}) as Record<string, unknown>;
  const output = (inner.output ?? {}) as Record<string, unknown>;
  const modelUrl = [output.pbr_model, output.model, output.base_model]
    .find((v): v is string => typeof v === "string" && Boolean(v));
  return {
    status: typeof inner.status === "string" ? inner.status : undefined,
    progress: typeof inner.progress === "number" ? inner.progress : undefined,
    modelUrl,
    error: typeof inner.error === "string" ? inner.error
      : (inner.error && typeof inner.error === "object" ? String((inner.error as Record<string, unknown>).message ?? "") : undefined),
  };
}
