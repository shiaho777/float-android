import type {
    CompositeToolConfig,
    CompositeToolPackageConfig,
    RestToolConfig,
    RestToolPackageConfig,
    McpServerConfig,
    McpDiscoveredTool,
} from "./settings-types";
import {
    findEnabledInternalSubToolDefinition,
    getEnabledInternalCapabilities,
    getInternalCapabilityToolDefinition,
} from "./internal-capability-storage";
import { loadCustomAppToolsForContext, type RegisteredCustomAppExtension } from "./custom-app-sdk-registry";
import type { CustomAppToolDefinition } from "./custom-app-types";
import {
    BUILTIN_PHONE_WORKFLOW_PACKAGE,
    BUILTIN_PHONE_WORKFLOW_PACKAGE_ID,
    BUILTIN_PHONE_WORKFLOWS,
} from "./builtin-phone-workflows";
import { MacroEngine, postProcessTrim } from "./macro-engine";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const REST_TOOLS_KEY = "ai_phone_rest_tools_v1";
const REST_TOOL_PACKAGES_KEY = "ai_phone_rest_tool_packages_v1";
const COMPOSITE_TOOLS_KEY = "ai_phone_composite_tools_v1";
const COMPOSITE_TOOL_PACKAGES_KEY = "ai_phone_composite_tool_packages_v1";
const MCP_SERVERS_KEY = "ai_phone_mcp_servers_v1";
registerKvMigration(REST_TOOLS_KEY);
registerKvMigration(REST_TOOL_PACKAGES_KEY);
registerKvMigration(COMPOSITE_TOOLS_KEY);
registerKvMigration(COMPOSITE_TOOL_PACKAGES_KEY);
registerKvMigration(MCP_SERVERS_KEY);

const LEGACY_AUTO_REST_PACKAGE_IDS = new Set([
    "rest_package_user_default",
    "rest_package_builtin",
    "rest_package_ai_default",
]);

function generateId(prefix: string) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── REST Tools ────────────────────────────────

function normalizeRestTool(tool: RestToolConfig): RestToolConfig {
    const packageId = tool.packageId && !LEGACY_AUTO_REST_PACKAGE_IDS.has(tool.packageId)
        ? tool.packageId
        : undefined;
    return {
        ...tool,
        packageId,
        createdBy: tool.builtIn ? tool.createdBy : (tool.createdBy || "user"),
    };
}

function readStoredRestTools(): RestToolConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(REST_TOOLS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function readStoredRestPackages(): RestToolPackageConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(REST_TOOL_PACKAGES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function normalizeRestPackages(packages: RestToolPackageConfig[]): RestToolPackageConfig[] {
    return packages
        .filter(pkg => !LEGACY_AUTO_REST_PACKAGE_IDS.has(pkg.id))
        .map(pkg => ({
            ...pkg,
            enabled: pkg.enabled !== false,
            createdBy: pkg.builtIn ? pkg.createdBy : (pkg.createdBy || "user"),
        }));
}

export function loadRestToolPackages(): RestToolPackageConfig[] {
    if (typeof window === "undefined") return [];
    // 只读一次：这里原本把存储的 JSON 解析了两遍（一遍取原始值、一遍取规范化结果），
    // 每次调用都要多付一次 parse。
    const raw = readStoredRestPackages();
    const packages = normalizeRestPackages(raw);
    if (JSON.stringify(raw) !== JSON.stringify(packages)) saveRestToolPackages(packages);
    return packages;
}

export function saveRestToolPackages(packages: RestToolPackageConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(REST_TOOL_PACKAGES_KEY, JSON.stringify(normalizeRestPackages(packages)));
}

export function createRestToolPackage(name: string): RestToolPackageConfig {
    const now = Date.now();
    return {
        id: generateId("rest_pkg"),
        name,
        description: "",
        enabled: true,
        createdBy: "user",
        createdAt: now,
        updatedAt: now,
    };
}

// One-time: the web reader still defaults to the server proxy (directFetch:false).
// Older installs may have stored it with the old direct-fetch default.
const BUILTIN_PROXY_MIGRATION_KEY = "migrate_builtin_tools_proxy_v1";
const BUILTIN_PROXY_MIGRATION_IDS = new Set(["builtin_web_reader"]);
function migrateBuiltinToolsToProxy(tools: RestToolConfig[]): RestToolConfig[] {
    if (kvGet(BUILTIN_PROXY_MIGRATION_KEY)) return tools;
    kvSet(BUILTIN_PROXY_MIGRATION_KEY, "1");
    const migrated = tools.map(t => (BUILTIN_PROXY_MIGRATION_IDS.has(t.id) && t.directFetch === true) ? { ...t, directFetch: false } : t);
    if (JSON.stringify(migrated) !== JSON.stringify(tools)) saveRestTools(migrated);
    return migrated;
}

// One-time: search and weather can run directly from the browser and should not
// spend deployment-function credits by default.
const BUILTIN_DIRECT_MIGRATION_KEY = "migrate_builtin_search_weather_direct_v1";
const BUILTIN_DIRECT_MIGRATION_IDS = new Set(["builtin_weather", "builtin_search"]);
function migrateBuiltinToolsToDirect(tools: RestToolConfig[]): RestToolConfig[] {
    if (kvGet(BUILTIN_DIRECT_MIGRATION_KEY)) return tools;
    kvSet(BUILTIN_DIRECT_MIGRATION_KEY, "1");
    const migrated = tools.map(t => (BUILTIN_DIRECT_MIGRATION_IDS.has(t.id) && t.directFetch !== true) ? { ...t, directFetch: true } : t);
    if (JSON.stringify(migrated) !== JSON.stringify(tools)) saveRestTools(migrated);
    return migrated;
}

export function loadRestTools(): RestToolConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const tools = migrateBuiltinToolsToDirect(migrateBuiltinToolsToProxy(readStoredRestTools()));
        // Ensure built-in tools exist
        const normalized = ensureBuiltinTools(tools).map(normalizeRestTool);
        if (JSON.stringify(tools) !== JSON.stringify(normalized)) saveRestTools(normalized);
        loadRestToolPackages();
        return normalized;
    } catch {
        const normalized = ensureBuiltinTools([]).map(normalizeRestTool);
        loadRestToolPackages();
        return normalized;
    }
}

export function saveRestTools(tools: RestToolConfig[]): void {
    if (typeof window === "undefined") return;
    const normalized = ensureBuiltinTools(tools).map(normalizeRestTool);
    kvSet(REST_TOOLS_KEY, JSON.stringify(normalized));
}

export function createRestTool(name: string, packageId?: string): RestToolConfig {
    const now = Date.now();
    return {
        id: generateId("tool"),
        packageId,
        name,
        description: "",
        endpoint: "",
        method: "GET",
        parameterSchema: '{"type":"object","properties":{}}',
        enabled: false,
        createdBy: "user",
        createdAt: now,
        updatedAt: now,
    };
}

// ── Composite Tools ──────────────────────────

function normalizeCompositeTool(tool: CompositeToolConfig): CompositeToolConfig {
    return {
        ...tool,
        steps: Array.isArray(tool.steps) ? tool.steps : [],
        parameterSchema: tool.parameterSchema || '{"type":"object","properties":{}}',
        createdBy: tool.builtIn ? tool.createdBy : (tool.createdBy || "user"),
    };
}

function normalizeCompositePackages(packages: CompositeToolPackageConfig[]): CompositeToolPackageConfig[] {
    return packages.map(pkg => ({
        ...pkg,
        enabled: pkg.enabled !== false,
        createdBy: pkg.builtIn ? pkg.createdBy : (pkg.createdBy || "user"),
    }));
}

const BUILTIN_COMPOSITE_PACKAGE_IDS = new Set([BUILTIN_PHONE_WORKFLOW_PACKAGE_ID]);
const BUILTIN_COMPOSITE_TOOL_IDS = new Set(BUILTIN_PHONE_WORKFLOWS.map(tool => tool.id));

function mergeBuiltinCompositePackages(packages: CompositeToolPackageConfig[]): CompositeToolPackageConfig[] {
    const existingById = new Map(packages.map(pkg => [pkg.id, pkg]));
    const builtins = [BUILTIN_PHONE_WORKFLOW_PACKAGE].map(pkg => {
        const existing = existingById.get(pkg.id);
        return normalizeCompositePackages([{
            ...pkg,
            enabled: existing ? existing.enabled !== false : pkg.enabled !== false,
            createdAt: existing?.createdAt ?? pkg.createdAt,
            updatedAt: existing?.updatedAt ?? pkg.updatedAt,
        }])[0];
    });
    const custom = packages
        .filter(pkg => !BUILTIN_COMPOSITE_PACKAGE_IDS.has(pkg.id))
        .map(pkg => ({ ...pkg, builtIn: false }));
    return [...builtins, ...custom];
}

function mergeBuiltinCompositeTools(tools: CompositeToolConfig[]): CompositeToolConfig[] {
    const existingById = new Map(tools.map(tool => [tool.id, tool]));
    const builtins = BUILTIN_PHONE_WORKFLOWS.map(tool => {
        const existing = existingById.get(tool.id);
        return normalizeCompositeTool({
            ...tool,
            enabled: existing ? existing.enabled !== false : tool.enabled !== false,
            createdAt: existing?.createdAt ?? tool.createdAt,
            updatedAt: existing?.updatedAt ?? tool.updatedAt,
        });
    });
    const custom = tools
        .filter(tool => !BUILTIN_COMPOSITE_TOOL_IDS.has(tool.id))
        .map(tool => ({ ...tool, builtIn: false }));
    return [...builtins, ...custom].map(normalizeCompositeTool);
}

export type ToolNameMacroContext = {
    characterName?: string;
    userName?: string;
};

export function expandToolNameMacros(name: string, context?: ToolNameMacroContext): string {
    if (!name.includes("{{")) return name;
    const engine = new MacroEngine(context?.characterName || "", context?.userName || "用户");
    return postProcessTrim(engine.expand(name));
}

export function toolNameMatches(configuredName: string, requestedName: string, context?: ToolNameMacroContext): boolean {
    if (configuredName === requestedName) return true;
    if (!configuredName.includes("{{")) return false;
    return expandToolNameMacros(configuredName, context) === requestedName;
}

export function loadCompositeToolPackages(): CompositeToolPackageConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(COMPOSITE_TOOL_PACKAGES_KEY);
        const packages = raw ? JSON.parse(raw) : [];
        const normalized = mergeBuiltinCompositePackages(normalizeCompositePackages(packages));
        if (JSON.stringify(packages) !== JSON.stringify(normalized)) saveCompositeToolPackages(normalized);
        return normalized;
    } catch {
        return mergeBuiltinCompositePackages([]);
    }
}

export function saveCompositeToolPackages(packages: CompositeToolPackageConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(COMPOSITE_TOOL_PACKAGES_KEY, JSON.stringify(mergeBuiltinCompositePackages(normalizeCompositePackages(packages))));
}

export function createCompositeToolPackage(name: string): CompositeToolPackageConfig {
    const now = Date.now();
    return {
        id: generateId("composite_pkg"),
        name,
        description: "",
        enabled: true,
        createdBy: "user",
        createdAt: now,
        updatedAt: now,
    };
}

export function loadCompositeTools(): CompositeToolConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(COMPOSITE_TOOLS_KEY);
        const tools = raw ? JSON.parse(raw) : [];
        const normalized = mergeBuiltinCompositeTools(tools.map(normalizeCompositeTool));
        if (JSON.stringify(tools) !== JSON.stringify(normalized)) saveCompositeTools(normalized);
        return normalized;
    } catch {
        return mergeBuiltinCompositeTools([]);
    }
}

export function saveCompositeTools(tools: CompositeToolConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(COMPOSITE_TOOLS_KEY, JSON.stringify(mergeBuiltinCompositeTools(tools.map(normalizeCompositeTool))));
}

export function createCompositeTool(name: string, packageId?: string): CompositeToolConfig {
    const now = Date.now();
    return {
        id: generateId("composite"),
        packageId,
        name,
        description: "",
        parameterSchema: '{"type":"object","properties":{}}',
        steps: [],
        outputTemplate: "",
        enabled: false,
        createdBy: "user",
        createdAt: now,
        updatedAt: now,
    };
}

// ── MCP Servers ───────────────────────────────

export function loadMcpServers(): McpServerConfig[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(MCP_SERVERS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

export function saveMcpServers(servers: McpServerConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(MCP_SERVERS_KEY, JSON.stringify(servers));
}

export function createMcpServer(name: string, url: string): McpServerConfig {
    const now = Date.now();
    return {
        id: generateId("mcp"),
        name,
        url,
        enabled: false,
        createdAt: now,
        updatedAt: now,
    };
}

// ── Unified enabled tools (for prompt injection) ──

export type EnabledTool = {
    name: string;
    description: string;
    parameterSchema: string;
    usageGuide?: string;
    source: "rest" | "rest_package" | "composite" | "composite_package" | "mcp" | "mcp_server" | "internal" | "custom_app" | "custom_app_package";
    sourceId: string;       // RestToolConfig.id or McpServerConfig.id
    customAppId?: string;
    customAppName?: string;
    customToolId?: string;
    customAppTools?: Array<RegisteredCustomAppExtension<CustomAppToolDefinition>>;
    restTools?: RestToolConfig[];
    compositeTools?: CompositeToolConfig[];
    mcpTools?: McpDiscoveredTool[];
};

export function getEnabledTools(appId?: string): EnabledTool[] {
    const tools: EnabledTool[] = [];

    const restTools = loadRestTools();
    const restPackages = loadRestToolPackages();
    const restPackageIds = new Set(restPackages.map(pkg => pkg.id));
    const compositeTools = loadCompositeTools();
    const compositePackages = loadCompositeToolPackages();
    const compositePackageIds = new Set(compositePackages.map(pkg => pkg.id));

    for (const t of restTools) {
        if (!t.enabled) continue;
        if (t.packageId && restPackageIds.has(t.packageId)) continue;
        tools.push({
            name: t.name,
            description: t.description,
            parameterSchema: t.parameterSchema,
            source: "rest",
            sourceId: t.id,
        });
    }

    for (const pkg of restPackages) {
        if (!pkg.enabled) continue;
        const children = restTools.filter(tool => tool.enabled && tool.packageId === pkg.id);
        if (children.length === 0) continue;
        tools.push({
            name: pkg.name,
            description: pkg.description || `${children.length} 个 REST 工具`,
            parameterSchema: "{}",
            source: "rest_package",
            sourceId: pkg.id,
            restTools: children,
        });
    }

    for (const t of compositeTools) {
        if (!t.enabled) continue;
        if (t.packageId && compositePackageIds.has(t.packageId)) continue;
        tools.push({
            name: t.name,
            description: t.description,
            parameterSchema: t.parameterSchema,
            source: "composite",
            sourceId: t.id,
        });
    }

    for (const pkg of compositePackages) {
        if (!pkg.enabled) continue;
        const children = compositeTools.filter(tool => tool.enabled && tool.packageId === pkg.id);
        if (children.length === 0) continue;
        tools.push({
            name: pkg.name,
            description: pkg.description || `${children.length} 个组合工具`,
            parameterSchema: "{}",
            source: "composite_package",
            sourceId: pkg.id,
            compositeTools: children,
        });
    }

    for (const s of loadMcpServers()) {
        if (!s.enabled) continue;
        const discoveredCount = s.discoveredTools?.length || 0;
        tools.push({
            name: s.name,
            description: s.description || (discoveredCount > 0 ? `${discoveredCount} 个 MCP 工具` : "MCP 工具服务器"),
            parameterSchema: "{}",
            source: "mcp_server",
            sourceId: s.id,
            mcpTools: s.discoveredTools || [],
        });
    }

    for (const capability of getEnabledInternalCapabilities(appId)) {
        const tool = getInternalCapabilityToolDefinition(capability);
        if (!tool) continue;
        tools.push({
            name: tool.name,
            description: tool.description,
            parameterSchema: tool.parameterSchema,
            usageGuide: tool.usageGuide,
            source: "internal",
            sourceId: capability.id,
        });
    }

    const customAppToolGroups = new Map<string, Array<RegisteredCustomAppExtension<CustomAppToolDefinition>>>();
    for (const tool of loadCustomAppToolsForContext(appId)) {
        const group = customAppToolGroups.get(tool.appId) ?? [];
        group.push(tool);
        customAppToolGroups.set(tool.appId, group);
    }
    for (const group of customAppToolGroups.values()) {
        if (group.length === 1) {
            const tool = group[0];
            tools.push({
                name: tool.name,
                description: tool.description || `来自「${tool.appName}」的自定义 APP 工具`,
                parameterSchema: JSON.stringify(tool.parameterSchema || { type: "object", properties: {} }),
                usageGuide: tool.usageGuide,
                source: "custom_app",
                sourceId: `${tool.appId}:${tool.id}`,
                customAppId: tool.appId,
                customAppName: tool.appName,
                customToolId: tool.id,
            });
            continue;
        }
        const first = group[0];
        tools.push({
            name: `${first.appName}工具`,
            description: `来自「${first.appName}」的 ${group.length} 个自定义 APP 工具`,
            parameterSchema: "{}",
            source: "custom_app_package",
            sourceId: first.appId,
            customAppId: first.appId,
            customAppName: first.appName,
            customAppTools: group,
        });
    }

    return tools;
}

export function findEnabledToolForSchema(name: string, appId?: string, macroContext?: ToolNameMacroContext): EnabledTool | undefined {
    const direct = getEnabledTools(appId).find(t => toolNameMatches(t.name, name, macroContext));
    if (direct) return direct;

    const compositePackages = loadCompositeToolPackages().filter(pkg => pkg.enabled);
    const compositePackageIds = new Set(compositePackages.map(pkg => pkg.id));
    for (const tool of loadCompositeTools()) {
        if (!tool.enabled || !tool.packageId || !compositePackageIds.has(tool.packageId)) continue;
        if (!toolNameMatches(tool.name, name, macroContext)) continue;
        return {
            name: tool.name,
            description: tool.description,
            parameterSchema: tool.parameterSchema,
            source: "composite",
            sourceId: tool.id,
        };
    }

    const packages = loadRestToolPackages().filter(pkg => pkg.enabled);
    const packageIds = new Set(packages.map(pkg => pkg.id));
    for (const tool of loadRestTools()) {
        if (!tool.enabled || !tool.packageId || !packageIds.has(tool.packageId)) continue;
        if (!toolNameMatches(tool.name, name, macroContext)) continue;
        return {
            name: tool.name,
            description: tool.description,
            parameterSchema: tool.parameterSchema,
            source: "rest",
            sourceId: tool.id,
        };
    }

    const internalSubTool = findEnabledInternalSubToolDefinition(name, appId);
    if (internalSubTool) {
        return {
            name: internalSubTool.tool.name,
            description: internalSubTool.tool.description,
            parameterSchema: internalSubTool.tool.parameterSchema,
            usageGuide: internalSubTool.tool.usageGuide,
            source: "internal",
            sourceId: internalSubTool.capability.id,
        };
    }

    for (const s of loadMcpServers()) {
        if (!s.enabled || !s.discoveredTools) continue;
        const tool = s.discoveredTools.find(t => t.name === name);
        if (!tool) continue;
        return {
            name: tool.name,
            description: tool.description || "",
            parameterSchema: JSON.stringify(tool.inputSchema || {}),
            source: "mcp",
            sourceId: s.id,
        };
    }

    for (const tool of loadCustomAppToolsForContext(appId)) {
        if (!toolNameMatches(tool.name, name, macroContext)) continue;
        return {
            name: tool.name,
            description: tool.description || `来自「${tool.appName}」的自定义 APP 工具`,
            parameterSchema: JSON.stringify(tool.parameterSchema || { type: "object", properties: {} }),
            usageGuide: tool.usageGuide,
            source: "custom_app",
            sourceId: `${tool.appId}:${tool.id}`,
            customAppId: tool.appId,
            customAppName: tool.appName,
            customToolId: tool.id,
        };
    }
    return undefined;
}

// ── Built-in tools ────────────────────────────

const BUILTIN_WEB_READER: RestToolConfig = {
    id: "builtin_web_reader",
    name: "查看网页",
    description: "使用 Jina Reader 读取网页 URL 并返回正文",
    endpoint: "https://r.jina.ai/{{{url}}}",
    method: "GET",
    parameterSchema: JSON.stringify({
        type: "object",
        properties: {
            url: { type: "string", description: "完整的网页URL，包含 http 或 https" },
        },
        required: ["url"],
    }),
    directFetch: false,
    enabled: true,
    builtIn: true,
    createdBy: "ai",
    createdAt: 0,
    updatedAt: 0,
};

const BUILTIN_WEATHER: RestToolConfig = {
    id: "builtin_weather",
    name: "天气查询",
    description: "查询指定城市的实时天气信息",
    endpoint: "https://api.weatherapi.com/v1/current.json",
    method: "GET",
    parameterSchema: JSON.stringify({
        type: "object",
        properties: {
            q: { type: "string", description: "城市名，如「上海」「Beijing」" },
        },
    }),
    fixedParams: { key: "" },  // 用户需在设置中填入 WeatherAPI Key
    directFetch: true,
    enabled: false,
    builtIn: true,
    createdAt: 0,
    updatedAt: 0,
};

const BUILTIN_SEARCH: RestToolConfig = {
    id: "builtin_search",
    name: "搜索",
    description: "搜索互联网获取最新信息",
    endpoint: "https://api.tavily.com/search",
    method: "POST",
    parameterSchema: JSON.stringify({
        type: "object",
        properties: {
            query: { type: "string", description: "搜索关键词" },
        },
    }),
    fixedParams: { api_key: "" },  // 用户需在设置中填入 Tavily API Key
    directFetch: true,
    enabled: false,
    builtIn: true,
    createdAt: 0,
    updatedAt: 0,
};

const BUILTIN_REST_TOOLS: RestToolConfig[] = [
    BUILTIN_WEB_READER,
    BUILTIN_WEATHER,
    BUILTIN_SEARCH,
];

function mergeBuiltinRestTool(existing: RestToolConfig | undefined, builtin: RestToolConfig): RestToolConfig {
    if (!existing) return builtin;
    return {
        ...builtin,
        ...existing,
        id: builtin.id,
        builtIn: true,
        createdBy: existing.createdBy || builtin.createdBy,
        createdAt: existing.createdAt ?? builtin.createdAt,
        updatedAt: existing.updatedAt ?? builtin.updatedAt,
    };
}

function ensureBuiltinTools(tools: RestToolConfig[]): RestToolConfig[] {
    const builtinIds = new Set(BUILTIN_REST_TOOLS.map(tool => tool.id));
    const existingBuiltins = new Map(tools.filter(tool => builtinIds.has(tool.id)).map(tool => [tool.id, tool]));
    const builtinBlock = BUILTIN_REST_TOOLS.map(builtin => mergeBuiltinRestTool(existingBuiltins.get(builtin.id), builtin));
    const firstBuiltinIndex = tools.findIndex(tool => builtinIds.has(tool.id));

    if (firstBuiltinIndex < 0) return [...tools, ...builtinBlock];

    const before = tools.slice(0, firstBuiltinIndex).filter(tool => !builtinIds.has(tool.id));
    const after = tools.slice(firstBuiltinIndex).filter(tool => !builtinIds.has(tool.id));
    return [...before, ...builtinBlock, ...after];
}
