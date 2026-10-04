import { AnimatePresence } from "motion/react";
import type { LiveSession, Panel as PanelName } from "../../lib/store";
import { useWorkspace } from "../../lib/store";
import { MetricsSync } from "../../lib/metrics";
import { Chat } from "../Chat";
import { Inspector } from "../Inspector";
import { Panel } from "../Panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceInspectorDrawer } from "./WorkspaceDrawer";
import { WorkspaceTitlebar } from "./WorkspaceTitlebar";

type WorkspaceLayoutProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  online: boolean;
  panel: PanelName;
  title: string;
  rawTitle: string;
  liveSessions: LiveSession[];
  currentSessionFile?: string;
  narrow: boolean;
};

export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const { sidebarOpen, onToggleSidebar, online, panel, title, rawTitle, liveSessions, currentSessionFile, narrow } = props;
  const cwd = useWorkspace(state => state.cwd);
  const connectionId = useWorkspace(state => state.connectionId);
  const inspector = useWorkspace(state => state.inspector);
  const statuses = useWorkspace(state => state.statuses);
  return <>
    <ResizablePanelGroup key={`workspace-layout-v6-${narrow ? "narrow" : "wide"}`} id="workspace-layout" orientation="horizontal">
    {!narrow && sidebarOpen && <>
      <ResizablePanel id="sidebar" defaultSize="260px" minSize="220px" maxSize="330px" groupResizeBehavior="preserve-pixel-size">
        <WorkspaceSidebar {...{ sidebarOpen, onToggleSidebar, online, panel, liveSessions, currentSessionFile }} />
      </ResizablePanel>
      <ResizableHandle />
    </>}
    <ResizablePanel id="workspace" minSize={narrow ? 0 : "420px"} groupResizeBehavior="preserve-relative-size">
      <section className="workspace">
        <WorkspaceTitlebar variant="workspace" sidebarOpen={narrow ? false : sidebarOpen} onToggleSidebar={onToggleSidebar} title={title} rawTitle={rawTitle} showMenu={panel === "chat"} />
        <MetricsSync />
        <div className="work-content"><div className="main-content"><div className="chat-host" hidden={panel !== "chat"}><Chat key={connectionId || cwd} /></div><AnimatePresence mode="wait">{panel !== "chat" && <Panel key={panel} />}</AnimatePresence></div></div>
        {Object.entries(statuses).flatMap(([key, value]) => !key.startsWith("gui-") && value ? [<div key={key} className="extension-status">{key}: {value}</div>] : [])}
      </section>
    </ResizablePanel>
    {!narrow && inspector && <>
      <ResizableHandle />
      <ResizablePanel id="inspector" defaultSize="300px" minSize="260px" maxSize="380px" groupResizeBehavior="preserve-pixel-size">
        <section className="inspector-pane"><WorkspaceTitlebar variant="inspector" sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} /><Inspector /></section>
      </ResizablePanel>
    </>}
    </ResizablePanelGroup>
    {narrow && <WorkspaceInspectorDrawer open={inspector} onClose={() => useWorkspace.getState().set({ inspector: false })} />}
  </>;
}
