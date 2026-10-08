import { useEffect, useMemo, useRef, useState } from "react";
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
import { CHAT_PANE_ID, useShell } from "./features/shell/shellStore";
import { ChatPane } from "./features/chat/ChatPane";
import { SettingsView } from "./features/settings/SettingsView";
import { InboxView } from "./features/inbox/InboxView";
import { SearchView } from "./features/search/SearchView";
import { AutomationsView } from "./features/automations/AutomationsView";
import { useAutomationScheduler } from "./features/automations/useAutomationScheduler";
import { PaneDropHint, PaneSash, SessionPaneHeader } from "./features/shell/PaneChrome";
import { layoutLeaves, layoutSashes, setSplitRatio as setSplitRatioLayout, type LayoutNode } from "./features/shell/paneLayout";
import { paneDropFromPoint, useTabDrop, type PaneDrop } from "./features/shell/paneDrop";
import { setGrabbing, suppressTextSelection } from "./shared/lib/drag";

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
  const projectRailOpen = useShell((state) => state.projectRailOpen);
  const sessionSidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const layout = useShell((state) => state.layout);
  const panes = useShell((state) => state.panes);
  const focusPane = useShell((state) => state.focusPane);
  const movePane = useShell((state) => state.movePane);
  const setSplitRatio = useShell((state) => state.setSplitRatio);
  const focusedPane = useShell((state) => state.activePane);
  // A sash drag previews through a local tree and only writes on release.
  const [previewLayout, setPreviewLayout] = useState<LayoutNode | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrop | null>(null);
  const tabDrop = useTabDrop();
  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  const tree = previewLayout ?? layout;
  const leaves = useMemo(() => layoutLeaves(tree), [tree]);
  const sashes = useMemo(() => layoutSashes(tree), [tree]);
  const split = leaves.length > 1;
  // A pane split into an existing layout slides in from the edge it was added
  // on. Panes present when the tree mounts, or swapped in place, just appear.
  // (MonoCode `PaneTree` enteringPanes.)
  // MonoCode marks a pane that a split just created and slides it in from the
  // edge it took (`PaneTree` enteringPanes); the store records the edge where
  // the split happens, so the attribute is there on the pane's first paint.
  const entering = useShell((state) => state.entering);
  const clearEntering = useShell((state) => state.clearEntering);

  // MonoCode's `PaneTree` drag: track the pointer, hit-test the live panes and
  // resolve the target edge when the pointer is released.
  const paneDragStart = (fromId: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !split) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointerId);
    const restoreSelection = suppressTextSelection();
    setGrabbing(true);
    let lastX = event.clientX;
    let lastY = event.clientY;
    const move = (ev: globalThis.PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      const over = paneDropFromPoint(lastX, lastY);
      setPaneDrag(over && over.id !== fromId ? { fromId, overId: over.id, edge: over.edge } : null);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      restoreSelection();
      setGrabbing(false);
      setPaneDrag(null);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (!commit) return;
      const over = paneDropFromPoint(lastX, lastY);
      if (over && over.id !== fromId) movePane(fromId, over.id, over.edge);
    };
    const up = () => finish(true);
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
        <div ref={paneContainerRef} className="relative min-h-0 min-w-0 flex-1">
          {leaves.map((entry) => {
            const dragging = paneDrag?.fromId === entry.id;
            const hint = paneDrag?.overId === entry.id ? paneDrag.edge : null;
            const drop = tabDrop?.toPane === entry.id ? tabDrop : null;
            return (
              <div
                key={entry.id}
                data-pane-id={entry.id}
                onMouseDown={() => focusPane(entry.id)}
                data-pane-enter={entering[entry.id]}
                onAnimationEnd={(event) => {
                  if (event.animationName !== "pane-enter") return;
                  clearEntering(entry.id);
                }}
                onScroll={(event) => {
                  // Focus scrolls the clip box while the pane is still offscreen.
                  if (!(entry.id in entering)) return;
                  event.currentTarget.scrollLeft = 0;
                  event.currentTarget.scrollTop = 0;
                }}
                className={`absolute flex min-h-0 min-w-0 flex-col overflow-hidden ${dragging ? "opacity-60" : ""}`}
                style={{
                  left: `${entry.rect.x * 100}%`,
                  top: `${entry.rect.y * 100}%`,
                  width: `${entry.rect.w * 100}%`,
                  height: `${entry.rect.h * 100}%`,
                }}
              >
                {entry.id === CHAT_PANE_ID ? (
                  <div className="chat-pane-background relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col">
                    {split ? (
                      <SessionPaneHeader
                        showGrip
                        focused={focusedPane === CHAT_PANE_ID}
                        onPaneDragStart={paneDragStart(CHAT_PANE_ID)}
                      />
                    ) : null}
                    <ChatPane key={connectionId || cwd} />
                  </div>
                ) : panes[entry.id] ? (
                  <FileView
                    paneId={entry.id}
                    cwd={cwd}
                    showGrip={split}
                    onPaneDragStart={paneDragStart(entry.id)}
                  />
                ) : null}
                {hint ? <PaneDropHint edge={hint} /> : null}
                {drop?.edge ? <PaneDropHint edge={drop.edge} /> : null}
                {drop && !drop.edge ? (
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-9 ring-2 ring-inset ring-accent/60" />
                ) : null}
              </div>
            );
          })}
          {sashes.map((sash) => (
            <PaneSash
              key={`${sash.splitId}:${sash.index}`}
              sash={sash}
              containerRef={paneContainerRef}
              onPreview={(boundary) =>
                setPreviewLayout(setSplitRatioLayout(layout, sash.splitId, sash.index, boundary))
              }
              onCommit={(boundary) => {
                setPreviewLayout(null);
                setSplitRatio(sash.splitId, sash.index, boundary);
              }}
              onCancel={() => setPreviewLayout(null)}
            />
          ))}
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
