import { useCallback, useEffect, useRef, useState } from "react";

export function useConversationScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const heightRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const update = (follow = false) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { scrollHeight, clientHeight } = element;
        const wasAtBottom = atBottomRef.current;
        if (follow && wasAtBottom && scrollHeight > heightRef.current) element.scrollTop = scrollHeight;
        heightRef.current = element.scrollHeight;
        const next = element.scrollHeight - element.scrollTop - clientHeight <= 24;
        atBottomRef.current = next;
        setAtBottom(next);
      });
    };
    const onScroll = () => update();
    const resizeObserver = new ResizeObserver(() => update(true));
    const mutationObserver = new MutationObserver(() => update(true));
    heightRef.current = element.scrollHeight;
    update();
    element.addEventListener("scroll", onScroll, { passive: true });
    resizeObserver.observe(element);
    mutationObserver.observe(element, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);
  // 稳定引用：作为 onSubmitted 传给 memo 过的 ChatComposer，
  // 避免 Chat 每次流式重渲染都把回调换新、击穿 memo。
  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);
  return { ref, atBottom, scrollToBottom } as const;
}
