import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../../lib/store";
import { changeSession, report } from "../../lib/rpc";
import { LAYER } from "../../shared/lib/layers";
import { Plus, Settings, SlidersHorizontal, X, MessageMultiple, PanelLeft, AppWindow, ChevronLeft } from "../../shared/ui/icons";
import { ChatPane } from "../chat/ChatPane";
import { SettingsView } from "../settings/SettingsView";
import { SettingsNav } from "../settings/SettingsNav";
import { Panel } from "../../components/Panels";
import { FileView } from "./FileView";
import { ProjectRail } from "./ProjectRail";
import { SessionSidebar } from "./SessionSidebar";
import { TitleIconButton } from "./chrome";
import { useActiveWorkspace, useShell } from "./shellStore";
import { compactTitle } from "../../lib/session-visual";
import { observeKeyboardInset } from "../../lib/keyboard-inset";
import { installBackGesture, registerBackHandler } from "../../lib/back-gesture";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";

/**
 * Android / narrow layout. The same Orbit surfaces, stacked: a 44px title
 * bar with the drawer toggle, the chat full-bleed, and the two rails sliding
 * in from the left as one drawer (projects on top, sessions below).
 */
export function MobileShell({ onSearch }: { onSearch: () => void }) {
  const panel = useWorkspace((state) => state.panel);
  const cwd = useWorkspace((state) => state.cwd);
  const online = useWorkspace((state) => state.connection === "online");
  const screenPip = useWorkspace((state) => state.screenPip);
  const sessionFile = useWorkspace((state) => state.state?.sessionFile);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const [drawer, setDrawer] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"sessions" | "projects">("sessions");
  // A phone has no room for the desktop's pane grid, so a file takes the whole
  // surface and the conversation waits behind it.
  const [chatSurface, setChatSurface] = useState(true);
  const paneId = useActiveWorkspace((workspace) => workspace.activePane);
  const pane = useActiveWorkspace((workspace) => workspace.panes[workspace.activePane]);
  const fileOpenSeq = useShell((state) => state.fileOpenSeq);
  const openFile = pane ? pane.files.find((file) => file.path === pane.activeFile) ?? pane.files[0] ?? null : null;
  const showFile = openFile != null && !chatSurface;
  const sessions = useProjectSessions(cwd);
  const merged = mergeProjectSessions(cwd, sessions.data ?? [], liveSessions);
  const session = merged.sessions.find((item) => item.path === sessionFile);
  const title = panel === "settings" ? "设置" : compactTitle(session?.name || session?.firstMessage, "新会话", 28);

  // A file opened anywhere — the tree, search, a diff — becomes what the phone
  // is looking at. `fileOpenSeq` rather than the open files themselves: asking
  // for a file that is already open behind the chat must bring it forward again.
  useEffect(() => {
    if (fileOpenSeq === 0) return;
    useWorkspace.getState().set({ panel: "chat" });
    setChatSurface(false);
  }, [fileOpenSeq]);

  // Picking anything in the drawer closes it, like a native nav drawer.
  useEffect(() => setDrawer(false), [sessionFile, cwd, panel, fileOpenSeq]);
  useEffect(() => {
    useShell.getState().setSidebarTab("sessions");
  }, []);
  // The keyboard covers the composer on Android unless something shrinks the
  // shell; `MainActivity` pads the WebView, and this publishes the same number
  // for the shells that resize the visual viewport instead. See
  // `src/lib/keyboard-inset.ts` for why the two never overlap.
  useEffect(() => observeKeyboardInset(), []);
  // Back belongs to whatever is on top of this shell. `MainActivity` leaves the
  // app only when nothing claims the press; each overlay claims it while it is
  // open, newest first. See `src/lib/back-gesture.ts`.
  useEffect(() => installBackGesture(), []);
  useEffect(() => {
    if (!drawer) return;
    return registerBackHandler(() => {
      setDrawer(false);
      return true;
    });
  }, [drawer]);
  useEffect(() => {
    if (!showFile) return;
    return registerBackHandler(() => {
      setChatSurface(true);
      return true;
    });
  }, [showFile]);
  useEffect(() => {
    if (!screenPip) return;
    return registerBackHandler(() => {
      useWorkspace.getState().set({ screenPip: false });
      return true;
    });
  }, [screenPip]);

  return (
    <div className="mobile-shell flex h-full min-h-0 flex-col bg-background-base text-content">
      <header className="flex h-11 shrink-0 select-none items-center gap-1 border-b border-stroke px-2">
        {showFile ? (
          <TitleIconButton label="返回会话" onClick={() => setChatSurface(true)}>
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </TitleIconButton>
        ) : (
          <TitleIconButton label="打开导航" onClick={() => setDrawer(true)}>
            <PanelLeft className="size-4" strokeWidth={1.75} />
          </TitleIconButton>
        )}
        <span className="flex min-w-0 flex-1 items-center text-[14px] font-medium">
          <span className="min-w-0 truncate">{showFile ? openFile.name : title}</span>
        </span>
        {showFile ? (
          <TitleIconButton label="打开导航" onClick={() => setDrawer(true)}>
            <PanelLeft className="size-4" strokeWidth={1.75} />
          </TitleIconButton>
        ) : null}
        <TitleIconButton
          label={screenPip ? "关闭屏幕" : "打开屏幕"}
          active={screenPip}
          disabled={!online}
          onClick={() => useWorkspace.getState().set({ screenPip: !screenPip })}
        >
          <AppWindow className="size-4" strokeWidth={1.75} />
        </TitleIconButton>
        <TitleIconButton label="新会话" disabled={!online} onClick={() => { useWorkspace.getState().set({ panel: "chat" }); void changeSession({ type: "new_session" }).catch(report); }}>
          <Plus className="size-4" strokeWidth={1.75} />
        </TitleIconButton>
      </header>

      <main className="flex min-h-0 flex-1 flex-col">
        {panel === "settings" ? (
          <SettingsView />
        ) : showFile ? (
          // The same editor pane the desktop shows: the phone only gives it the
          // whole surface instead of a cell in the pane grid.
          <FileView paneId={paneId} cwd={cwd} showGrip={false} />
        ) : panel === "chat" ? (
          <div className="mobile-composer-dock flex min-h-0 flex-1 flex-col">
            <ChatPane />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Panel />
          </div>
        )}
      </main>

      {drawer
        ? createPortal(
            <div className="fixed inset-0" style={{ zIndex: LAYER.dialog }}>
              <div className="mobile-scrim absolute inset-0 bg-black/45" data-open="true" onClick={() => setDrawer(false)} />
              <aside className="mobile-drawer sidebar-glass absolute inset-y-0 left-0 flex flex-col border-r border-stroke shadow-2xl" data-open="true">
                <div className="flex h-11 shrink-0 items-center gap-1 border-b border-stroke px-2">
                  <div role="tablist" className="flex min-w-0 flex-1 items-center gap-px">
                    {(["sessions", "projects"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={drawerTab === tab}
                        onClick={() => setDrawerTab(tab)}
                        className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] ${drawerTab === tab ? "bg-selection text-content" : "text-content/50"}`}
                      >
                        {tab === "sessions" ? <MessageMultiple className="size-3.5" strokeWidth={1.75} /> : <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />}
                        {tab === "sessions" ? "会话" : "项目"}
                      </button>
                    ))}
                  </div>
                  <TitleIconButton label="关闭导航" onClick={() => setDrawer(false)}>
                    <X className="size-4" strokeWidth={1.75} />
                  </TitleIconButton>
                </div>
                <div className="flex min-h-0 flex-1 flex-col [&>aside]:!w-full [&>aside]:border-r-0 [&>nav]:!w-full [&>nav]:border-r-0">
                  {panel === "settings" ? (
                    <div className="flex min-h-0 flex-1 flex-col"><SettingsNav /></div>
                  ) : drawerTab === "sessions" ? (
                    <SessionSidebar visible railVisible onSearch={onSearch} />
                  ) : (
                    <ProjectRail visible onSearch={onSearch} />
                  )}
                </div>
                {panel !== "settings" ? (
                  <div className="flex shrink-0 border-t border-stroke p-2">
                    <button
                      type="button"
                      onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}
                      className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-content/60 hover:bg-content/10 hover:text-content"
                    >
                      <Settings className="size-4 opacity-70" strokeWidth={1.75} />
                      <span className="text-sm font-medium">Settings</span>
                    </button>
                  </div>
                ) : null}
              </aside>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
