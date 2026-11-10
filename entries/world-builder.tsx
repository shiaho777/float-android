// 筑境入口（原 app/world-builder/layout.tsx + page.tsx 的合并）。
// 独立窗口/页面加载，不在主 React 树内。

import { createRoot } from "react-dom/client";

import WorldBuilder from "@/components/world-builder/WorldBuilder";
import { AndroidFullscreen } from "@/components/android-fullscreen";
import { installShellLayoutMode } from "@/lib/shell-layout-mode";

import "../app/globals.css";

installShellLayoutMode();

createRoot(document.getElementById("root")!).render(
    <>
        <style>{`html,body{background:#121110!important;color-scheme:dark}`}</style>
        <AndroidFullscreen />
        <WorldBuilder />
    </>,
);
