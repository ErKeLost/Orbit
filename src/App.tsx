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
function SplitPaneHeader({ onPaneDragStart }: { onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void }) {
  const sessionName = useWorkspace((state) => state.state?.sessionName);
  const activeFile = useShell((state) => state.activeFile);
  const first = useWorkspace((state) => {
    const message = state.transcript.messages.find((item) => item.message.role === "user")?.message;
    if (!message) return "";
    if (typeof message.content === "string") return message.content;
    return (message.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join(" ");
  });
  const title = compactTitle(sessionName || first, "新会话", 60);
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
      <span className={`size-2 shrink-0 rounded-full ${activeFile ? "bg-transparent" : "bg-accent"}`} />
      <span className="min-w-0 flex-1 truncate text-xs text-content" title={title}>{title}</span>
      <button
        type="button"
        data-no-drag
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

/** MonoCode's `PaneDropHint`: which side the dragged pane will land on. */
function PaneDropHint() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 ring-2 ring-inset ring-accent/50">
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground shadow-lg">
        移到这一侧
      </span>
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
  const paneOrder = useShell((state) => state.paneOrder);
  const setPaneOrder = useShell((state) => state.setPaneOrder);
  const file = files.find((item) => item.path === activeFile);
  // MonoCode reorders panes by dragging a pane's grip (`PaneTree` → `paneDrop`).
  // This split has exactly two panes, so dropping on the other side swaps them.
  const chatPaneRef = useRef<HTMLDivElement | null>(null);
  const filePaneRef = useRef<HTMLDivElement | null>(null);
  const [paneDrag, setPaneDrag] = useState<{ from: "chat" | "file"; over: "chat" | "file" } | null>(null);

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
        <div className="flex min-h-0 min-w-0 flex-1">
          <div
            ref={chatPaneRef}
            style={{ order: paneOrder === "file-first" ? 2 : 1 }}
            className={`chat-pane-background relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col ${paneDrag?.from === "chat" ? "opacity-60" : ""}`}
          >
            {file ? <SplitPaneHeader onPaneDragStart={paneDragStart("chat")} /> : null}
            <ChatPane key={connectionId || cwd} />
            {paneDrag?.over === "chat" ? <PaneDropHint /> : null}
          </div>
          {file ? (
            <div
              ref={filePaneRef}
              style={{ order: paneOrder === "file-first" ? 1 : 2 }}
              className={`relative flex min-h-0 min-w-0 flex-1 ${paneOrder === "file-first" ? "border-r border-stroke" : "border-l border-stroke"} ${paneDrag?.from === "file" ? "opacity-60" : ""}`}
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
