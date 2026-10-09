import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "../../lib/native";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { MenuItem, PointMenu } from "../../shared/ui/controls";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GripVertical,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Plus,
  Terminal,
  X,
} from "../../shared/ui/icons";
import { useShell, type DockPosition } from "../shell/shellStore";
import { TerminalView } from "./TerminalView";

/** Orbit's dock sizes (`projects/model/projectTerminal.ts`). */
const DOCK_SIZE_DEFAULT: Record<DockPosition, number> = { top: 220, bottom: 220, left: 360, right: 360 };
const VERTICAL_MIN = 88;
const HORIZONTAL_MIN = 180;

const SIDE_ITEMS: { id: DockPosition; label: string }[] = [
  { id: "bottom", label: "Dock Bottom" },
  { id: "top", label: "Dock Top" },
  { id: "left", label: "Dock Left" },
  { id: "right", label: "Dock Right" },
];

function isVertical(side: DockPosition) {
  return side === "top" || side === "bottom";
}

function clampDockSize(side: DockPosition, value: number) {
  const vertical = isVertical(side);
  const min = vertical ? VERTICAL_MIN : HORIZONTAL_MIN;
  const span = vertical ? window.innerHeight : window.innerWidth;
  const max = Math.max(min, Math.floor(span * 0.7));
  if (!Number.isFinite(value)) return DOCK_SIZE_DEFAULT[side];
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sideIcon(side: DockPosition) {
  if (side === "top") return PanelTop;
  if (side === "left") return PanelLeft;
  if (side === "right") return PanelRight;
  return PanelBottom;
}

function hideIcon(side: DockPosition) {
  if (side === "top") return ChevronUp;
  if (side === "left") return ChevronLeft;
  if (side === "right") return ChevronRight;
  return ChevronDown;
}

type Tab = { id: string; label: string; cwd: string };

/**
 * Orbit's `ProjectTerminalDock`: a resizable pane on any side of the chat,
 * a tab strip whose trailing controls are new-terminal / move / hide, and every
 * terminal kept mounted (only the active one visible).
 */
export function TerminalDock({ cwd, open }: { cwd: string; open: boolean }) {
  const side = useShell((state) => state.terminalPosition);
  const setSide = useShell((state) => state.setTerminalPosition);
  const size = useShell((state) => state.terminalSize);
  const setSize = useShell((state) => state.setTerminalSize);
  const setOpen = useShell((state) => state.setTerminalOpen);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const sideButton = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const vertical = isVertical(side);
  const SideIcon = sideIcon(side);
  const HideIcon = hideIcon(side);

  const spawn = useCallback(() => {
    const tab: Tab = { id: `term-${crypto.randomUUID()}`, label: "pi", cwd };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    setOpen(true);
    return tab;
  }, [cwd, setOpen]);

  const close = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      setActiveId((active) => (active === id ? (next.at(-1)?.id ?? null) : active));
      if (next.length === 0) setOpen(false);
      return next;
    });
  };

  // Switching projects retires shells pointed at the old checkout.
  useEffect(() => {
    const stale = tabs.filter((tab) => tab.cwd !== cwd);
    if (stale.length === 0) return;
    for (const tab of stale) void invoke("pty_kill", { id: tab.id }).catch(() => undefined);
    setTabs((current) => current.filter((tab) => tab.cwd === cwd));
  }, [cwd, tabs]);

  // Opening comes from the footer button, ⌘J, or the "open" flag.
  useEffect(() => {
    if (open && tabs.length === 0) spawn();
  }, [open, spawn, tabs.length]);

  const paint = (value: number) => {
    setSize(value);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { start: vertical ? event.clientY : event.clientX, size };
    setDragging(true);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const point = vertical ? event.clientY : event.clientX;
    const delta = point - drag.current.start;
    const signed = side === "bottom" || side === "right" ? -delta : delta;
    paint(clampDockSize(side, drag.current.size + signed));
  };

  const onResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setSize(clampDockSize(side, size));
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  if (!open) return null;

  const sash =
    side === "top"
      ? "absolute inset-x-0 -bottom-px z-10 h-1.5 cursor-row-resize touch-none"
      : side === "bottom"
        ? "absolute inset-x-0 -top-px z-10 h-1.5 cursor-row-resize touch-none"
        : side === "left"
          ? "absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none"
          : "absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none";

  return (
    <section
      data-project-terminal-dock=""
      aria-label="终端"
      style={vertical ? { height: size } : { width: size }}
      className={`relative flex h-full min-h-0 min-w-0 shrink-0 flex-col bg-transparent ${
        side === "top" ? "border-b" : side === "bottom" ? "border-t" : side === "left" ? "border-r" : "border-l"
      } border-stroke`}
    >
      <div
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label="调整终端大小"
        aria-valuenow={size}
        className={`${sash} ${dragging ? "bg-content/15" : "hover:bg-content/10"}`}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onDoubleClick={() => setSize(DOCK_SIZE_DEFAULT[side])}
      />
      <div className="flex h-9 min-w-0 shrink-0 border-b border-stroke">
        <div role="tablist" aria-label="终端标签" className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-none pl-1.5 pr-2.5">
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div key={tab.id} className="group relative flex h-full w-56 min-w-28 shrink items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={tab.label}
                  onClick={() => setActiveId(tab.id)}
                  className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 pr-7 text-left text-[13px] ${
                    active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
                  }`}
                >
                  <Terminal className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                </button>
                <button
                  type="button"
                  title="关闭终端"
                  aria-label={`关闭 ${tab.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    close(tab.id);
                  }}
                  className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 opacity-0 hover:bg-content/10 hover:text-content group-hover:opacity-100"
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              </div>
            );
          })}
          <div className="min-w-4 flex-1" />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
          <button
            type="button"
            title="新建终端 (⌘`)"
            aria-label="新建终端"
            onClick={spawn}
            className="grid size-6.5 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          <div ref={sideButton}>
            <button
              type="button"
              title="移动终端"
              aria-label="移动终端"
              onClick={() => {
                const rect = sideButton.current?.getBoundingClientRect();
                if (!rect) return;
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }}
              className="grid size-6.5 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
            >
              <SideIcon className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
          <button
            type="button"
            title="收起终端 (⌘J)"
            aria-label="收起终端"
            onClick={() => setOpen(false)}
            className="grid size-6.5 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <HideIcon className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div ref={lockOverscroll} className="relative min-h-0 min-w-0 flex-1">
        {tabs.map((tab) => (
          <div key={tab.id} aria-hidden={tab.id !== activeId} className={tab.id === activeId ? "absolute inset-0 h-full" : "hidden"}>
            <TerminalView id={tab.id} cwd={tab.cwd} active={tab.id === activeId} />
          </div>
        ))}
      </div>
      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="移动终端" width={180} onClose={() => setMenu(null)}>
          {SIDE_ITEMS.map((item) => (
            <MenuItem
              key={item.id}
              onClick={() => {
                setSide(item.id);
                setSize(DOCK_SIZE_DEFAULT[item.id]);
                setMenu(null);
              }}
            >
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                {item.label}
                {item.id === side ? <span className="text-content/55">✓</span> : null}
              </span>
            </MenuItem>
          ))}
        </PointMenu>
      ) : null}
      {/* Keeps the grip glyph in the strip's visual vocabulary, like SurfaceTabs. */}
      <span aria-hidden className="pointer-events-none absolute left-0 top-2.5 hidden">
        <GripVertical className="size-3.5" />
      </span>
    </section>
  );
}
