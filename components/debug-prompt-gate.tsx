"use client";

import { lazy, Suspense, useEffect, useState } from "react";

import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings } from "@/lib/chat-storage";

// 提示词查看器依赖几乎所有 App 的引擎（查手机、小红书、共创、采访、地图冒险……），
// 静态导入会把它们全部拖进启动包。这里只监听开关，开启后才按需加载完整面板。
const DebugPromptPanel = lazy(() => import("@/components/debug-prompt-panel").then(m => ({ default: m.DebugPromptPanel })));

function readPromptViewerEnabled(event?: Event): boolean {
    const detail = (event as CustomEvent | undefined)?.detail;
    if (typeof detail?.promptViewerEnabled === "boolean") return detail.promptViewerEnabled;
    return loadChatAppSettings().promptViewerEnabled === true;
}

export function DebugPromptGate() {
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        const sync = (event?: Event) => setEnabled(readPromptViewerEnabled(event));
        sync();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, sync);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, sync);
    }, []);

    if (!enabled) return null;
    return (
        <Suspense fallback={null}>
            <DebugPromptPanel />
        </Suspense>
    );
}
