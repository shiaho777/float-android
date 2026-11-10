// 角色中心入口（原 app/characters/page.tsx）。

import { createRoot } from "react-dom/client";

import { installShellLayoutMode } from "@/lib/shell-layout-mode";

import "../app/globals.css";

installShellLayoutMode();

createRoot(document.getElementById("root")!).render(
    <main className="page-frame">
        <p>角色中心页面重做中，敬请期待。</p>
    </main>,
);
