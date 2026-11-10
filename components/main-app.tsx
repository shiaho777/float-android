"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";


import { MediaMaintenanceScheduler } from "@/components/media-maintenance-scheduler";
import { MemoryConsolidationScheduler } from "@/components/memory-consolidation-scheduler";
import { DesktopShell } from "./desktop-shell";

import { SplashAnimation } from "./splash-animation";
import { MusicProvider } from "@/lib/music-context";
import { hydrateKvDb } from "@/lib/kv-db";
import { startAutoBackupLoop } from "@/lib/auto-backup";
import { evaluateTierAdjustments } from "@/lib/character-tier";
import { getThemeAssetMap, readThemeProfile } from "@/lib/theme-storage";
import { resolveActiveIconSkins, type ThemeProfile } from "@/lib/theme-types";
import { hasPendingMcpOAuthCallback } from "@/lib/mcp-oauth-state";
import { shouldRequestPwaFullscreen } from "@/lib/pwa-display-mode";
import { isPhoneShellMobile } from "@/lib/shell-layout-mode";

const TEXT = {
  loading: "\u52A0\u8F7D\u4E2D...",
};

function SplashScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
  return (
    <main className="app-root splash-root">
      <section
        className="phone-shell-wrap splash-shell-wrap"
        aria-label={TEXT.loading}
      >
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen">
              <SplashAnimation />
              <button
                type="button"
                className={ready ? "splash-enter-button splash-enter-button-show" : "splash-enter-button"}
                onClick={onEnter}
                disabled={!ready}
                aria-label="Enter"
              >
                <ArrowRight size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

type PreparedDesktopTheme = {
  profile: ThemeProfile;
  assets: Record<string, string>;
};

function collectFirstPaintThemeAssetIds(profile: ThemeProfile): string[] {
  const ids = [
    profile.wallpaperAssetId,
    profile.fontAssetId,
    profile.dockSkinAssetId,
    ...Object.values(resolveActiveIconSkins(profile))
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(ids));
}

function preloadImageDataUrl(url: string): Promise<void> {
  if (typeof window === "undefined" || !url.startsWith("data:image/")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (typeof image.decode === "function") {
        void image.decode().catch(() => undefined).finally(resolve);
        return;
      }
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) {
      finish();
    }
  });
}

async function prepareDesktopThemeForFirstPaint(): Promise<PreparedDesktopTheme> {
  const profile = readThemeProfile();
  const assetIds = collectFirstPaintThemeAssetIds(profile);
  const assets = assetIds.length ? await getThemeAssetMap(assetIds) : {};
  await Promise.all(Object.values(assets).map(preloadImageDataUrl));
  return { profile, assets };
}

export function MainApp() {
  const [preparedDesktopTheme, setPreparedDesktopTheme] = useState<PreparedDesktopTheme | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // 申请持久化存储：批准后 iOS/安卓不会再因存储压力擅自回收 IndexedDB
    // （摊主钥匙、聊天记录等都存在里面）。静默尽力而为，被拒也无碍。
    void navigator.storage?.persist?.().catch(() => {});

    void (async () => {
      await hydrateKvDb();
      if (cancelled) return;

      let nextPreparedTheme: PreparedDesktopTheme | null = null;
      try {
        nextPreparedTheme = await prepareDesktopThemeForFirstPaint();
      } catch (error) {
        console.warn("[MainApp] desktop theme preload failed:", error);
      }

      if (cancelled) return;
      setPreparedDesktopTheme(nextPreparedTheme);
      setHydrated(true);
      startAutoBackupLoop();
      evaluateTierAdjustments();
      // 记忆条目的一次性 schema 迁移（幂等、只加标记）。放在启动后 fire-and-forget：
      // 不阻塞首屏，也不进聊天热路径。
      void import("@/lib/memory-migrations")
        .then(m => m.ensureMemorySchemaMigrated())
        .catch(error => console.warn("[MainApp] memory schema migration failed:", error));
      // 筑境/子页返回主界面时跳过一次引导动画（sessionStorage 旗标，重启自动清除）
      const skipSplash = sessionStorage.getItem("pneuma_skip_splash_once") === "1";
      if (skipSplash) sessionStorage.removeItem("pneuma_skip_splash_once");
      if (skipSplash || hasPendingMcpOAuthCallback()) {
        setSplashDismissed(true);
      }
    })();

    // 安卓全屏兜底。是否请求全屏在每次点击时读取，设置切换后无需重载。
    if (!isPhoneShellMobile()) return () => {
      cancelled = true;
    };

    function tryFullscreen() {
      if (!shouldRequestPwaFullscreen()) return;
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      doc.requestFullscreen?.().catch(() => { });
    }
    document.addEventListener("click", tryFullscreen);
    return () => {
      cancelled = true;
      document.removeEventListener("click", tryFullscreen);
    };
  }, []);

  return !splashDismissed ? (
    <SplashScreen ready={hydrated} onEnter={() => setSplashDismissed(true)} />
  ) : (
    <main className="app-root">
      <MusicProvider>
        <DesktopShell
          initialThemeProfile={preparedDesktopTheme?.profile}
          initialThemeAssets={preparedDesktopTheme?.assets}
        />
        <MediaMaintenanceScheduler />
        <MemoryConsolidationScheduler />
      </MusicProvider>
    </main>
  );
}
