import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../../lib/store";
import { changeSession, report } from "../../lib/rpc";
import { LAYER } from "../../shared/lib/layers";
import { Plus, Settings, SlidersHorizontal, X, MessageMultiple, PanelLeft, AppWindow } from "../../shared/ui/icons";
import { ChatPane } from "../chat/ChatPane";
import { SettingsView } from "../settings/SettingsView";
import { SettingsNav } from "../settings/SettingsNav";
import { Panel } from "../../components/Panels";
import { ProjectRail } from "./ProjectRail";
import { SessionSidebar } from "./SessionSidebar";
import { TitleIconButton } from "./chrome";
import { useShell } from "./shellStore";
import { compactTitle } from "../../lib/session-visual";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";

/**
 * Android / narrow layout. The same MonoCode surfaces, stacked: a 44px title
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
  const sessions = useProjectSessions(cwd);
  const merged = mergeProjectSessions(cwd, sessions.data ?? [], liveSessions);
  const session = merged.sessions.find((item) => item.path === sessionFile);
  const title = panel === "settings" ? "设置" : compactTitle(session?.name || session?.firstMessage, "新会话", 28);

  // Picking anything in the drawer closes it, like a native nav drawer.
  useEffect(() => setDrawer(false), [sessionFile, cwd, panel]);
  useEffect(() => {
    useShell.getState().setSidebarTab("sessions");
  }, []);

  return (
    <div className="mobile-shell flex h-full min-h-0 flex-col bg-background-base text-content">
      <header className="flex h-11 shrink-0 select-none items-center gap-1 border-b border-stroke px-2">
        <TitleIconButton label="打开导航" onClick={() => setDrawer(true)}>
          <PanelLeft className="size-4" strokeWidth={1.75} />
        </TitleIconButton>
        <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-[14px] font-medium">
          <span className="min-w-0 truncate">{title}</span>
        </span>
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
