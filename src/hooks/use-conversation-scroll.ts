import { useCallback, useEffect, useRef, useState } from "react";

/** 距底部多少像素以内算“在底部”。 */
const BOTTOM_THRESHOLD = 32;
/** 用户输入（滚轮/触摸/按键）后多久内发生的滚动算“用户滚动”。 */
const USER_INTENT_MS = 250;
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
 */
export function useConversationScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [atBottom, setAtBottomState] = useState(true);
  const atBottomRef = useRef(true);
  const setAtBottom = useCallback((value: boolean) => {
    if (atBottomRef.current === value) return;
    atBottomRef.current = value;
    setAtBottomState(value);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let lastScrollTop = element.scrollTop;
    let userIntentAt = 0;
    let draggingScrollbar = false;
    let followFrame = 0;
    const distanceToBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight;
    const markIntent = () => { userIntentAt = performance.now(); };

    const stickToBottom = () => {
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

    const onScroll = () => {
      const top = element.scrollTop;
      const movedUp = top < lastScrollTop - 1;
      lastScrollTop = top;
      const nearBottom = distanceToBottom() <= BOTTOM_THRESHOLD;
      const userDriven = draggingScrollbar || performance.now() - userIntentAt < USER_INTENT_MS;
      if (nearBottom) followingRef.current = true;
      else if (movedUp && userDriven) followingRef.current = false;
      setAtBottom(followingRef.current || nearBottom);
    };

    const onWheel = (event: WheelEvent) => {
      markIntent();
      // 向上滚一下立即停止跟随，避免下一帧又被贴回底部“抢滚动”。
      if (event.deltaY < 0 && element.scrollTop > 0 && !scrollableAncestorCanConsume(event.target, element, event.deltaY)) {
        followingRef.current = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_UP_KEYS.has(event.key) || (event.key === " " && event.shiftKey)) markIntent();
    };
    // 直接按在滚动容器上（而非其内容）即为拖动滚动条。
    const onPointerDown = (event: PointerEvent) => {
      markIntent();
      if (event.target === element) draggingScrollbar = true;
    };
    const onPointerUp = () => { draggingScrollbar = false; };

    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", markIntent, { passive: true });
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);

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
      window.removeEventListener("pointerup", onPointerUp);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [setAtBottom]);

  // 稳定引用：作为 onSubmitted 传给 memo 过的 ChatComposer，
  // 避免 Chat 每次流式重渲染都把回调换新、击穿 memo。
  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    followingRef.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [setAtBottom]);

  return { ref, atBottom, scrollToBottom } as const;
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
