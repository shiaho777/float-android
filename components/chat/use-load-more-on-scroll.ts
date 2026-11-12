"use client";

import { useEffect, useRef, type RefObject } from "react";

type UseLoadMoreOnScrollOptions = {
  /** 滚动容器 */
  rootRef: RefObject<HTMLElement | null>;
  /** 位于列表顶部的「查看更多」哨兵；进入预加载区即触发 */
  sentinelRef: RefObject<HTMLElement | null>;
  /** 还有没有更早的内容 */
  enabled: boolean;
  onLoadMore: () => void;
  /** 距顶部多远开始预加载（px） */
  thresholdPx?: number;
};

/**
 * 滚到接近顶部时自动加载更早的消息。
 *
 * 只负责「什么时候该加载」；插入后的滚动位置由调用方已有的锚点还原逻辑处理，
 * 这样用户看到的画面不会跳。
 *
 * 两个刻意的约束：
 * 1. 必须先有用户自己的滚动意图（滚轮 / 触摸 / 键盘 / 按下）。会话打开时会自动
 *    滚到底部，在那之前列表可能短暂停在顶部、哨兵可见；不设这道闸的话，一进
 *    会话就会连着加载好几页。
 * 2. 一次手势只自动加载一页。加载完哨兵会被推到视口上方；如果内容很短导致它
 *    仍在预加载区，也不会继续连跳，等用户再滚一次。
 */
export function useLoadMoreOnScroll({
  rootRef,
  sentinelRef,
  enabled,
  onLoadMore,
  thresholdPx = 320,
}: UseLoadMoreOnScrollOptions): void {
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  const hasUserScrolledRef = useRef(false);

  useEffect(() => {
    // 监听挂在 window 上、再用 contains 判断是否发生在滚动容器内：
    // 滚动容器在某些模式下会被换掉，挂在元素上的监听会留在旧节点上变成哑巴。
    const markIntent = (event: Event) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      hasUserScrolledRef.current = true;
    };
    window.addEventListener("wheel", markIntent, { capture: true, passive: true });
    window.addEventListener("touchmove", markIntent, { capture: true, passive: true });
    window.addEventListener("keydown", markIntent, true);
    window.addEventListener("pointerdown", markIntent, true);
    return () => {
      window.removeEventListener("wheel", markIntent, { capture: true });
      window.removeEventListener("touchmove", markIntent, { capture: true });
      window.removeEventListener("keydown", markIntent, true);
      window.removeEventListener("pointerdown", markIntent, true);
    };
  }, [rootRef]);

  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        if (!hasUserScrolledRef.current) return;
        hasUserScrolledRef.current = false;
        onLoadMoreRef.current();
      },
      { root, rootMargin: `${thresholdPx}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // onLoadMore 只在加载后换 identity：顺带重挂一次观察器，
    // 万一哨兵节点被重建，也不会盯着一个已经脱离文档的旧节点。
  }, [enabled, rootRef, sentinelRef, thresholdPx, onLoadMore]);
}
