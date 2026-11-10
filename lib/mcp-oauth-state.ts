// MCP OAuth 流程的本地持久化状态。
// 单独成模块：启动时 main-app 只需判断"是否有待完成的授权回调"，
// 不应为此把整个 tool-executor 拖进启动包。

export type McpOAuthPendingState = {
    state: string;
    serverId: string;
    serverName: string;
    serverDescription?: string;
    serverUrl: string;
    serverEnabled: boolean;
    serverHeaders?: Record<string, string>;
    redirectUri: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    authorizationServerUrl?: string;
    protectedResourceMetadataUrl?: string;
    createdAt: number;
};

export type McpOAuthCallbackState = {
    state: string;
    code?: string;
    error?: string;
    createdAt: number;
};

export const MCP_OAUTH_PENDING_STORAGE_KEY = "ai_phone_mcp_oauth_pending_v1";
export const MCP_OAUTH_CALLBACK_STORAGE_KEY = "ai_phone_mcp_oauth_callback_v1";

export function readStorageJson<T>(key: string): T | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

export function writeStorageJson(key: string, value: unknown): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore storage failures */ }
}

export function removeStorageKey(key: string): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(key);
    } catch { /* ignore storage failures */ }
}

export function hasPendingMcpOAuthCallback(): boolean {
    const pending = readStorageJson<McpOAuthPendingState>(MCP_OAUTH_PENDING_STORAGE_KEY);
    const callback = readStorageJson<McpOAuthCallbackState>(MCP_OAUTH_CALLBACK_STORAGE_KEY);
    return Boolean(pending?.state && callback?.state && pending.state === callback.state);
}
