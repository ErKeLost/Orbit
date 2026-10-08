import { useWorkspace } from "../../lib/store";
import { PanelLeft, Plus, Settings, Terminal, X } from "../../shared/ui/icons";
import { IS_MAC, MOD, TitleIconButton } from "./chrome";
import { useWorkspaceTabs } from "./use-workspace-tabs";
import { useShell } from "./shellStore";

/** Tab label: the project's folder name, like MonoCode's workspace tabs. */
function workspaceLabel(cwd: string) {
  if (!cwd) return "工作区";
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

/**
 * MonoCode's window title bar (`app/shell/TitleBar.tsx`): the workspace title,
 * the settings search and the title-bar actions. It holds **no tabs** — MonoCode
 * keeps every tab inside its own pane (`SurfaceTabs`), and the session's own
 * header lives in the session pane (`PaneChrome.SessionPaneHeader`).
 */
export function TitleBar({ railsHidden }: { railsHidden: boolean }) {
  const terminalOpen = useShell((state) => state.terminalOpen);
  const workspaces = useShell((state) => state.workspaces);
  const activeWorkspaceId = useShell((state) => state.activeWorkspaceId);
  const tabs = useWorkspaceTabs();

  return (
    <header className="flex h-10 shrink-0 select-none items-stretch border-b border-stroke" data-tauri-drag-region>
      {railsHidden ? (
        <>
          {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
          <div className="flex shrink-0 items-center px-1.5">
            <TitleIconButton
              label={`切换侧栏 (${MOD}B)`}
              onClick={() => {
                useShell.getState().setProjectRailOpen(true);
                useShell.getState().setSessionSidebarOpen(true);
              }}
            >
              <PanelLeft className="size-3.5" strokeWidth={1.75} />
            </TitleIconButton>
          </div>
        </>
      ) : null}
      {/* Workspace tabs: MonoCode's title strip. Each tab is a whole pane tree
          with its own pi process; dragging a pane's grip onto the strip detaches
          it into a workspace of its own (`onDetachPane`). */}
      <div
        data-title-tab-strip
        role="tablist"
        aria-label="工作区"
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-none pl-1.5 pr-1"
      >
        {workspaces.map((workspace) => {
          const active = workspace.id === activeWorkspaceId;
          return (
            <div
              key={workspace.id}
              data-title-tab-id={workspace.id}
              className="group relative flex h-7.5 w-52 min-w-28 shrink items-center"
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={workspace.cwd}
                onClick={() => void tabs.open(workspace.id)}
                className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 pr-6 text-left text-[13px] ${
                  active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">
                  {workspaceLabel(workspace.cwd)}
                </span>
              </button>
              {workspaces.length > 1 ? (
                <button
                  type="button"
                  data-no-drag
                  data-tauri-drag-region="false"
                  title="关闭工作区"
                  aria-label="关闭工作区"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void tabs.close(workspace.id);
                  }}
                  className={`absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content ${
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                >
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          data-no-drag
          data-tauri-drag-region="false"
          title="新建工作区 (⌘T)"
          aria-label="新建工作区"
          onClick={() => void tabs.create()}
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 px-2" data-tauri-drag-region="false">
        <TitleIconButton
          label={terminalOpen ? "收起终端 (⌘J)" : "打开终端 (⌘J)"}
          active={terminalOpen}
          onClick={() => useShell.getState().setTerminalOpen(!terminalOpen)}
        >
          <Terminal className="size-3.5" strokeWidth={1.75} />
        </TitleIconButton>
        {railsHidden ? (
          <TitleIconButton
            label={`设置 (${MOD},)`}
            onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}
          >
            <Settings className="size-3.5" strokeWidth={1.75} />
          </TitleIconButton>
        ) : null}
      </div>
    </header>
  );
}
