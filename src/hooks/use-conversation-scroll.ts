import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isLowPerf } from "../lib/perf-tier";

/** 距底部多少像素以内算“在底部”。 */
/** 用户输入（滚轮/触摸/按键）后多久内发生的滚动算“用户滚动”。 */
const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * 流式输出自动跟随（stick-to-bottom）。
 *
 * - `following` 是唯一的跟随开关：内容变高时，只要在跟随就直接贴底（不用
 *   smooth，避免动画中途被判定为“离开底部”）。
 * - 只有用户主动向上滚（滚轮、触摸、按键、拖滚动条）才停止跟随；内容自己
 *   长高、程序化滚动、平滑滚动动画都不会关掉跟随。
 * - 用户滚回底部附近即恢复跟随。
 * - 监听内容区尺寸（ResizeObserver）+ DOM/文本变化（MutationObserver），
 *   图片/代码块渲染后撑高也能跟上。
 * - `userUnpinned` 只在用户自己滚离底部时为 true：程序化定位（发送后把新轮
 *   锚到顶部的 pauseFollow + 对齐滚动）会把 following/atBottom 置 false，但那
 *   不是用户离开底部，「跳到最新」按钮（!atBottom && userUnpinned）不该弹出。
 */
export function useConversationScroll(options: { /** 置 true 时贴底逻辑整体挂起（发送后的锚定窗口期），避免乐观追加先把视图拽到底部。 */ holdStickRef?: RefObject<boolean> } = {}) {
  const holdStickRef = options.holdStickRef;
  const ref = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [atBottom, setAtBottomState] = useState(true);
  const atBottomRef = useRef(true);
  const setAtBottom = useCallback((value: boolean) => {
    if (atBottomRef.current === value) return;
    atBottomRef.current = value;
    setAtBottomState(value);
  }, []);
  const [userUnpinned, setUserUnpinnedState] = useState(false);
  const userUnpinnedRef = useRef(false);
  const setUserUnpinned = useCallback((value: boolean) => {
    if (userUnpinnedRef.current === value) return;
    userUnpinnedRef.current = value;
    setUserUnpinnedState(value);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let lastScrollTop = element.scrollTop;
    let followFrame = 0;
    // Explicit user gestures unpin immediately; programmatic scrolls do not.
    const markIntent = () => undefined;

    const stickToBottom = () => {
      // 锚定窗口期（刚发送、等锚定接管）不贴底：先把视图拽到底再拉回顶部
      // 就是你能看见的那一下抖动。
      if (holdStickRef?.current) return;
      const target = element.scrollHeight - element.clientHeight;
      // 已经贴底时不再写 scrollTop：写操作会派发 scroll 事件并让下一次
      // 布局失效，长会话下每帧白跑一次。
      if (element.scrollTop < target) element.scrollTop = target;
      lastScrollTop = element.scrollTop;
    };
    // 内容变化：跟随中就在下一帧贴底。独立的 frame，滚动事件不会取消它。
    const onContentChange = () => {
      if (!followingRef.current || followFrame) return;
      followFrame = requestAnimationFrame(() => {
        followFrame = 0;
        if (followingRef.current) stickToBottom();
      });
    };

    // MonoCode's `followsAfterScroll`: following restarts only when genuine
    // downward movement actually reaches the end. Layout clamping, no movement,
    // and a small reversal inside the bottom margin all keep the position —
    // which is what leaves an anchored prompt still.
    const onScroll = () => {
      const movement = element.scrollTop - lastScrollTop;
      followingRef.current = followsAfterScroll(element, lastScrollTop, followingRef.current);
      lastScrollTop = element.scrollTop;
      setAtBottom(followingRef.current);
      // 向上位移是用户在离开最新内容（滚轮/键盘/触摸/拖滚动条都汇聚到这里）。
      // 程序化定位只有对齐新轮的向下滚动和轮后回落的零位移，不会向上；
      // 恢复跟随（回到最新）时清除标记。
      if (movement < 0) setUserUnpinned(true);
      else if (followingRef.current) setUserUnpinned(false);
    };

    const onWheel = (event: WheelEvent) => {
      markIntent();
      // 向上滚一下立即停止跟随，避免下一帧又被贴回底部“抢滚动”。
      if (event.deltaY < 0 && element.scrollTop > 0 && !scrollableAncestorCanConsume(event.target, element, event.deltaY)) {
        followingRef.current = false;
        setAtBottom(false);
        setUserUnpinned(true);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) markIntent();
    };
    const onPointerDown = (event: PointerEvent) => {
      markIntent();
      // 命中滚动容器本身 = 拖它的滚动条，是用户在手动滚动。
      if (event.target === element) {
        followingRef.current = false;
        setAtBottom(false);
        setUserUnpinned(true);
      }
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", markIntent, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);

    const resizeObserver = new ResizeObserver(onContentChange);
    resizeObserver.observe(element);
    const observeContent = () => { for (const child of Array.from(element.children)) resizeObserver.observe(child); };
    observeContent();
    // 只观察滚动容器的直接子节点。内容高度变化由上面的 ResizeObserver 负责
    // （消息行就是直接子节点），因此不再需要 subtree + characterData：流式时
    // 每个字符都会产生一条 mutation 记录，整棵会话 DOM 的记录数组（几万条）
    // 会在每帧被遍历一次，是长会话下的主要停顿来源之一。
    const mutationObserver = new MutationObserver(() => {
      observeContent();
      onContentChange();
    });
    mutationObserver.observe(element, { childList: true });;

    stickToBottom();
    return () => {
      cancelAnimationFrame(followFrame);
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", markIntent);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);

      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [setAtBottom, setUserUnpinned]);


  const settleFrameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(settleFrameRef.current), []);
  // 稳定引用：作为 onSubmitted 传给 memo 过的 ChatComposer，
  // 避免 Chat 每次流式重渲染都把回调换新、击穿 memo。
  // 发送时调用：新消息要等 React（含 deferred 渲染）提交后才有高度，所以不能只滚一次，
  // 也不能用 smooth（动画期间内容还在长，会停在半路）。进入跟随状态后在约 1s 内
  // 每帧贴底；用户向上滚动（followingRef 被关）就立即放手。
  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    if (holdStickRef?.current) return;
    followingRef.current = true;
    setAtBottom(true);
    setUserUnpinned(false);
    cancelAnimationFrame(settleFrameRef.current);
    // 低配机器缩短到 400ms：足够覆盖乐观预览的首次渲染，又不让每帧强制布局持续太久；
    // 之后的增长由 ResizeObserver 驱动的 stickToBottom 接管。
    const until = performance.now() + (isLowPerf ? 400 : 1000);
    const settle = () => {
      if (!followingRef.current) return;
      const target = element.scrollHeight - element.clientHeight;
      if (element.scrollTop < target) element.scrollTop = target;
      if (performance.now() < until) settleFrameRef.current = requestAnimationFrame(settle);
    };
    settle();
  }, [setAtBottom, setUserUnpinned]);

  /**
   * Stop following without moving: used while a sent prompt is anchored.
   * 程序化暂停，不算用户离开底部：不动 userUnpinned，否则刚发送的消息
   * （锚定在顶部、下方是拉伸的空白回合区）就会弹出「跳到最新」按钮。
   */
  const pauseFollow = useCallback(() => {
    followingRef.current = false;
    setAtBottom(false);
    cancelAnimationFrame(settleFrameRef.current);
  }, [setAtBottom]);

  return { ref, atBottom, userUnpinned, scrollToBottom, pauseFollow } as const;
}

/** MonoCode's rules for whether a scroll event restarts following. */
function followsAfterScroll(element: HTMLElement, previousTop: number, following: boolean): boolean {
  const movement = element.scrollTop - previousTop;
  if (movement === 0 || scrollClampedToBottom(element, previousTop)) return following;
  return movement > 0 && element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
}

function scrollClampedToBottom(element: HTMLElement, previousTop: number): boolean {
  const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
  return previousTop > bottom && Math.abs(element.scrollTop - bottom) < 1;
}

/** 滚轮发生在内部可滚动区域（代码块、工具输出）且它还能继续向该方向滚时，外层不会滚动。 */
function scrollableAncestorCanConsume(target: EventTarget | null, root: HTMLElement, deltaY: number): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== root; node = node.parentElement) {
    if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight) continue;
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    if (deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight) return true;
  }
  return false;
}
