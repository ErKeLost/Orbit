import { useMemo } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { queryClient, report, retireSession } from "../../lib/rpc";
import { compactTitle } from "../../lib/session-visual";
import { useWorkspace } from "../../lib/store";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";
import { setGrabbing, suppressTextSelection } from "../../shared/lib/drag";
import { toast } from "../../shared/ui/toast";
import { GripVertical, X } from "../../shared/ui/icons";
import { TerminalSpinner } from "./TerminalSpinner";
import type { LayoutRect, LayoutSash, PaneEdge } from "./paneLayout";

/**
 * MonoCode's pane chrome, ported from `features/workspace/ui/PaneTree.tsx`:
 * the sash between panes (`Sash` + `layout.ts setSplitRatio`), the edge hint
 * shown while a pane is dragged (`PaneDropHint`), and the session pane's own
 * header (`features/sessions/ui/SessionPane.tsx` `inSplit` branch).
 */

function sashStyle(sash: LayoutSash, boundary: number) {
  const row = sash.dir === "right";
  const group: LayoutRect = sash.group;
  return row
    ? {
        left: `${(group.x + boundary * group.w) * 100}%`,
        top: `${group.y * 100}%`,
        height: `${group.h * 100}%`,
      }
    : {
        left: `${group.x * 100}%`,
        top: `${(group.y + boundary * group.h) * 100}%`,
        width: `${group.w * 100}%`,
      };
}

/**
 * MonoCode's `Sash`: a 1px rule with a ±6px grab area. The drag previews
 * through `onPreview` (rAF-throttled) and only commits on release.
 */
export function PaneSash({
  sash,
  containerRef,
  onPreview,
  onCommit,
  onCancel,
}: {
  sash: LayoutSash;
  containerRef: RefObject<HTMLDivElement | null>;
  onPreview: (boundary: number) => void;
  onCommit: (boundary: number) => void;
  onCancel: () => void;
}) {
  const row = sash.dir === "right";
  const boundary = sash.sizes
    .slice(0, sash.index + 1)
    .reduce((sum, size) => sum + size, 0);

  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(boundary * 100)}
      className={row ? "absolute z-10 w-px bg-stroke" : "absolute z-10 h-px bg-stroke"}
      style={sashStyle(sash, boundary)}
    >
      <div
        className={
          row
            ? "absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize touch-none"
            : "absolute inset-x-0 -top-1.5 -bottom-1.5 cursor-row-resize touch-none"
        }
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const handle = event.currentTarget;
          const parent = containerRef.current;
          if (!parent) return;
          const pointerId = event.pointerId;
          handle.setPointerCapture(pointerId);
          const restoreSelection = suppressTextSelection();
          setGrabbing(true);
          const previousCursor = document.body.style.cursor;
          document.body.style.cursor = row ? "col-resize" : "row-resize";

          const rect = parent.getBoundingClientRect();
          const origin = row
            ? rect.left + sash.group.x * rect.width
            : rect.top + sash.group.y * rect.height;
          const span = row
            ? sash.group.w * rect.width
            : sash.group.h * rect.height;
          let nextBoundary = boundary;
          let frame: number | null = null;

          const move = (ev: globalThis.PointerEvent) => {
            if (ev.pointerId !== pointerId || span <= 0) return;
            const position = row ? ev.clientX : ev.clientY;
            nextBoundary = (position - origin) / span;
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
              frame = null;
              onPreview(nextBoundary);
            });
          };
          const finish = (commit: boolean) => {
            if (frame != null) {
              cancelAnimationFrame(frame);
              frame = null;
            }
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", onKey);
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
            restoreSelection();
            setGrabbing(false);
            document.body.style.cursor = previousCursor;
            if (commit) onCommit(nextBoundary);
            else onCancel();
          };
          const up = (ev: globalThis.PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            move(ev);
            finish(true);
          };
          const cancel = () => finish(false);
          const onKey = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            ev.preventDefault();
            finish(false);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
          window.addEventListener("pointercancel", cancel);
          window.addEventListener("keydown", onKey);
        }}
      />
    </div>
  );
}

/** MonoCode's `PaneDropHint`: the half of the target pane the drop lands in. */
export function PaneDropHint({ edge }: { edge: PaneEdge }) {
  const wash =
    edge === "left"
      ? "absolute inset-y-0 left-0 w-1/2 bg-accent/15"
      : edge === "right"
        ? "absolute inset-y-0 right-0 w-1/2 bg-accent/15"
        : edge === "top"
          ? "absolute inset-x-0 top-0 h-1/2 bg-accent/15"
          : "absolute inset-x-0 bottom-0 h-1/2 bg-accent/15";
  const line =
    edge === "left"
      ? "absolute inset-y-0 left-0 w-0.5 bg-accent"
      : edge === "right"
        ? "absolute inset-y-0 right-0 w-0.5 bg-accent"
        : edge === "top"
          ? "absolute inset-x-0 top-0 h-0.5 bg-accent"
          : "absolute inset-x-0 bottom-0 h-0.5 bg-accent";
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className={wash} />
      <div className={line} />
    </div>
  );
}

/**
 * The session pane's own header, shown while the pane shares the workspace with
 * another pane (`SessionPane.tsx` `inSplit`). Its buttons close the pane — for
 * Orbit's chat pane that is the session itself.
 */
export function SessionPaneHeader({
  showGrip,
  focused,
  onClosePane,
  onPaneDragStart,
}: {
  showGrip: boolean;
  /** MonoCode paints the pane's focus dot accent while the pane has focus. */
  focused: boolean;
  /** With several session panes the button closes the pane, not the session. */
  onClosePane?: () => void;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const cwd = useWorkspace((state) => state.cwd);
  const sessionFile = useWorkspace((state) => state.state?.sessionFile);
  const running = useWorkspace((state) => state.transcript.running);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const sessions = useProjectSessions(cwd);
  const merged = useMemo(
    () => mergeProjectSessions(cwd, sessions.data ?? [], liveSessions),
    [cwd, sessions.data, liveSessions],
  );
  const session = merged.sessions.find((item) => item.path === sessionFile);
  const title = compactTitle(session?.name || session?.firstMessage, "新会话", 60);

  const closeSession = async () => {
    if (!session) return;
    try {
      await retireSession(session.path);
      await queryClient.invalidateQueries({ queryKey: ["pi", "sessions", cwd] });
      toast.success("会话已关闭");
    } catch (error) {
      report(error);
    }
  };

  return (
    <div
      className={`flex h-9 shrink-0 select-none items-center gap-1.5 border-b border-stroke px-2 ${onPaneDragStart ? "cursor-grab touch-none active:cursor-grabbing" : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !onPaneDragStart) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        onPaneDragStart(event);
      }}
    >
      {showGrip ? <GripVertical className="size-3.5 shrink-0 text-content/35" strokeWidth={1.75} /> : null}
      <span className={`size-2 shrink-0 rounded-full ${focused ? "bg-accent" : "bg-content/20"}`} />
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={title}>{title}</span>
      {running ? <TerminalSpinner className="shrink-0 select-none text-[11px] leading-none text-accent" /> : null}
      <button
        type="button"
        data-no-drag
        title={onClosePane ? "关闭面板" : "关闭会话"}
        aria-label={onClosePane ? "关闭面板" : "关闭会话"}
        disabled={!onClosePane && !session}
        onClick={() => (onClosePane ? onClosePane() : void closeSession())}
        className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}
