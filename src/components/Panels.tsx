import { lazy, Suspense } from "react";
import { useWorkspace, type Panel as PanelName } from "../lib/store";
import { useLockOverscroll } from "../shared/hooks/useLockOverscroll";

const CommandsPanel = lazy(() => import("./panels/CommandsPanel").then((module) => ({ default: module.CommandsPanel })));
const MobileAccessPanel = lazy(() => import("./panels/MobileAccessPanel").then((module) => ({ default: module.MobileAccessPanel })));
const NotesPanel = lazy(() => import("./panels/NotesPanel").then((module) => ({ default: module.NotesPanel })));
const ArtifactsPanel = lazy(() => import("./panels/ArtifactsPanel").then((module) => ({ default: module.ArtifactsPanel })));
const PiToolsPage = lazy(() => import("../features/settings/pages/PiToolsPage").then((module) => ({ default: module.PiToolsPage })));
const SessionsPage = lazy(() => import("../features/settings/pages/SessionsPage").then((module) => ({ default: module.SessionsPage })));
const TreePanel = lazy(() => import("./panels/TreePanel").then((module) => ({ default: module.TreePanel })));
const ChangesPanel = lazy(() => import("./panels/ChangesPanel").then((module) => ({ default: module.ChangesPanel })));

/** 这些整页界面由 `App` 自己画在旁边（设置/收件箱/搜索/自动化），`Panel` 里不该有内容。 */
const OVERLAY_PANELS = new Set<PanelName>(["settings", "inbox", "search", "automations"]);

function panelComponent(panel: PanelName) {
  if (panel === "commands") return <CommandsPanel />;
  if (panel === "mobile-access") return <MobileAccessPanel />;
  if (panel === "notes") return <NotesPanel />;
  if (panel === "artifacts") return <ArtifactsPanel />;
  if (panel === "pi-tools") return <PiToolsPage />;
  if (panel === "sessions") return <SessionsPage />;
  if (panel === "tree") return <TreePanel />;
  if (panel === "changes") return <ChangesPanel />;
  return <CommandsPanel />;
}

/** A full-page Orbit surface opened from the project rail. */
export function Panel() {
  const panel = useWorkspace((state) => state.panel);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // 语音页常驻在 App 层，不归 Panel 管。这里必须**整块返回 null**（而不是渲染一个空
  // 的 flex-1 容器）：否则它会和语音页平分高度，球就被挤到下半区去。
  if (panel === "voice") return null;
  // 整页 overlay 同理，而且更糟：以前它们会落到 `panelComponent` 的兜底、把
  // `CommandsPanel` 挂起来——看不见，却要加载 chunk、发一次 `get_commands` RPC、
  // 再把整份命令列表渲染一遍。这就是“一进设置页就卡”的主要来源。
  if (OVERLAY_PANELS.has(panel)) return null;
  // Notes is a two-pane surface with its own scrolling; it wants the full
  // bleed instead of the constrained settings column.
  const fullBleed = panel === "notes" || panel === "artifacts";
  return (
    <div ref={lockOverscroll} className={fullBleed ? "flex min-h-0 flex-1 flex-col" : "min-h-0 flex-1 overflow-y-auto overscroll-none"}>
      {fullBleed ? (
        // 整页面板是 lazy chunk：fallback 必须是块占位，不能是 null——null 会让这块
        // 在 chunk 到达前塌成背景色，切页面时看起来像"闪了一下黑"。
        <Suspense fallback={<div className="min-h-0 flex-1" />}>{panelComponent(panel)}</Suspense>
      ) : (
        <section className="panel-surface">
          <Suspense fallback={null}>{panelComponent(panel)}</Suspense>
        </section>
      )}
    </div>
  );
}
