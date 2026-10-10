import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { innerScrollerTakes, useLockOverscroll } from "../shared/hooks/useLockOverscroll";

/**
 * 会话滚动，逐行照搬 Orbit（monocode `AgentTranscript.tsx`）的模型：
 *
 * - `stickToBottom` 是唯一的跟随开关。内容变化（提交、ResizeObserver）时只要
 *   在跟随就贴底；只有真实输入（向上滚轮、上翻按键、拖滚动条、手指下拉）才放手。
 * - 发送一条新消息（`lastUserId` 变化）一律重新跟随并贴底。最后一轮带
 *   `.transcript-turn-anchor`（min-height = `--transcript-viewport`，至少一屏高），
 *   贴底之后屏幕里只剩这一轮，提示语自然就在可视区顶部——不量距离、不暂停跟随。
 * - 「跳到最新」= 不在跟随 且 内容可滚动。
 */
const WHEEL_HOLD_MS = 150;

export function useConversationScroll({
  lastUserId,
  content,
  busy,
  onJumpChange,
}: {
  lastUserId: string | null;
  /** 会话内容；每次变化（流式提交）在布局阶段跟随一次。 */
  content: unknown;
  busy: boolean;
  /** 必须是稳定引用。 */
  onJumpChange: (show: boolean) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const showJumpRef = useRef(false);
  const distanceFromBottom = useRef(0);
  const lastScrollTop = useRef(0);
  const pointerScrolling = useRef(false);
  const wheelHold = useRef(0);

  const setShowJump = useCallback(
    (show: boolean) => {
      if (showJumpRef.current === show) return;
      showJumpRef.current = show;
      onJumpChange(show);
    },
    [onJumpChange],
  );

  const syncPinned = useCallback(
    (el: HTMLElement) => {
      // Rendering can shrink and regrow the transcript before observers run,
      // leaving a browser-clamped offset above the new bottom. An offset alone
      // cannot identify manual scrolling. Input handlers release the pin.
      if (stickToBottom.current && !pointerScrolling.current) {
        lastScrollTop.current = el.scrollTop;
        distanceFromBottom.current = 0;
        setShowJump(false);
        return;
      }
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Content growth changes the distance without moving the reader. A
      // queued event from a previous pin must not unpin (or re-pin) the view.
      // A taller viewport or shorter transcript can also clamp the previous
      // offset to the new bottom; that is a layout adjustment, not a scroll up.
      stickToBottom.current = followsAfterScroll(el, lastScrollTop.current, stickToBottom.current);
      lastScrollTop.current = el.scrollTop;
      distanceFromBottom.current = distance;
      setShowJump(!stickToBottom.current && el.scrollHeight > el.clientHeight);
    },
    [setShowJump],
  );

  const rememberScroll = useCallback((el: HTMLElement) => {
    lastScrollTop.current = el.scrollTop;
    distanceFromBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const pinTranscript = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      pinToBottom(el);
      rememberScroll(el);
    },
    [rememberScroll],
  );

  const followTranscript = useCallback(
    (el: HTMLElement | null) => {
      if (!el) return;
      // The browser can apply a manual scroll before dispatching its event.
      // Reconcile that offset before a streaming commit or observer pins it.
      syncPinned(el);
      // A gesture whose direction is not known yet may already be scrolling
      // off the main thread. Pinning now would snap it back to the end.
      if (stickToBottom.current && performance.now() >= wheelHold.current) pinTranscript(el);
    },
    [pinTranscript, syncPinned],
  );

  const jumpToBottom = useCallback(() => {
    stickToBottom.current = true;
    distanceFromBottom.current = 0;
    setShowJump(false);
    const el = scroller.current;
    syncTranscriptViewport(el);
    pinTranscript(el);
  }, [pinTranscript, setShowJump]);

  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      setScrollerEl(el);
      lockOverscroll(el);
    },
    [lockOverscroll],
  );

  useEffect(() => {
    if (!scrollerEl) return;
    const onScroll = () => {
      if (scrollerEl.isConnected && scrollerEl.clientHeight > 0) syncPinned(scrollerEl);
    };
    let release: ReturnType<typeof setTimeout> | undefined;
    let heldScrollTop: number | undefined;
    const pauseFollowing = () => {
      stickToBottom.current = false;
      setShowJump(scrollerEl.scrollHeight > scrollerEl.clientHeight);
    };
    const holdFollowing = () => {
      heldScrollTop ??= scrollerEl.scrollTop;
      wheelHold.current = performance.now() + WHEEL_HOLD_MS;
      clearTimeout(release);
      release = setTimeout(() => {
        if (!scrollerEl.isConnected) return;
        if (heldScrollTop !== undefined && scrollerEl.scrollTop < heldScrollTop && !scrollClampedToBottom(scrollerEl, heldScrollTop))
          pauseFollowing();
        heldScrollTop = undefined;
        followTranscript(scrollerEl);
      }, WHEEL_HOLD_MS);
    };
    const onWheel = (e: WheelEvent) => {
      if (innerScrollerTakes(scrollerEl, e)) return;
      if (e.deltaY < 0) {
        pauseFollowing();
      } else if (e.deltaY === 0) {
        // A trackpad gesture can open with an event that carries no
        // direction, and the rest of it may reach us after the scroll has
        // moved. Hold the pin until its upward events can release it.
        holdFollowing();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") pointerScrolling.current = true;
      if (event.target === scrollerEl) pauseFollowing();
    };
    const onPointerUp = () => {
      if (pointerScrolling.current && scrollerEl.isConnected) syncPinned(scrollerEl);
      pointerScrolling.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select"))) return;
      if (event.key !== "ArrowUp" && event.key !== "PageUp" && event.key !== "Home" && !(event.key === " " && event.shiftKey)) return;
      if (!innerScrollerTakes(scrollerEl, { target, deltaX: 0, deltaY: -1 })) pauseFollowing();
    };
    let touchY: number | undefined;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
      holdFollowing();
    };
    const onTouchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (touchY !== undefined && next !== undefined && next > touchY) {
        if (!innerScrollerTakes(scrollerEl, { target: event.target, deltaX: 0, deltaY: touchY - next })) pauseFollowing();
      }
      touchY = next;
    };
    scrollerEl.addEventListener("scroll", onScroll, { passive: true });
    scrollerEl.addEventListener("wheel", onWheel, { passive: true });
    scrollerEl.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerUp, { passive: true });
    scrollerEl.addEventListener("keydown", onKeyDown);
    scrollerEl.addEventListener("touchstart", onTouchStart, { passive: true });
    scrollerEl.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      clearTimeout(release);
      scrollerEl.removeEventListener("scroll", onScroll);
      scrollerEl.removeEventListener("wheel", onWheel);
      scrollerEl.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      pointerScrolling.current = false;
      scrollerEl.removeEventListener("keydown", onKeyDown);
      scrollerEl.removeEventListener("touchstart", onTouchStart);
      scrollerEl.removeEventListener("touchmove", onTouchMove);
    };
  }, [scrollerEl, followTranscript, setShowJump, syncPinned]);

  // A new prompt always follows again: pinned to the end, the pane-tall
  // anchored turn puts that prompt at the top of the view.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setShowJump(false);
    const el = scroller.current;
    syncTranscriptViewport(el);
    pinTranscript(el);
  }, [lastUserId, scrollerEl, pinTranscript, setShowJump]);

  useLayoutEffect(() => {
    if (!stickToBottom.current) return;
    const el = scroller.current;
    syncTranscriptViewport(el);
    followTranscript(el);
  }, [content, busy, followTranscript]);

  useLayoutEffect(() => {
    const el = scrollerEl;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const onResize = () => {
      if (!el.isConnected) return;
      syncTranscriptViewport(el);
      followTranscript(el);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(inner);
    observer.observe(el);
    onResize();
    return () => observer.disconnect();
  }, [scrollerEl, followTranscript]);

  useTurnScrollAnchor(scrollerEl, stickToBottom, rememberScroll);

  return { scroller, scrollerEl, setScroller, jumpToBottom } as const;
}

/**
 * Hold the reader's place while turns above the viewport change height. The
 * scroller opts out of native scroll anchoring, so late markdown, image or
 * disclosure sizing above the viewport needs an explicit correction.
 */
function useTurnScrollAnchor(el: HTMLDivElement | null, stickToBottom: RefObject<boolean>, onAdjust: (el: HTMLElement) => void) {
  useLayoutEffect(() => {
    const inner = el?.querySelector("[data-transcript-content]");
    if (!el || !inner) return;
    const heights = new WeakMap<Element, number>();
    const resize = new ResizeObserver((entries) => {
      if (!el.isConnected) return;
      const viewportTop = el.getBoundingClientRect().top;
      let shift = 0;
      let precedingDelta = 0;
      const byTurn = new Map(entries.map((entry) => [entry.target, entry]));
      // Entries can arrive out of order. Later turns already include the
      // height corrections of earlier turns in their new layout position.
      for (const turn of inner.children) {
        const entry = byTurn.get(turn);
        if (!entry) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        const previous = heights.get(entry.target);
        heights.set(entry.target, height);
        if (previous === undefined || stickToBottom.current) continue;
        // Only turns that sat wholly above the view. A turn the reader is
        // looking at grows downward from where they are reading.
        const top = entry.target.getBoundingClientRect().top - precedingDelta;
        if (top + previous <= viewportTop) shift += height - previous;
        precedingDelta += height - previous;
      }
      if (shift) {
        el.scrollTop += shift;
        onAdjust(el);
      }
    });
    let observed = new WeakSet<Element>();
    const observeTurns = () => {
      for (const turn of inner.children) {
        if (observed.has(turn) || !turn.classList.contains("transcript-turn")) continue;
        observed.add(turn);
        resize.observe(turn);
      }
    };
    const mutations = new MutationObserver((records) => {
      // Removal is rare (a rewind or edit), so start over rather than hold
      // detached turns. Re-observed turns report the height already stored.
      if (records.some((record) => record.removedNodes.length > 0)) {
        resize.disconnect();
        observed = new WeakSet();
      }
      observeTurns();
    });
    mutations.observe(inner, { childList: true });
    observeTurns();
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [el, stickToBottom, onAdjust]);
}

const PROMPT_RISE_MS = 560;
// Keep in sync with the prompt-turn-reveal animation in orbit-theme.css.
const PROMPT_REVEAL_MS = 320;
const PROMPT_FADE_MS = 480;
// Where the prompt starts, as a fraction of the viewport height from the top.
const PROMPT_RISE_FROM = 0.3;

/** Fades the prompt in while sliding it from the upper viewport to its row. */
export function riseIntoAnchor(scroller: HTMLElement | null, blockId: string) {
  const row = scroller?.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(blockId)}"]`);
  if (!scroller || !row || typeof row.animate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const view = scroller.getBoundingClientRect();
  const dy = view.top + view.height * PROMPT_RISE_FROM - row.getBoundingClientRect().top;
  if (dy <= 1) return;
  const animation = row.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
    duration: PROMPT_RISE_MS,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  });
  // The fade gets its own gentler curve; on the rise's sharp ease-out it
  // would be over before the eye catches it.
  const fade = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PROMPT_FADE_MS, easing: "ease-out" });
  // The rest of the turn waits until the prompt lands, then fades in.
  // 我们的分组是一条消息一组，Orbit 的「一轮」对应锚定包裹层。
  const turn = row.closest<HTMLElement>("[data-transcript-anchor]");
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  turn?.setAttribute("data-prompt-rise", "rising");
  animation.onfinish = () => {
    turn?.setAttribute("data-prompt-rise", "revealing");
    revealTimer = setTimeout(() => turn?.removeAttribute("data-prompt-rise"), PROMPT_REVEAL_MS);
  };
  return () => {
    animation.cancel();
    fade.cancel();
    clearTimeout(revealTimer);
    turn?.removeAttribute("data-prompt-rise");
  };
}

function followsAfterScroll(el: HTMLElement, previousTop: number, following: boolean): boolean {
  const movement = el.scrollTop - previousTop;
  if (movement === 0 || scrollClampedToBottom(el, previousTop)) return following;
  // A small downward reversal while reading inside the bottom margin must
  // not restart following. Resume only when the reader reaches the end.
  return movement > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
}

function scrollClampedToBottom(el: HTMLElement, previousTop: number): boolean {
  const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
  return previousTop > bottom && Math.abs(el.scrollTop - bottom) < 1;
}

function pinToBottom(el: HTMLElement | null) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/** Keep the live turn's min-height in lockstep with the visible transcript. */
function syncTranscriptViewport(el: HTMLElement | null) {
  if (!el || el.clientHeight <= 0) return;
  const inner = el.firstElementChild as HTMLElement | null;
  const pad = inner ? Number.parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
  const next = `${Math.max(0, el.clientHeight - pad)}px`;
  if (el.style.getPropertyValue("--transcript-viewport") === next) return;
  el.style.setProperty("--transcript-viewport", next);
}
