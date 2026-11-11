"use client";

/**
 * 查手机里 23 个子 App 的懒加载入口。
 *
 * 这些页面以前是 checkphone-app.tsx 的静态 import，打开「查手机」时会把
 * 23 个页面的 JS 一次性拉进来（首个 chunk 356KB）。而一次只会打开一个子 App，
 * 所以改成按需加载：点桌面图标时才取对应 chunk；进桌面后在空闲时段按当前
 * manifest 预取，用户真正点开时通常已经就绪。
 */

import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { Character } from "@/lib/character-types";
import type { CheckPhoneAppId } from "@/lib/checkphone-config";

export type CheckPhoneEmbeddedPageProps = {
  character: Character;
  onBack: () => void;
};

/** 有独立页面的子 App。顺序与桌面/清单无关，仅用于类型收窄。 */
export const CHECKPHONE_EMBEDDED_APP_IDS = [
  "chat",
  "phone",
  "notes",
  "shopping",
  "assets",
  "photos",
  "browser",
  "messages",
  "music",
  "reading",
  "weibo",
  "xiaohongshu",
  "email",
  "douyin",
  "takeout",
  "telegram",
  "steam",
  "x",
  "reddit",
  "youtube",
  "instagram",
  "bilibili",
  "douban",
] as const satisfies CheckPhoneAppId[];

export type CheckPhoneEmbeddedAppId = (typeof CHECKPHONE_EMBEDDED_APP_IDS)[number];

type PageModule = Record<string, unknown>;

const loaders: Record<CheckPhoneEmbeddedAppId, () => Promise<PageModule>> = {
  chat: () => import("@/components/checkphone/checkphone-chat-page"),
  phone: () => import("@/components/checkphone/checkphone-phone-page"),
  notes: () => import("@/components/checkphone/checkphone-notes-page"),
  shopping: () => import("@/components/checkphone/checkphone-shopping-page"),
  assets: () => import("@/components/checkphone/checkphone-assets-page"),
  photos: () => import("@/components/checkphone/checkphone-photos-page"),
  browser: () => import("@/components/checkphone/checkphone-browser-page"),
  messages: () => import("@/components/checkphone/checkphone-messages-page"),
  music: () => import("@/components/checkphone/checkphone-music-page"),
  reading: () => import("@/components/checkphone/checkphone-reading-page"),
  weibo: () => import("@/components/checkphone/checkphone-weibo-page"),
  xiaohongshu: () => import("@/components/checkphone/checkphone-xiaohongshu-page"),
  email: () => import("@/components/checkphone/checkphone-email-page"),
  douyin: () => import("@/components/checkphone/checkphone-douyin-page"),
  takeout: () => import("@/components/checkphone/checkphone-takeout-page"),
  telegram: () => import("@/components/checkphone/checkphone-telegram-page"),
  steam: () => import("@/components/checkphone/checkphone-steam-page"),
  x: () => import("@/components/checkphone/checkphone-x-page"),
  reddit: () => import("@/components/checkphone/checkphone-reddit-page"),
  youtube: () => import("@/components/checkphone/checkphone-youtube-page"),
  instagram: () => import("@/components/checkphone/checkphone-instagram-page"),
  bilibili: () => import("@/components/checkphone/checkphone-bilibili-page"),
  douban: () => import("@/components/checkphone/checkphone-douban-page"),
};

/**
 * 页面模块导出的是具名组件，而 React.lazy 要 default。
 * 这个包装把「取模块 + 挑导出」收成一行，避免 23 段几乎相同的样板。
 */
function lazyPage(
  id: CheckPhoneEmbeddedAppId,
  exportName: string,
): LazyExoticComponent<ComponentType<CheckPhoneEmbeddedPageProps>> {
  return lazy(async () => {
    const mod = await loaders[id]();
    const component = mod[exportName] as ComponentType<CheckPhoneEmbeddedPageProps>;
    return { default: component };
  });
}

export const CHECKPHONE_EMBEDDED_PAGES: Record<
  CheckPhoneEmbeddedAppId,
  ComponentType<CheckPhoneEmbeddedPageProps>
> = {
  chat: lazyPage("chat", "CheckPhoneChatPage"),
  phone: lazyPage("phone", "CheckPhonePhonePage"),
  notes: lazyPage("notes", "CheckPhoneNotesPage"),
  shopping: lazyPage("shopping", "CheckPhoneShoppingPage"),
  assets: lazyPage("assets", "CheckPhoneAssetsPage"),
  photos: lazyPage("photos", "CheckPhonePhotosPage"),
  browser: lazyPage("browser", "CheckPhoneBrowserPage"),
  messages: lazyPage("messages", "CheckPhoneMessagesPage"),
  music: lazyPage("music", "CheckPhoneMusicPage"),
  reading: lazyPage("reading", "CheckPhoneReadingPage"),
  weibo: lazyPage("weibo", "CheckPhoneWeiboPage"),
  xiaohongshu: lazyPage("xiaohongshu", "CheckPhoneXiaohongshuPage"),
  email: lazyPage("email", "CheckPhoneEmailPage"),
  douyin: lazyPage("douyin", "CheckPhoneDouyinPage"),
  takeout: lazyPage("takeout", "CheckPhoneTakeoutPage"),
  telegram: lazyPage("telegram", "CheckPhoneTelegramPage"),
  steam: lazyPage("steam", "CheckPhoneSteamPage"),
  x: lazyPage("x", "CheckPhoneXPage"),
  reddit: lazyPage("reddit", "CheckPhoneRedditPage"),
  youtube: lazyPage("youtube", "CheckPhoneYoutubePage"),
  instagram: lazyPage("instagram", "CheckPhoneInstagramPage"),
  bilibili: lazyPage("bilibili", "CheckPhoneBilibiliPage"),
  douban: lazyPage("douban", "CheckPhoneDoubanPage"),
};

function isEmbeddedAppId(value: string): value is CheckPhoneEmbeddedAppId {
  return (CHECKPHONE_EMBEDDED_APP_IDS as readonly string[]).includes(value);
}

/** 取某个子 App 的懒加载组件；没有实现的 appId 返回 undefined。 */
export function getCheckPhoneEmbeddedPage(
  appId: string,
): ComponentType<CheckPhoneEmbeddedPageProps> | undefined {
  return isEmbeddedAppId(appId) ? CHECKPHONE_EMBEDDED_PAGES[appId] : undefined;
}

const prefetched = new Set<CheckPhoneEmbeddedAppId>();

/** 预取单个子 App 的 chunk。失败时清掉标记，点击时还会再试。 */
export function prefetchCheckPhoneEmbeddedPage(appId: string): void {
  if (!isEmbeddedAppId(appId) || prefetched.has(appId)) return;
  prefetched.add(appId);
  void loaders[appId]().catch(() => {
    prefetched.delete(appId);
  });
}

/**
 * 按 manifest 顺序在空闲时段逐个预取。
 * 每个 chunk 之间隔一个空闲回调，避免和当前页面的资源抢带宽/主线程。
 * 返回一个取消函数，组件卸载时调用。
 */
export function scheduleCheckPhonePrefetch(appIds: readonly string[]): () => void {
  let cancelled = false;
  const queue = appIds.filter(isEmbeddedAppId);
  let index = 0;
  let timer = 0;
  type IdleWin = Window & {
    requestIdleCallback?: (cb: (d: { timeRemaining: () => number }) => void, o?: { timeout: number }) => number;
  };
  const idleWin = window as IdleWin;
  const hasIdle = typeof idleWin.requestIdleCallback === "function";

  const step = () => {
    if (cancelled || index >= queue.length) return;
    prefetchCheckPhoneEmbeddedPage(queue[index]);
    index += 1;
    if (cancelled || index >= queue.length) return;
    if (hasIdle) idleWin.requestIdleCallback!(step, { timeout: 2000 });
    else timer = window.setTimeout(step, 300);
  };

  if (hasIdle) idleWin.requestIdleCallback!(step, { timeout: 1500 });
  else timer = window.setTimeout(step, 300);

  return () => {
    cancelled = true;
    if (timer) window.clearTimeout(timer);
  };
}
