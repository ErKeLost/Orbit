import { useEffect, useState } from "react";
import { MetricsSync } from "./lib/metrics";
import { useWorkspace } from "./lib/store";
import { useWorkspaceBootstrap, useWorkspaceShortcuts } from "./hooks/use-workspace-shell";
import { useDesktopNotifications } from "./hooks/use-desktop-integration";
import { RemotePairingScreen } from "./components/remote/RemotePairingScreen";
import { ScreenOverlay } from "./components/screen/ScreenOverlay";
import { Panel } from "./components/Panels";
import { flushForegroundEvents } from "./lib/rpc";
import { ProjectRail } from "./features/shell/ProjectRail";
import { CompactRail } from "./features/shell/CompactRail";
import { SessionSidebar } from "./features/shell/SessionSidebar";
import { TitleBar } from "./features/shell/TitleBar";
import { FileView } from "./features/shell/FileView";
import { MobileShell } from "./features/shell/MobileShell";
import { useShell } from "./features/shell/shellStore";
import { ChatPane } from "./features/chat/ChatPane";
import { SettingsView } from "./features/settings/SettingsView";
import { InboxView } from "./features/inbox/InboxView";
import { SearchView } from "./features/search/SearchView";
import { AutomationsView } from "./features/automations/AutomationsView";
import { useAutomationScheduler } from "./features/automations/useAutomationScheduler";
import { GripVertical, X } from "./shared/ui/icons";
import { compactTitle } from "./lib/session-visual";

/** Phone-sized windows and the Android app use the stacked MobileShell. */
const MOBILE_QUERY = "(max-width: 760px)";

function useMobileLayout(forced: boolean) {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return forced || matches;
}

/** The chat pane's own header when a file splits the view (MonoCode SessionPane `inSplit`). */
function SplitPaneHeader() {
  const sessionName = useWorkspace((state) => state.state?.sessionName);
  const first = useWorkspace((state) => {
    const message = state.transcript.messages.find((item) => item.message.role === "user")?.message;
    if (!message) return "";
    if (typeof message.content === "string") return message.content;
    return (message.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(" ");
  });
  const title = compactTitle(sessionName || first, "新会话", 60);
  return (
    <div className="flex h-9 shrink-0 select-none items-center gap-1.5 border-b border-stroke px-2">
      <GripVertical className="size-3.5 shrink-0 text-content/35" strokeWidth={1.75} />
      <span className="size-2 shrink-0 rounded-full bg-transparent" />
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={title}>{title}</span>
      <button
        type="button"
        title="关闭文件"
        aria-label="关闭文件"
        onClick={() => {
          const shell = useShell.getState();
          if (shell.activeFile) shell.closeFile(shell.activeFile);
        }}
        className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content"
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function WorkArea() {
  const panel = useWorkspace((state) => state.panel);

  const cwd = useWorkspace((state) => state.cwd);
  const connectionId = useWorkspace((state) => state.connectionId);
  const files = useShell((state) => state.files);
  const activeFile = useShell((state) => state.activeFile);
  const projectRailOpen = useShell((state) => state.projectRailOpen);
  const sessionSidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const file = files.find((item) => item.path === activeFile);

  // Switching connections catches the newly visible stream up at once.
  useEffect(() => {
    flushForegroundEvents();
  }, [connectionId]);

  if (panel === "settings") return <SettingsView />;
  if (panel === "inbox") return <InboxView />;
  if (panel === "search") return <SearchView />;
  if (panel === "automations") return <AutomationsView />;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TitleBar railsHidden={!projectRailOpen && !sessionSidebarOpen} />
      <MetricsSync />
      {panel === "chat" ? (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="chat-pane-background relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col">
            {file ? <SplitPaneHeader /> : null}
            <ChatPane key={connectionId || cwd} />
          </div>
          {file ? <FileView file={file} cwd={cwd} /> : null}
        </div>
      ) : (
        <Panel />
      )}
    </section>
  );
}

export default function App() {
  const projectRailOpen = useShell((state) => state.projectRailOpen);
  const sessionSidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const panel = useWorkspace((state) => state.panel);
  const chromeless = panel === "settings" || panel === "inbox" || panel === "search" || panel === "automations" || panel === "mobile-access" || panel === "notes";
  useAutomationScheduler();
  const collapsedRailMode = useShell((state) => state.collapsedRailMode);
  const bootstrap = useWorkspaceBootstrap();
  const online = useWorkspace((state) => state.connection === "online");
  const mobile = useMobileLayout(bootstrap.runtimeTarget === "mobile");
  useWorkspaceShortcuts(online, (value) => {
    const shell = useShell.getState();
    const next = typeof value === "function" ? value(shell.sessionSidebarOpen) : value;
    shell.setSessionSidebarOpen(next);
  });
  useDesktopNotifications();
  const openSearch = () => useWorkspace.getState().set({ panel: "search" });

  if (bootstrap.runtimeTarget === "mobile" && bootstrap.pairing.required) {
    return (
      <RemotePairingScreen
        pairingUri={bootstrap.pairing.uri}
        connecting={bootstrap.pairing.connecting}
        error={bootstrap.pairing.error}
        onPairingUriChange={bootstrap.setPairingUri}
        onConnect={(value) => void bootstrap.connectPairing(value)}
      />
    );
  }

  if (mobile) {
    return (
      <>
        <MobileShell onSearch={openSearch} />
        <ScreenOverlay />
      </>
    );
  }

  return (
    <div className="workspace-background flex h-full flex-col bg-background-base text-content">
      <div className="flex min-h-0 min-w-0 flex-1">
        {projectRailOpen ? (
          <ProjectRail visible onSearch={openSearch} />
        ) : collapsedRailMode === "compact" && !chromeless ? (
          <CompactRail />
        ) : null}
        <SessionSidebar visible={sessionSidebarOpen && !chromeless} railVisible={projectRailOpen} onSearch={openSearch} />
        <WorkArea />
      </div>
      <ScreenOverlay />
    </div>
  );
}
