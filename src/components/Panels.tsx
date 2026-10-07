import { lazy, Suspense } from "react";
import { useWorkspace, type Panel as PanelName } from "../lib/store";
import { useLockOverscroll } from "../shared/hooks/useLockOverscroll";

const CommandsPanel = lazy(() => import("./panels/CommandsPanel").then((module) => ({ default: module.CommandsPanel })));
const MobileAccessPanel = lazy(() => import("./panels/MobileAccessPanel").then((module) => ({ default: module.MobileAccessPanel })));
const NotesPanel = lazy(() => import("./panels/NotesPanel").then((module) => ({ default: module.NotesPanel })));
const PiToolsPanel = lazy(() => import("./panels/PiToolsPanel").then((module) => ({ default: module.PiToolsPanel })));
const SessionsPanel = lazy(() => import("./panels/SessionsPanel").then((module) => ({ default: module.SessionsPanel })));
const TreePanel = lazy(() => import("./panels/TreePanel").then((module) => ({ default: module.TreePanel })));
const ChangesPanel = lazy(() => import("./panels/ChangesPanel").then((module) => ({ default: module.ChangesPanel })));
const ConsolePanel = lazy(() => import("./panels/ConsolePanel").then((module) => ({ default: module.ConsolePanel })));

function panelComponent(panel: PanelName) {
  if (panel === "commands") return <CommandsPanel />;
  if (panel === "mobile-access") return <MobileAccessPanel />;
  if (panel === "notes") return <NotesPanel />;
  if (panel === "pi-tools") return <PiToolsPanel />;
  if (panel === "sessions") return <SessionsPanel />;
  if (panel === "tree") return <TreePanel />;
  if (panel === "changes") return <ChangesPanel />;
  return <ConsolePanel />;
}

/** A full-page Orbit surface opened from the project rail. */
export function Panel() {
  const panel = useWorkspace((state) => state.panel);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // Notes is a two-pane surface with its own scrolling; it wants the full
  // bleed instead of the constrained settings column.
  const fullBleed = panel === "notes";
  return (
    <div ref={lockOverscroll} className={fullBleed ? "flex min-h-0 flex-1 flex-col" : "min-h-0 flex-1 overflow-y-auto overscroll-none"}>
      {fullBleed ? (
        <Suspense fallback={null}>{panelComponent(panel)}</Suspense>
      ) : (
        <section className="panel-surface">
          <Suspense fallback={null}>{panelComponent(panel)}</Suspense>
        </section>
      )}
    </div>
  );
}
