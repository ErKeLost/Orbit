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
import { MIN_PANE_SHARE } from "./shellStore";

/**
 * MonoCode's pane chrome, ported from `features/workspace/ui/PaneTree.tsx`:
 * the draggable sash between panes (`Sash` + `layout.ts setSplitRatio`), the
 * drop hint shown while a pane is being dragged, and the session pane's own
 * header (`features/sessions/ui/SessionPane.tsx` `inSplit` branch).
 */

/** MonoCode `setSplitRatio` clamps both sides of a sash to `MIN_SIZE`. */
function clampPaneShare(share: number) {
  return Math.min(1 - MIN_PANE_SHARE, Math.max(MIN_PANE_SHARE, share));
}

/**
 * MonoCode's `Sash`: a 1px rule with a ±6px grab area. The drag previews
 * through `onPreview` (rAF-throttled) and only commits on release, so the
 * layout is written once per drag.
 */
export function PaneSash({
  containerRef,
  share,
  onPreview,
  onCommit,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  share: number;
  onPreview: (share: number | null) => void;
  onCommit: (share: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      style={{ order: 2 }}
      className="relative z-10 w-px shrink-0 bg-stroke"
    >
      <div
        className="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize touch-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const parent = containerRef.current;
          if (!parent) return;
          const handle = event.currentTarget;
          const pointerId = event.pointerId;
          handle.setPointerCapture(pointerId);
          const restoreSelection = suppressTextSelection();
          setGrabbing(true);
          const previousCursor = document.body.style.cursor;
          document.body.style.cursor = "col-resize";
          let frame: number | null = null;
          let next = share;

          const move = (ev: globalThis.PointerEvent) => {
            if (ev.pointerId !== pointerId) return;
            const rect = parent.getBoundingClientRect();
            if (rect.width <= 0) return;
            next = clampPaneShare((ev.clientX - rect.left) / rect.width);
            if (frame != null) return;
            frame = requestAnimationFrame(() => {
              frame = null;
              onPreview(next);
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
            if (commit) onCommit(next);
            else onPreview(null);
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

/** MonoCode's `PaneDropHint`: which side the dragged pane lands on. */
export function PaneDropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-accent/50">
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground shadow-lg">
        移到这一侧
      </span>
    </div>
  );
}

/**
 * The session pane's own header. MonoCode only renders it while the pane is in
 * a split (`SessionPane.tsx` `inSplit`), and its buttons close the pane — for
 * Orbit's chat pane that is the session itself.
 */
export function SessionPaneHeader({
  onPaneDragStart,
}: {
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
      {onPaneDragStart ? <GripVertical className="size-3.5 shrink-0 text-content/35" strokeWidth={1.75} /> : null}
      <span className={`size-2 shrink-0 rounded-full ${running ? "bg-accent" : "bg-content/20"}`} />
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={title}>{title}</span>
      {running ? <TerminalSpinner className="shrink-0 select-none text-[11px] leading-none text-accent" /> : null}
      <button
        type="button"
        data-no-drag
        title="关闭会话"
        aria-label="关闭会话"
        disabled={!session}
        onClick={() => void closeSession()}
        className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}
