import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// NEXT_PUBLIC_* 在浏览器代码里以 process.env 引用，构建时静态替换（与 Next 行为一致）。
const PUBLIC_ENV_KEYS = [
    "NEXT_PUBLIC_SELF_HOSTED_MODE",
    "NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE",
    "NEXT_PUBLIC_LEGACY_NETEASE_API_BASES",
    "NEXT_PUBLIC_NETEASE_REAL_IP",
    "NEXT_PUBLIC_IMAGE_GEN_PROXY_URL",
] as const;

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, projectRoot, "");
    const define: Record<string, string> = {};
    for (const key of PUBLIC_ENV_KEYS) {
        define[`process.env.${key}`] = JSON.stringify(env[key] ?? "");
    }
    return {
        plugins: [react()],
        resolve: {
            alias: {
                "@": projectRoot,
            },
        },
        define,
        server: { port: 3001 },
        preview: { port: 3001 },
        build: {
            // 保持 out/ 不变：capacitor.config.ts 的 webDir 与打包流程无需改动。
            outDir: "out",
            rollupOptions: {
                input: {
                    main: path.join(projectRoot, "index.html"),
                    characters: path.join(projectRoot, "characters/index.html"),
                },
                output: {
                    // 大 vendor 独立 chunk：多文件脚本在 V8 里可并行编译，降低冷启动主线程阻塞。
                    manualChunks(id) {
                        // vite 运行时 helper（modulepreload 等）被所有 lazy chunk 依赖——
                        // 若落在某个大 vendor chunk 里，主入口会被迫 preload 整个 chunk。
                        if (id.includes("preload-helper") || id.includes("vite/modulepreload")) return "vendor-runtime";
                        if (!id.includes("node_modules")) return;
                        if (/\/react-dom\/|\/react\//.test(id)) return "vendor-react";
                        if (id.includes("dexie")) return "vendor-dexie";
                        if (/(react-markdown|marked|remark-|rehype-|micromark|mdast|hast|unified|dompurify|vfile|decode-named|trim-lines|property-information|space-separated|comma-separated|html-url-attributes|devlop)/.test(id)) return "vendor-markdown";
                        if (id.includes("lucide-react") || id.includes("@phosphor") || id.includes("@mdi") || id.includes("@heroicons")) return "vendor-icons";
                        if (id.includes("jszip")) return "vendor-jszip";
                    },
                },
            },
        },
    };
});
