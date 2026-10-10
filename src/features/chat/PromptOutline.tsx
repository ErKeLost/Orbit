import { useEffect, useRef, useState, type RefObject } from "react";
import { Popover } from "../../shared/ui/Popover";
import type { DisplayMessage } from "../../lib/protocol";

/**
 * Orbit's `PromptOutline`: one short bar per prompt down the right edge of
 * the transcript. Hovering widens the bar and previews the prompt; clicking
 * scrolls that turn back into view. The rail fades in only while it is useful
 * (two or more prompts) and hides on narrow panes, like the original.
 */
const BAR_HEIGHT_PX = 2;
const BAR_WIDTH_PX = 11;
const BAR_WIDTH_LIFTED_PX = 24;
const BAR_OPACITY_IDLE = 0.15;
const BAR_OPACITY_LIT = 0.85;
const BAR_GAP_PX = 10;
const MIN_PROMPTS = 2;

type Prompt = { id: string; text: string; preview: string };

export function PromptOutline({ messages, scope }: { messages: DisplayMessage[]; scope: RefObject<HTMLElement | null> }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; y: number } | null>(null);
  const rail = useRef<HTMLDivElement>(null);

  // The rail is derived from the transcript's own DOM, so it stays correct even
  // while the message list is paged or filtered.
  useEffect(() => {
    const scroller = scope.current;
    if (!scroller) return;
    const collect = () => {
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-prompt-anchor]"));
      setPrompts(
        rows.map((row) => {
          const id = row.dataset.promptAnchor ?? "";
          const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
          return { id, text, preview: text.slice(0, 120) };
        }),
      );
    };
    collect();
    const observer = new MutationObserver(collect);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [scope, messages]);

  // Which prompt the reader is currently looking at.
  useEffect(() => {
    const scroller = scope.current;
    if (!scroller) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top;
      let current: string | null = null;
      for (const row of scroller.querySelectorAll<HTMLElement>("[data-prompt-anchor]")) {
        if (row.getBoundingClientRect().top - top <= 24) current = row.dataset.promptAnchor ?? null;
        else break;
      }
      setActiveId(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [prompts.length, scope]);

  if (prompts.length < MIN_PROMPTS) return null;

  const jumpTo = (id: string) => {
    const scroller = scope.current;
    const row = scroller?.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(id)}"]`);
    if (!scroller || !row) return;
    // The transcript scrolls to the bottom on each streaming update until a
    // wheel-up event occurs. Send one, so the jump stays.
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 8);
  };

  return (
    <div
      ref={rail}
      aria-label="提示轮廓"
      role="navigation"
      className="absolute top-1/2 right-4 z-30 flex -translate-y-1/2 flex-col items-end @max-[58rem]:hidden"
    >
      <div className="flex flex-col items-end" style={{ gap: `${BAR_GAP_PX}px` }}>
        {prompts.map((prompt) => {
          const lit = hover?.id === prompt.id || (!hover && activeId === prompt.id);
          return (
            <button
              key={prompt.id}
              type="button"
              title={prompt.text || "提示"}
              aria-label={`跳转到：${prompt.text.slice(0, 40) || "提示"}`}
              onClick={() => jumpTo(prompt.id)}
              onMouseEnter={(event) => setHover({ id: prompt.id, y: event.currentTarget.getBoundingClientRect().top })}
              onMouseLeave={() => setHover((current) => (current?.id === prompt.id ? null : current))}
              className="flex w-full shrink-0 items-center justify-end rounded-md outline-none focus-visible:ring-1 focus-visible:ring-accent"
              style={{ height: BAR_HEIGHT_PX }}
            >
              <span
                aria-hidden
                className="rounded-full bg-content transition-[width,opacity] duration-200 ease-out"
                style={{
                  height: BAR_HEIGHT_PX,
                  width: lit ? BAR_WIDTH_LIFTED_PX : BAR_WIDTH_PX,
                  opacity: lit ? BAR_OPACITY_LIT : BAR_OPACITY_IDLE,
                }}
              />
            </button>
          );
        })}
      </div>
      {hover && (() => {
        const prompt = prompts.find((item) => item.id === hover.id);
        if (!prompt) return null;
        return (
          <Popover
            anchor={rail.current}
            side="left"
            align="center"
            width={288}
            onDismiss={() => setHover(null)}
            className="px-3 py-2"
          >
            <p className="line-clamp-2 text-[13px] leading-snug text-content">{prompt.preview || "（空提示）"}</p>
          </Popover>
        );
      })()}
    </div>
  );
}
