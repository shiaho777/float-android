// 主入口（原 app/layout.tsx + app/page.tsx 的合并）。
// 纯浏览器渲染，无 SSR——Vite 多页构建的 / 页面。

import { createRoot } from "react-dom/client";

import { installWriteFlushListeners } from "@/lib/pending-writes";
import { installShellLayoutMode } from "@/lib/shell-layout-mode";
import { migrateLegacyLocalStorageKeys } from "@/lib/legacy-brand-migration";
import { ChatPluginBootstrap } from "@/components/chat-plugin-bootstrap";
import { ChatReasoningVisibilityController } from "@/components/chat-reasoning-visibility-controller";
import { PWAManifestInjector } from "@/components/pwa-manifest-injector";
import { MainApp } from "@/components/main-app";

import "../app/globals.css";

// Float 时代的 localStorage 键搬到 Pneuma 键名，须在任何模块读取前完成
migrateLegacyLocalStorageKeys();

// 页面隐藏/被杀前把在途 IndexedDB 写事务排空（缩掉丢数据窗口）
installWriteFlushListeners();

// 手机壳布局判定挂到 <html> class——原生壳恒全屏，不再依赖 hover/pointer 媒体特性
installShellLayoutMode();

createRoot(document.getElementById("root")!).render(
    <>
        <PWAManifestInjector />
        <ChatPluginBootstrap />
        <ChatReasoningVisibilityController />
        <MainApp />
    </>,
);
