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

function panelComponent(panel: PanelName) {
  if (panel === "sessions") return <SessionsPanel />;
  if (panel === "tree") return <TreePanel />;
  if (panel === "commands") return <CommandsPanel />;
  if (panel === "settings") return <SettingsPanel />;
  if (panel === "mobile-access") return <MobileAccessPanel />;
  if (panel === "changes") return <ChangesPanel />;
  if (panel === "pi-tools") return <PiToolsPanel />;
  return <ConsolePanel />;
}

export function Panel() {
  const panel = useWorkspace(state => state.panel);
  return <m.section className={`panel-view ${panel === "settings" ? "settings-panel-view" : ""}`} initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.16 }}>
    <Suspense fallback={null}>{panelComponent(panel)}</Suspense>
  </m.section>;
}

export { ExtensionDialog } from "./panels/ExtensionDialog";
