import { useEffect, useRef, useState, type RefObject } from "react";
import { Popover } from "../../shared/ui/Popover";

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

function samePrompts(a: readonly Prompt[], b: readonly Prompt[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id || a[i].text !== b[i].text) return false;
  return true;
}

export function PromptOutline({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; y: number } | null>(null);
  const rail = useRef<HTMLDivElement>(null);

  // The rail is derived from the transcript's own DOM, so it stays correct even
  // while the message list is paged or filtered.
  //
  // 这里不拿 messages 当依赖：流式时它每帧都换引用，依赖它等于每帧拆掉重建一次
  // MutationObserver 并重扫全部提示行。节点增删本身由 observer 捕捉（切会话、
  // 新提示都是 childList 变动），流式 token 只是 characterData，不该触发扫描。
  useEffect(() => {
    const scroller = scope.current;
    if (!scroller) return;
    let frame = 0;
    const collect = () => {
      frame = 0;
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-prompt-anchor]"));
      const next = rows.map((row) => {
        const id = row.dataset.promptAnchor ?? "";
        const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
        return { id, text, preview: text.slice(0, 120) };
      });
      // 同一批提示行不要换新数组：没有变化就不必重渲染这条轨道。
      setPrompts((current) => samePrompts(current, next) ? current : next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(collect);
    };
    collect();
    const observer = new MutationObserver(schedule);
    observer.observe(scroller, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scope]);

  // Which prompt the reader is currently looking at.
  // 流式时编辑区每帧都贴底，scroll 事件跟着每帧来；直接在里面逐行量 rect 就是
  // 每帧一次强制布局。这里合并到每帧最多量一次，结果与原来一致。
  useEffect(() => {
    const scroller = scope.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top;
      let current: string | null = null;
      for (const row of scroller.querySelectorAll<HTMLElement>("[data-prompt-anchor]")) {
        if (row.getBoundingClientRect().top - top <= 24) current = row.dataset.promptAnchor ?? null;
        else break;
      }
      setActiveId(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
    };
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
