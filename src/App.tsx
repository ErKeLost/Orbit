import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
import { PaneDropHint, PaneSash, SessionPaneHeader } from "./features/shell/PaneChrome";

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

function WorkArea() {
  const panel = useWorkspace((state) => state.panel);

  const cwd = useWorkspace((state) => state.cwd);
  const connectionId = useWorkspace((state) => state.connectionId);
  const files = useShell((state) => state.files);
  const activeFile = useShell((state) => state.activeFile);
  const projectRailOpen = useShell((state) => state.projectRailOpen);
  const sessionSidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const paneOrder = useShell((state) => state.paneOrder);
  const setPaneOrder = useShell((state) => state.setPaneOrder);
  const splitRatio = useShell((state) => state.splitRatio);
  const setSplitRatio = useShell((state) => state.setSplitRatio);
  const file = files.find((item) => item.path === activeFile);
  // MonoCode reorders panes by dragging a pane's grip (`PaneTree` → `paneDrop`).
  // This split has exactly two panes, so dropping on the other side swaps them.
  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  const chatPaneRef = useRef<HTMLDivElement | null>(null);
  const filePaneRef = useRef<HTMLDivElement | null>(null);
  const [paneDrag, setPaneDrag] = useState<{ from: "chat" | "file"; over: "chat" | "file" } | null>(null);
  // The sash previews locally, the store is written on release (MonoCode `Sash`).
  const [previewShare, setPreviewShare] = useState<number | null>(null);
  const firstShare = previewShare ?? splitRatio;
  const chatFirst = paneOrder === "chat-first";
  const chatShare = file ? (chatFirst ? firstShare : 1 - firstShare) : 1;

  const paneAt = (x: number, y: number): "chat" | "file" | null => {
    const hits = (element: HTMLElement | null) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    if (hits(filePaneRef.current)) return "file";
    if (hits(chatPaneRef.current)) return "chat";
    return null;
  };

  const paneDragStart =
    (from: "chat" | "file") => (event: ReactPointerEvent<HTMLElement>) => {
      if (!file || event.button !== 0) return;
      setPaneDrag({ from, over: from });
      const move = (ev: globalThis.PointerEvent) => {
        const over = paneAt(ev.clientX, ev.clientY);
        setPaneDrag((current) => (current && over && current.over !== over ? { ...current, over } : current));
      };
      const finish = (ev: globalThis.PointerEvent | null) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish as EventListener);
        window.removeEventListener("pointercancel", cancel);
        const over = ev ? paneAt(ev.clientX, ev.clientY) : null;
        setPaneDrag(null);
        // With two panes, dropping one onto the other's side is a swap.
        if (over && over !== from) {
          setPaneOrder(useShell.getState().paneOrder === "chat-first" ? "file-first" : "chat-first");
        }
      };
      const cancel = () => finish(null);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish as EventListener);
      window.addEventListener("pointercancel", cancel);
    };

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
        <div ref={paneContainerRef} className="relative flex min-h-0 min-w-0 flex-1">
          <div
            ref={chatPaneRef}
            style={{ order: chatFirst ? 1 : 3, flexBasis: `${chatShare * 100}%`, flexGrow: 0 }}
            className={`chat-pane-background relative isolate flex h-full min-h-0 min-w-0 flex-col ${paneDrag?.from === "chat" ? "opacity-60" : ""}`}
          >
            {file ? <SessionPaneHeader onPaneDragStart={paneDragStart("chat")} /> : null}
            <ChatPane key={connectionId || cwd} />
            {paneDrag?.over === "chat" ? <PaneDropHint /> : null}
          </div>
          {file ? (
            <PaneSash
              containerRef={paneContainerRef}
              share={firstShare}
              onPreview={setPreviewShare}
              onCommit={setSplitRatio}
            />
          ) : null}
          {file ? (
            <div
              ref={filePaneRef}
              style={{ order: chatFirst ? 3 : 1, flexBasis: `${(1 - chatShare) * 100}%`, flexGrow: 0 }}
              className={`relative flex min-h-0 min-w-0 ${chatFirst ? "border-l border-stroke" : "border-r border-stroke"} ${paneDrag?.from === "file" ? "opacity-60" : ""}`}
            >
              <FileView file={file} cwd={cwd} onPaneDragStart={paneDragStart("file")} />
              {paneDrag?.over === "file" ? <PaneDropHint /> : null}
            </div>
          ) : null}
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
