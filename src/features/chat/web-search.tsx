import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type Transition, type Variants } from "motion/react";
import type { Part, Tool } from "../../lib/protocol";
import { toolResultText } from "../../lib/protocol";
import { isLowPerf } from "../../lib/perf-tier";
import { Shimmer } from "../../shared/ui/Shimmer";
import { useShell } from "../shell/shellStore";
import { SiteLogo } from "./site-logo";
import { searchResults, siteLabel, type SearchHit } from "./web-search-site";

const COLUMNS = 4;
// Each result closes this share of the gap left, so the ring fills fast early and never hits the end on its own.
const STEP = 0.3;
const START = 0.08;
const CREEP = 0.25;
const CREEP_SECONDS = 4;
const RING_HOLD = 0.45;
const STACK = 4;
// A pointer just passing through never spreads the icons.
const SPREAD_DELAY = 150;
const LEAVE_DELAY = 150;

const SWAP: Transition = { type: "spring", duration: 0.55, bounce: 0.1 };
const POP: Transition = { type: "spring", duration: 0.5, bounce: 0.4 };
const SPREAD: Transition = { type: "spring", duration: 0.35, bounce: 0 };
const OPEN: Transition = { type: "spring", duration: 0.5, bounce: 0.08 };
const CARD: Transition = { type: "spring", duration: 0.5, bounce: 0.1 };
const STAGGER = 0.045;
const RING: Transition = { type: "spring", duration: 0.6, bounce: 0 };
const INSTANT: Transition = { duration: 0 };

const swapVariants: Variants = {
  enter: { y: 6, opacity: 0, filter: "blur(3px)" },
  center: { y: 0, opacity: 1, filter: "blur(0px)" },
  exit: { y: -6, opacity: 0, filter: "blur(3px)" },
};

const cardVariants: Variants = {
  enter: { opacity: 0, y: 8, scale: 0.97, filter: "blur(6px)" },
  center: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, scale: 0.97, filter: "blur(4px)" },
};

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const RING_CIRCLE = { ...STROKE, cx: 14, cy: 14, r: 13, strokeWidth: 1.5 };

// Gray capsule on paper, a step above the canvas at night. Hover lifts to the next surface.
const SURFACE =
  "bg-surface-raised transition-[background-color,box-shadow,translate] duration-200 hover:bg-surface-card hover:shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_1px_1px_rgba(0,0,0,0.04),0_2px_4px_-1px_rgba(0,0,0,0.08)] dark:bg-surface-card dark:hover:bg-surface-raised dark:hover:shadow-none";
const PLATE =
  "bg-surface-raised transition-colors group-hover:bg-surface-card group-hover/card:bg-surface-card dark:bg-surface-card dark:group-hover:bg-surface-raised dark:group-hover/card:bg-surface-raised";
const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3";

const CARD_SHELL = `flex h-[84px] w-full cursor-pointer flex-col rounded-[14px] p-2.5 text-left ${SURFACE} ${FOCUS} group-hover/card:-translate-y-0.5`;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function openPage(url: string, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    void openUrl(url).catch(() => undefined);
    return;
  }
  useShell.getState().openLink(url);
}

function readableFallback(text: string) {
  const body = text
    .replace(/^\uFEFF?---[\s\S]*?\n---\s*/, "")
    .replace(/^Expand Web Search：[^\n]*\n+/, "")
    .trim();
  if (body.length < 8 || body === "没有结果") return "";
  return body.slice(0, 1500);
}

/**
 * The web search tool, as a results strip rather than a verb row.
 *
 * The fold closes once the turn settles, so this stays outside it: the query,
 * the pages that came back, and a ring that moves while the search is still out.
 */
export function WebSearchTool({ part, tools }: { part: Part; tools: Record<string, Tool> }) {
  const tool = tools[part.id ?? ""];
  const query = typeof part.arguments?.query === "string" ? part.arguments.query.trim() : "";
  const searching = !tool || tool.running;
  // A result can land in pieces. Cards fill as pages show up; skeletons hold the empty slots.
  const raw = toolResultText(tool?.result);
  const sources = useMemo(() => searchResults(raw), [raw]);
  return <WebSearch query={query} searching={searching} sources={sources} raw={raw} />;
}

function WebSearch({
  query,
  searching,
  sources,
  raw,
}: {
  query: string;
  searching: boolean;
  sources: SearchHit[];
  raw: string;
}) {
  const reduced = !!useReducedMotion();
  const quiet = reduced || isLowPerf;
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [measureRef, labelWidth] = useSize<HTMLSpanElement>("width");
  const count = sources.length;
  const fallback = !searching && count === 0 ? readableFallback(raw) : "";
  const ring = Math.min(1, Math.max(0, count === 0 ? START : 1 - (1 - STEP) ** count));
  const text = searching
    ? query
      ? `Searching “${query}”`
      : "Searching the web"
    : count > 0
      ? `Searched ${count} ${count === 1 ? "site" : "sites"}`
      : fallback
        ? "Searched the web"
        : "No results";
  // The last slot belongs to the more card from the fourth result on, so no card has to turn into it.
  const overflow = !expanded && count >= COLUMNS;
  const shown = overflow ? sources.slice(0, COLUMNS - 1) : sources;
  const hidden = overflow ? sources.slice(COLUMNS - 1) : [];
  const skeletons = searching && !overflow ? Math.max(0, COLUMNS - count) : 0;
  const swap = quiet ? INSTANT : SWAP;
  const stagger = (index: number): Transition =>
    quiet ? INSTANT : { ...CARD, delay: Math.max(0, index - (expanded ? COLUMNS - 1 : 0)) * STAGGER };

  return (
    <div data-slot="web-search" data-status={searching ? "searching" : "done"} data-open={open || undefined} className="@container flex w-full max-w-[560px] min-w-0 flex-col font-sans text-ink-1">
      <button
        type="button"
        data-slot="web-search-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={query ? `“${query}”` : undefined}
        className={cx("group flex h-10 w-fit max-w-full cursor-pointer items-center gap-2.5 rounded-full pr-3.5 pl-1.5 text-left", SURFACE, FOCUS)}
      >
        <GlobeTile searching={searching} progress={ring} quiet={quiet} />
        <motion.span
          aria-live="polite"
          className="relative grid min-w-0 max-w-[min(20rem,calc(100vw-9rem))] overflow-x-clip"
          initial={false}
          animate={{ width: labelWidth ?? "auto" }}
          transition={swap}
        >
          <span ref={measureRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 text-sm font-semibold whitespace-nowrap">
            {text}
          </span>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={text}
              variants={swapVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={swap}
              className="truncate text-sm font-semibold whitespace-nowrap"
            >
              {searching ? (
                <Shimmer className="text-sm font-semibold" duration={1.6}>
                  {text}
                </Shimmer>
              ) : (
                text
              )}
            </motion.span>
          </AnimatePresence>
        </motion.span>
        <FaviconStack sources={sources} quiet={quiet} />
        <motion.span className="-ml-0.5 shrink-0 text-ink-3 transition-colors group-hover:text-ink-1" initial={false} animate={{ rotate: open ? 180 : 0 }} transition={quiet ? INSTANT : OPEN}>
          <Chevron />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <Collapse key="sources" quiet={quiet}>
            {count > 0 || skeletons > 0 ? (
              <ol data-slot="web-search-sources" className="grid grid-cols-2 gap-2 pt-2.5 @min-[32rem]:grid-cols-4">
                <AnimatePresence initial={false} mode="popLayout">
                  {shown.map((source, index) => (
                    <motion.li
                      key={source.id}
                      className="group/card min-w-0"
                      layout={!quiet}
                      variants={cardVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      transition={stagger(index)}
                    >
                      <SourceCard source={source} index={index + 1} />
                    </motion.li>
                  ))}
                  {Array.from({ length: skeletons }, (_, index) => (
                    <motion.li
                      key={`skeleton-${count + index}`}
                      aria-hidden
                      className="min-w-0"
                      layout={!quiet}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: 0.15 } }}
                      transition={stagger(count + index)}
                    >
                      <SkeletonCard quiet={quiet} delay={index * 0.12} />
                    </motion.li>
                  ))}
                  {hidden.length > 0 ? (
                    <motion.li
                      key="more"
                      className="group/card min-w-0"
                      layout={!quiet}
                      variants={cardVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      transition={stagger(COLUMNS - 1)}
                    >
                      <MoreCard sources={hidden} quiet={quiet} onClick={() => setExpanded(true)} />
                    </motion.li>
                  ) : null}
                  {expanded && count >= COLUMNS ? (
                    <motion.li key="less" className="group/card min-w-0" layout={!quiet} variants={cardVariants} initial="enter" animate="center" exit="exit" transition={stagger(count)}>
                      <button
                        type="button"
                        onClick={() => setExpanded(false)}
                        className={cx(
                          CARD_SHELL,
                          "group flex-row items-center justify-center gap-1.5 bg-transparent text-[12.5px] font-semibold text-ink-3 shadow-[inset_0_0_0_1px_var(--line)] group-hover/card:translate-y-0 hover:bg-surface-raised hover:text-ink-1 hover:shadow-none dark:bg-transparent dark:hover:bg-surface-card",
                        )}
                      >
                        <Chevron className="-ml-0.5 rotate-180 transition-transform duration-200 group-hover:-translate-y-px" />
                        Show less
                      </button>
                    </motion.li>
                  ) : null}
                </AnimatePresence>
              </ol>
            ) : fallback ? (
              <pre className="mt-2.5 max-h-40 overflow-auto rounded-[14px] bg-surface-raised px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-ink-2 dark:bg-surface-card">{fallback}</pre>
            ) : (
              <p className="px-1 pt-2.5 pb-1 text-sm text-ink-3">Nothing came back.</p>
            )}
          </Collapse>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={14} height={14} {...STROKE} strokeWidth={2.6} className={cx("block", className)}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function Collapse({ quiet, children }: { quiet: boolean; children: ReactNode }) {
  const [ref, height] = useSize<HTMLDivElement>("height");
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: height ?? "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={quiet ? INSTANT : { height: OPEN, opacity: { duration: 0.25 } }}
      className="-mx-1 overflow-hidden"
    >
      {/* The inset gives the hover lift and focus ring room before the clip. */}
      <div ref={ref} className="px-1 pb-1">
        {children}
      </div>
    </motion.div>
  );
}

function SourceCard({ source, index }: { source: SearchHit; index: number }) {
  return (
    <button
      type="button"
      data-slot="web-search-source"
      title={`${source.title} · ${source.url}`}
      onClick={(event) => openPage(source.url, event)}
      className={cx(CARD_SHELL, "group justify-between")}
    >
      <span className="line-clamp-2 text-[12.5px] leading-[17px] font-semibold text-ink-1/85 transition-colors group-hover:text-ink-1">{source.title}</span>
      <span className="flex items-center gap-1.5">
        <SiteLogo origin={`https://${source.host}`} size={16} rounded />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink-3">{siteLabel(source.url)}</span>
        <span className="text-[11px] font-semibold text-ink-3/70 tabular-nums">{index}</span>
      </span>
    </button>
  );
}

function MoreCard({ sources, quiet, onClick }: { sources: SearchHit[]; quiet: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={`Show ${sources.length} more sources`} className={cx(CARD_SHELL, "group justify-between")}>
      <FaviconStack sources={sources} quiet={quiet} />
      <span className="flex items-center gap-1 text-[12.5px] leading-[17px] font-semibold whitespace-nowrap text-ink-1/85 transition-colors group-hover:text-ink-1">
        <span className="relative inline-grid overflow-hidden tabular-nums">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={sources.length}
              initial={{ y: "100%", opacity: 0, filter: "blur(2px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: "-100%", opacity: 0, filter: "blur(2px)" }}
              transition={quiet ? INSTANT : SWAP}
            >
              {sources.length}
            </motion.span>
          </AnimatePresence>
        </span>
        more {sources.length === 1 ? "source" : "sources"}
      </span>
    </button>
  );
}

function SkeletonCard({ quiet, delay }: { quiet: boolean; delay: number }) {
  const bar = "rounded-full bg-fill-strong";
  return (
    <div className="relative flex h-[84px] flex-col justify-between overflow-hidden rounded-[14px] bg-surface-raised p-2.5 dark:bg-surface-card">
      <span className="flex flex-col gap-1.5 pt-0.5">
        <span className={cx(bar, "h-2.5 w-[88%]")} />
        <span className={cx(bar, "h-2.5 w-[60%]")} />
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cx(bar, "size-3.5 rounded-full")} />
        <span className={cx(bar, "h-2 w-12")} />
      </span>
      {quiet ? null : (
        <motion.span
          className="absolute inset-0 bg-linear-to-r from-transparent via-white/70 to-transparent dark:via-white/10"
          initial={{ x: "-100%" }}
          animate={{ x: "100%" }}
          transition={{ duration: 1.3, ease: "easeInOut", repeat: Infinity, delay }}
        />
      )}
    </div>
  );
}

function useSize<T extends HTMLElement>(side: "width" | "height") {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // offsetWidth rounds down, which is enough to tip the label into an ellipsis.
    const observer = new ResizeObserver(() => setSize(Math.ceil(node.getBoundingClientRect()[side])));
    observer.observe(node);
    return () => observer.disconnect();
  }, [side]);
  return [ref, size] as const;
}

function useHoverIntent(enterDelay: number) {
  const [active, setActive] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const set = (next: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(next), delay);
  };
  const hover = {
    onPointerEnter: (event: ReactPointerEvent) => event.pointerType === "mouse" && set(true, enterDelay),
    onPointerLeave: () => set(false, LEAVE_DELAY),
  };
  return { active, hover };
}

function FaviconStack({ sources, quiet, size = 20 }: { sources: SearchHit[]; quiet: boolean; size?: number }) {
  const { active: spread, hover } = useHoverIntent(SPREAD_DELAY);
  const shown: SearchHit[] = [];
  for (const source of sources) {
    if (shown.some((item) => item.host === source.host)) continue;
    shown.push(source);
    if (shown.length >= STACK) break;
  }
  const overlap = Math.round(size * 0.3) + 4;
  const shift = spread ? overlap - 2 : 0;
  if (!shown.length) return null;
  return (
    <motion.span
      data-slot="web-search-stack"
      {...hover}
      className="flex w-fit shrink-0 items-center"
      initial={false}
      animate={{ paddingRight: shift * Math.max(0, shown.length - 1) }}
      transition={quiet ? INSTANT : SPREAD}
    >
      <AnimatePresence initial={false}>
        {shown.map((source, index) => (
          <motion.span
            key={source.host}
            className={cx("relative rounded-full p-[2px]", PLATE)}
            style={{ zIndex: STACK - index, marginLeft: index === 0 ? 0 : -overlap }}
            initial={{ scale: 0, opacity: 0, x: shift * index }}
            animate={{ scale: 1, opacity: 1, x: shift * index }}
            exit={{ scale: 0, opacity: 0 }}
            transition={quiet ? INSTANT : { default: POP, x: SPREAD }}
          >
            <SiteLogo origin={`https://${source.host}`} size={size} rounded />
          </motion.span>
        ))}
      </AnimatePresence>
    </motion.span>
  );
}

function GlobeTile({ searching, progress, quiet }: { searching: boolean; progress: number; quiet: boolean }) {
  const fill = useMotionValue(searching ? 0 : 1);
  useEffect(() => {
    const target = searching ? progress : 1;
    if (quiet) {
      fill.jump(target);
      return;
    }
    let stopped = false;
    let creep: { stop: () => void } | undefined;
    const settle = animate(fill, target, RING);
    if (searching) {
      void settle.then(() => {
        if (stopped) return;
        creep = animate(fill, Math.min(1, target + (1 - target) * CREEP), { duration: CREEP_SECONDS, ease: "easeOut" });
      });
    }
    return () => {
      stopped = true;
      settle.stop();
      creep?.stop();
    };
  }, [searching, progress, quiet, fill]);

  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-card text-ink-3 shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors group-hover:text-ink-1 dark:bg-surface-raised">
      <svg aria-hidden viewBox="0 0 24 24" width={15} height={15} {...STROKE} strokeWidth={2}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
      </svg>
      <motion.svg
        aria-hidden
        viewBox="0 0 28 28"
        className="absolute inset-0 size-full -rotate-90 text-ink-1"
        initial={false}
        animate={{ opacity: searching ? 1 : 0 }}
        transition={quiet ? INSTANT : { duration: 0.3, delay: searching ? 0 : RING_HOLD }}
      >
        <circle {...RING_CIRCLE} className="opacity-[0.12]" />
        <motion.circle {...RING_CIRCLE} style={{ pathLength: fill }} />
      </motion.svg>
    </span>
  );
}
