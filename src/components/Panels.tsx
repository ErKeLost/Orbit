import { lazy, Suspense } from "react";
import { m } from "motion/react";
import { useWorkspace, type Panel as PanelName } from "../lib/store";
import { SettingsPanel } from "./panels/SettingsPanel";

const SessionsPanel = lazy(() => import("./panels/SessionsPanel").then(module => ({ default: module.SessionsPanel })));
const TreePanel = lazy(() => import("./panels/TreePanel").then(module => ({ default: module.TreePanel })));
const CommandsPanel = lazy(() => import("./panels/CommandsPanel").then(module => ({ default: module.CommandsPanel })));
const ChangesPanel = lazy(() => import("./panels/ChangesPanel").then(module => ({ default: module.ChangesPanel })));
const PiToolsPanel = lazy(() => import("./panels/PiToolsPanel").then(module => ({ default: module.PiToolsPanel })));
const ConsolePanel = lazy(() => import("./panels/ConsolePanel").then(module => ({ default: module.ConsolePanel })));
const MobileAccessPanel = lazy(() => import("./panels/MobileAccessPanel").then(module => ({ default: module.MobileAccessPanel })));
const ScreenPanel = lazy(() => import("./panels/ScreenPanel").then(module => ({ default: module.ScreenPanel })));

function panelComponent(panel: PanelName) {
  if (panel === "sessions") return <SessionsPanel />;
  if (panel === "tree") return <TreePanel />;
  if (panel === "commands") return <CommandsPanel />;
  if (panel === "settings") return <SettingsPanel />;
  if (panel === "mobile-access") return <MobileAccessPanel />;
  if (panel === "screen") return <ScreenPanel />;
  if (panel === "changes") return <ChangesPanel />;
  if (panel === "pi-tools") return <PiToolsPanel />;
  return <ConsolePanel />;
}

/**
 * The screen panel, kept mounted for as long as the workspace is.
 *
 * It is deliberately not part of [`Panel`]: that component unmounts on every
 * tab change, which for the screen would release the subscription and make the
 * desktop restart capture. `visible` tells it whether it is on screen so it can
 * skip drawing, but the preview itself keeps running.
 */
export function ScreenHost({ visible }: { visible: boolean }) {
  const panel = useWorkspace(state => state.panel);
  return <div className="screen-host" hidden={panel !== "screen"}>
    <Suspense fallback={null}><ScreenPanel visible={visible} /></Suspense>
  </div>;
}

export function Panel() {
  const panel = useWorkspace(state => state.panel);
  return <m.section className={`panel-view ${panel === "settings" ? "settings-panel-view" : ""}`} initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.16 }}>
    <Suspense fallback={null}>{panelComponent(panel)}</Suspense>
  </m.section>;
}

export { ExtensionDialog } from "./panels/ExtensionDialog";
