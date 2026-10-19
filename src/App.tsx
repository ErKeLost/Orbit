import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { MetricsSync } from "./lib/metrics";
import { useWorkspace } from "./lib/store";
import { useWorkspaceBootstrap, useWorkspaceShortcuts } from "./hooks/use-workspace-shell";
import { useProjectRegistry } from "./hooks/use-project-registry";
import { useDesktopNotifications } from "./hooks/use-desktop-integration";
import { RemotePairingScreen } from "./components/remote/RemotePairingScreen";
import { ScreenOverlay } from "./components/screen/ScreenOverlay";
import { Panel } from "./components/Panels";
import { flushForegroundEvents } from "./lib/rpc";
import { ProjectRail } from "./features/shell/project/ProjectRail";
import { CompactRail } from "./features/shell/rail/CompactRail";
import { QuickOpen } from "./features/search/QuickOpen";
import { SessionSidebar } from "./features/shell/sessions/SessionSidebar";
import { TitleBar } from "./features/shell/tabs/TitleBar";
import { FileView } from "./features/shell/files/FileView";
import { MobileShell } from "./features/shell/rail/MobileShell";
import { useActiveWorkspace, useShell, isHomeWorkspace, CHAT_PANE_ID } from "./features/shell/shellStore";
import { ChatPane } from "./features/chat/ChatPane";
import { TerminalDock } from "./features/terminal/TerminalDock";
import { BrowserDock } from "./features/browser/BrowserDock";
import { SettingsView } from "./features/settings/SettingsView";
import { InboxView } from "./features/inbox/InboxView";
import { SearchView } from "./features/search/SearchView";
import { AutomationsView } from "./features/automations/AutomationsView";
import { useAutomationScheduler } from "./features/automations/useAutomationScheduler";
import { useBrowserViews } from "./features/browser/use-browser-views";
import { PaneDropHint, PaneSash, SessionPaneHeader } from "./features/shell/PaneChrome";
import { layoutLeaves, layoutSashes, leafIds, removePane, setSplitRatio as setSplitRatioLayout, type LayoutNode } from "./features/shell/paneLayout";
import { paneDropFromPoint, setTitleTabDrop, titleTabDropFromPoint, useTabDrop, type PaneDrop } from "./features/shell/paneDrop";
import { useWorkspaceTabs, useWorkspaceTabsEffects } from "./features/shell/use-workspace-tabs";
import { SessionScope } from "./features/shell/session-scope";
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

function WorkArea({ withSessions }: { withSessions: boolean }) {
  const panel = useWorkspace((state) => state.panel);

  const cwd = useWorkspace((state) => state.cwd);
  const connectionId = useWorkspace((state) => state.connectionId);
  const projectRailOpen = useShell((state) => state.projectRailOpen);
  const sessionSidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const layout = useActiveWorkspace((workspace) => workspace.layout);
  const panes = useActiveWorkspace((workspace) => workspace.panes);
  const focusPane = useShell((state) => state.focusPane);
  const movePane = useShell((state) => state.movePane);
  const setSplitRatio = useShell((state) => state.setSplitRatio);
  const focusedPane = useActiveWorkspace((workspace) => workspace.activePane);
  const terminalOpen = useShell((state) => state.terminalOpen);
  const terminalPosition = useShell((state) => state.terminalPosition);
  const terminalVertical = terminalPosition === "top" || terminalPosition === "bottom";
  const sessions = useActiveWorkspace((workspace) => workspace.sessions);
  // 面板永远跑在工作区自己的连接上（分屏会话除外）——不再回退到“全局投影”，
  // 切项目范围、切标签页时谁该换连接由控制器一处决定。
  const workspaceConnectionId = useActiveWorkspace((workspace) => workspace.connectionId);
  const homeWorkspace = useActiveWorkspace(isHomeWorkspace);
  const tabs = useWorkspaceTabs();
  // A sash drag previews through a local tree and only writes on release.
  const [previewLayout, setPreviewLayout] = useState<LayoutNode | null>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrop | null>(null);
  const [detaching, setDetaching] = useState<string | null>(null);
  const tabDrop = useTabDrop();
  const paneContainerRef = useRef<HTMLDivElement | null>(null);
  const tree = previewLayout ?? layout;
  // 关掉最后一个文件面板后，编辑器叶子会留在布局里但什么都没有（panes 已被删）。
  // 这种悬挂叶子不能占位置：先剪掉，剩下的面板才能真正合并到整块。
  const renderTree = useMemo(() => {
    let next = tree;
    for (const id of leafIds(tree)) {
      if (sessions[id] || (panes[id]?.files.length ?? 0) > 0) continue;
      const pruned = removePane(next, id);
      if (!pruned) return next;
      next = pruned;
    }
    return next;
  }, [tree, sessions, panes]);
  const leaves = useMemo(() => layoutLeaves(renderTree), [renderTree]);
  const sashes = useMemo(() => layoutSashes(renderTree), [renderTree]);
  const split = leaves.length > 1;
  // 没有任何会话面板、也没有带文件的文件面板时（例如最后一个文件标签被关掉后
  // 剩下一个悬挂的文件叶子，或首页的会话面板被关掉），回落到首页/新会话面，
  // 而不是留一块黑。
  const hasSessionPanes = Object.keys(sessions).length > 0;
  const hasFileContent = Object.values(panes).some((pane) => pane.files.length > 0);
  const emptyWorkspace = leaves.length === 0 || (!hasSessionPanes && !hasFileContent);
  // 终端是工作区级的 dock（Orbit 的 `ProjectTerminalDock`）：它和面板网格平级、
  // 一直挂载，所以关掉最后一个会话面板、或者切到设置/收件箱，都不会把正在跑的
  // shell 一起拆掉。其它整页面板不占终端的位置，只在聊天面上露出来。
  const terminalDock = <TerminalDock cwd={cwd} open={panel === "chat" && terminalOpen} />;
  // A pane a split just created slides in from the edge it took. The store
  // records that edge, so `data-pane-enter` is on the pane's first paint and
  // the animation starts from the offscreen keyframe (never a final-position
  // flash). Panes present when the tree mounts, or swapped in place, just
  // appear. The pane is a clip box (`overflow-clip`), not a scroll container,
  // so focus/`scrollIntoView` inside it cannot drag it mid-slide.
  const entering = useShell((state) => state.entering);
  const clearEntering = useShell((state) => state.clearEntering);

  // `animationend` is the normal clear path, but under reduced motion the
  // animation is disabled and that event never fires — which would leave
  // `data-pane-enter` (and any animation) on the pane forever. Clear any pane
  // that outlives the enter animation.
  useEffect(() => {
    const ids = Object.keys(entering);
    if (ids.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const id of ids) clearEntering(id);
    }, 400);
    return () => window.clearTimeout(timer);
  }, [entering, clearEntering]);

  // Orbit's `PaneTree` drag: track the pointer, hit-test the live panes and
  // resolve the target edge when the pointer is released.
  // monocode 的 DRAG_THRESHOLD：移动超过 5px 才算拖拽，避免点击把手就闪提示。
  const DRAG_THRESHOLD = 5;
  const paneDragStart = (fromId: string) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !split) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture(pointerId);
    const restoreSelection = suppressTextSelection();
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let lastX = event.clientX;
    let lastY = event.clientY;
    const move = (ev: globalThis.PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        setGrabbing(true);
      }
      lastX = ev.clientX;
      lastY = ev.clientY;
      const element = document.elementFromPoint(lastX, lastY);
      if (element?.closest("[data-title-tab-strip]")) {
        setDetaching(fromId);
        setPaneDrag(null);
        // monocode 的精细插入：面板拖到某个工作区标签页上时，提示会插到它的前/后。
        const titleTab = titleTabDropFromPoint(lastX, lastY);
        setTitleTabDrop(titleTab ? { fromId, ...titleTab } : null);
        return;
      }
      setTitleTabDrop(null);
      setDetaching(null);
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
      setDetaching(null);
      setTitleTabDrop(null);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (!commit || !active) return;
      // Orbit 的 `onDetachPane`: a pane dropped on the title strip becomes a
      // workspace tab of its own; 指在某个标签页上时插到它的前/后。
      const element = document.elementFromPoint(lastX, lastY);
      if (element?.closest("[data-title-tab-strip]")) {
        const titleTab = titleTabDropFromPoint(lastX, lastY);
        const workspace = titleTab
          ? useShell.getState().detachPaneToWorkspace(fromId, titleTab.targetTabId, titleTab.position)
          : useShell.getState().detachPaneToWorkspace(fromId);
        if (workspace) void tabs.show(workspace.id);
        return;
      }
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

  // 整页界面（设置/收件箱/搜索/自动化）不替代会话面，只是画在它旁边：会话面用
  // `hidden` 收起来但不卸载，终端 PTY、浏览器页、编辑器状态都不会因为“去设置看一下”
  // 而重启。收起时 `BrowserTab` 会把原生子视图 hide（它不属于页面布局，不主动藏就会
  // 浮在设置界面上面）。
  return (
    <>
      <section className={panel === "chat" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
        {/* 红绿灯归属：展开栏开着→展开栏头部让位；侧栏真的画出来→侧栏头部让位；
            侧栏没画（关掉了、或首页/没有项目）→ 标题栏自己让位，不能被 tab 盖住。 */}
        <TitleBar
          railsHidden={
            !projectRailOpen &&
            (!withSessions || !sessionSidebarOpen || panel === "mobile-access" || panel === "notes")
          }
        />
        <MetricsSync />
        {/* 终端属于工作区，不属于某一个会话面板：关掉聊天面板时 shell 必须继续跑，
            所以 dock 挂在这一层，跟面板网格平级。它一直挂载（收起来只是 `hidden`），
            切面板、关会话都不会重启 PTY。 */}
        <div className={`relative flex min-h-0 min-w-0 flex-1 ${terminalVertical ? "flex-col" : "flex-row"}`}>
          {terminalPosition === "top" || terminalPosition === "left" ? terminalDock : null}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* 面板网格同样是「收起不卸载」：切到命令/笔记这类侧面板时它只是 `hidden`，
                里面的浏览器页、编辑器、会话（以及它们的滚动与草稿）都还在；浏览器页的
                原生子视图由 `BrowserTab` 在量到 0 尺寸时 hide，回来仍是同一个页面。 */}
            <div ref={paneContainerRef} className={panel === "chat" ? "relative min-h-0 min-w-0 flex-1" : "hidden"}>
              {emptyWorkspace ? (
                <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col">
                  <SessionScope connectionId={workspaceConnectionId ?? ""}>
                    <div className="chat-pane-background relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col">
                      <ChatPane onSubmitted={homeWorkspace ? tabs.promoteHome : undefined} paneId={CHAT_PANE_ID} />
                    </div>
                  </SessionScope>
                </div>
              ) : (
                <>
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
                        className={`absolute flex min-h-0 min-w-0 flex-col overflow-clip ${dragging ? "opacity-60" : ""} ${detaching === entry.id ? "ring-2 ring-inset ring-accent/60" : ""}`}
                        style={{
                          left: `${entry.rect.x * 100}%`,
                          top: `${entry.rect.y * 100}%`,
                          width: `${entry.rect.w * 100}%`,
                          height: `${entry.rect.h * 100}%`,
                        }}
                      >
                        {sessions[entry.id] ? (
                          // Every session pane is scoped to its own pi connection, so any
                          // number of them can stream at once (Orbit's session panes).
                          <SessionScope connectionId={entry.id === CHAT_PANE_ID ? workspaceConnectionId ?? "" : sessions[entry.id].connectionId || workspaceConnectionId || ""}>
                            <div className="chat-pane-background relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col">
                              {split ? (
                                <SessionPaneHeader
                                  showGrip
                                  focused={focusedPane === entry.id}
                                  onClosePane={() => void tabs.closeSessionPane(entry.id)}
                                  onPaneDragStart={paneDragStart(entry.id)}
                                />
                              ) : null}
                              <ChatPane
                                key={sessions[entry.id].connectionId || workspaceConnectionId || cwd}
                                onSubmitted={homeWorkspace ? tabs.promoteHome : undefined}
                                paneId={entry.id}
                              />
                            </div>
                          </SessionScope>
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
                </>
              )}
            </div>
            {panel === "chat" ? null : <Panel />}
          </div>
          {terminalPosition === "bottom" || terminalPosition === "right" ? terminalDock : null}
        </div>
      </section>
      {panel === "settings" ? <SettingsView /> : null}
      {panel === "inbox" ? <InboxView /> : null}
      {panel === "search" ? <SearchView /> : null}
      {panel === "automations" ? <AutomationsView /> : null}
    </>
  );
}

export default function App() {
  // 壳层的连接/scope 同步只挂一次：所有组件共享同一个会话控制器。
  useWorkspaceTabsEffects();
  const projectRailOpen = useShell((state) => state.projectRailOpen);
  const sessionSidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const panel = useWorkspace((state) => state.panel);
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const chromeless = panel === "settings" || panel === "inbox" || panel === "search" || panel === "automations" || panel === "mobile-access" || panel === "notes";
  // Without a project folder the session column has nothing to list (home mode
  // and the empty state both render only "没有项目文件夹"), so the shell shows
  // only the rail and the new-session surface.
  const withSessions = workspaceMode === "project" && Boolean(cwd) && cwd !== homeDir;
  useAutomationScheduler();
  // One project registry for both sides: the desktop publishes it to the Host,
  // the phone mirrors it, and a request from the phone is applied on the desktop.
  useProjectRegistry();
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
  // The browser column's own startup (orphaned views, `browser:open`) belongs to
  // the browser feature, not to this root.
  useBrowserViews();
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
      {/* Browser tabs are pane tabs, so they need no wrapper of their own. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {projectRailOpen ? (
          <ProjectRail visible onSearch={openSearch} />
        ) : collapsedRailMode === "compact" ? (
          <CompactRail />
        ) : null}
        {withSessions ? (
          <SessionSidebar visible={sessionSidebarOpen && !chromeless} railVisible={projectRailOpen} onSearch={openSearch} />
        ) : null}
        <WorkArea withSessions={withSessions} />
        {/* 浏览器列是窗口的一列，不是任何工作区/面板里的一格：切标签、切面板、
            关面板都带着它的页面一起留下。手机端没有这一栏。 */}
        <BrowserDock />
        <QuickOpen />
      </div>
      <ScreenOverlay />
    </div>
  );
}
