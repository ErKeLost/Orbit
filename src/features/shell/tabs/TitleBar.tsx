import { useCallback, useMemo, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { useWorkspace } from "../../../lib/store";
import { useTitleTabDrop } from "../paneDrop";
import { Globe, Loader, PanelLeft, Plus, Settings, Terminal, X } from "../../../shared/ui/icons";
import { IS_MAC, MOD, TitleIconButton } from "../chrome";
import { useWorkspaceTabs } from "../use-workspace-tabs";
import { projectWorkspaceTabs, useShell, type WorkspaceTab } from "../shellStore";
import { currentShortcut, shortcutLabel } from "../../../lib/keybindings";
import { compactTitle } from "../../../lib/session-visual";
import { connectionSnapshot, firstUserTitle, subscribeSnapshot } from "../../../lib/rpc";
import type { Snapshot } from "../../../lib/rpc";
import { MenuItem, MenuSeparator, PointMenu } from "../../../shared/ui/controls";

/** Tab label: the project's folder name, like Orbit's workspace tabs. */
function workspaceLabel(cwd: string, homeDir: string) {
  if (!cwd) return "工作区";
  if (homeDir && cwd === homeDir) return "主目录";
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

/** The session's own name for a workspace's pi connection. */
function workspaceSessionTitle(workspace: { cwd: string; connectionId: string }, snapshot: Snapshot | null, homeDir: string) {
  const folder = workspaceLabel(workspace.cwd, homeDir);
  let name = "";
  try {
    const meta = snapshot?.statuses?.["gui-session-name"];
    if (meta) {
      const parsed = JSON.parse(meta) as { name?: unknown };
      if (typeof parsed?.name === "string" && parsed.name.trim()) name = parsed.name;
    }
  } catch { /* malformed status falls back to get_state */ }
  if (!name && snapshot?.state?.sessionName) name = snapshot.state.sessionName;
  if (name) return compactTitle(name, folder, 40);
  const firstUser = snapshot && firstUserTitle(snapshot.transcript);
  if (firstUser) return compactTitle(firstUser, folder, 40);
  return folder;
}

/** Subscribes to one pi connection's snapshot so session names stay live. */
function useConnectionSnapshot(connectionId: string): Snapshot | null {
  return useSyncExternalStore(
    useCallback((listener: () => void) => subscribeSnapshot(connectionId, listener), [connectionId]),
    () => connectionSnapshot(connectionId),
    () => connectionSnapshot(connectionId),
  );
}

function WorkspaceTabItem({
  workspace,
  active,
  onOpen,
  onClose,
  onContextMenu,
  closable,
  dropHint,
}: {
  workspace: { id: string; cwd: string; connectionId: string };
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  closable: boolean;
  /** 面板正被拖到这个标签页的前/后（monocode 的插入提示）。 */
  dropHint?: "before" | "after";
}) {
  const homeDir = useWorkspace((state) => state.homeDir);
  const snapshot = useConnectionSnapshot(workspace.connectionId);
  const label = workspaceSessionTitle(workspace, snapshot, homeDir);
  // 还在连接、而且没有已知标题时，标签用骨架条，不要先闪一个目录名。
  const titled = Boolean(snapshot?.state?.sessionName) || Boolean(snapshot && firstUserTitle(snapshot.transcript));
  const loading = snapshot?.connection === "connecting" && !titled;
  // 这条会话（后台标签也一样）正在跑：标题前面挂一个 loading，好认出是哪条在跑。
  const working = Boolean(snapshot?.transcript.running || snapshot?.transcript.compacting);
  return (
    <div
      data-title-tab-id={workspace.id}
      data-tauri-drag-region="false"
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event);
      }}
      className="group relative flex h-7.5 w-52 min-w-28 shrink items-center"
    >
      {dropHint ? (
        <span
          aria-hidden
          data-pane-tab-drop-hint
          className={`pointer-events-none absolute inset-y-1 z-50 w-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)] ${dropHint === "before" ? "left-0" : "right-0"}`}
        />
      ) : null}
      <button
        type="button"
        role="tab"
        data-tauri-drag-region="false"
        aria-selected={active}
        title={working ? `${label} · 运行中` : label}
        onClick={onOpen}
        className={`relative flex h-7.5 min-w-0 flex-1 cursor-default items-center gap-1.5 self-center rounded-md px-2 pr-6 text-left text-[13px] ${
          active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
        }`}
      >
        {working ? (
          <>
            <Loader className="size-3 shrink-0 animate-spin text-accent" strokeWidth={2} />
            <span className="sr-only">运行中</span>
          </>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{loading ? <span aria-hidden className="block h-3 w-20 animate-pulse rounded bg-content/15" /> : label}</span>
      </button>
      {closable ? (
        <button
          type="button"
          data-no-drag
          data-tauri-drag-region="false"
          title="关闭工作区"
          aria-label="关闭工作区"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
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
}

/**
 * Orbit's window title bar (`app/shell/TitleBar.tsx`): the workspace title,
 * the settings search and the title-bar actions. It holds **no tabs** — Orbit
 * keeps every tab inside its own pane (`SurfaceTabs`), and the session's own
 * header lives in the session pane (`PaneChrome.SessionPaneHeader`).
 */
export function TitleBar({ railsHidden }: { railsHidden: boolean }) {
  const terminalOpen = useShell((state) => state.terminalOpen);
  const browserOpen = useShell((state) => state.browserOpen);

  // The hidden home workspace is not a tab: it only appears as the 首页 once
  // every tab has been closed.
  const allWorkspaces = useShell((state) => state.workspaces);
  // header 里的会话是挂项目的：只显示当前项目的标签页，切项目就换一整套。
  // 其它项目的会话仍然活着（后台跑、被收养/休眠），只是不出现在这个项目的条里。
  const cwd = useWorkspace((state) => state.cwd);
  const workspaces = useMemo(() => projectWorkspaceTabs(allWorkspaces, cwd), [allWorkspaces, cwd]);
  const activeWorkspaceId = useShell((state) => state.activeWorkspaceId);
  const tabs = useWorkspaceTabs();
  // 面板拖到标题栏时的插入提示（monocode 的 paneToTabDrop）。
  const paneToTabDrop = useTitleTabDrop();
  const [menu, setMenu] = useState<{ workspace: WorkspaceTab; x: number; y: number } | null>(null);

  /** 当前项目的标签页（关闭其他/右侧只在项目内生效，别误杀别的项目的后台会话）。 */
  const projectTabs = () => projectWorkspaceTabs(useShell.getState().workspaces, cwd);

  const closeOthers = async (workspaceId: string) => {
    const others = projectTabs().filter((item) => item.id !== workspaceId);
    setMenu(null);
    for (const item of others) await tabs.close(item.id);
    await tabs.show(workspaceId);
  };

  const closeRight = async (workspaceId: string) => {
    const items = projectTabs();
    const index = items.findIndex((item) => item.id === workspaceId);
    if (index < 0) return;
    setMenu(null);
    for (const item of items.slice(index + 1)) await tabs.close(item.id);
    await tabs.show(workspaceId);
  };

  return (
    <header className="flex h-10 shrink-0 select-none items-stretch border-b border-stroke" data-tauri-drag-region="deep">
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
      {/* Workspace tabs: Orbit's title strip. Each tab is a whole pane tree
          with its own pi process; dragging a pane's grip onto the strip detaches
          it into a workspace of its own (`onDetachPane`). */}
      <div
        data-title-tab-strip
        role="tablist"
        aria-label="工作区"
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-none pl-1.5 pr-1"
      >
        {workspaces.map((workspace) => (
          <WorkspaceTabItem
            key={workspace.id}
            workspace={workspace}
            active={workspace.id === activeWorkspaceId}
            onOpen={() => void tabs.show(workspace.id)}
            onClose={() => void tabs.close(workspace.id)}
            onContextMenu={(event) => setMenu({ workspace, x: event.clientX, y: event.clientY })}
            closable
            dropHint={paneToTabDrop?.targetTabId === workspace.id ? paneToTabDrop.position : undefined}
          />
        ))}
        <button
          type="button"
          data-no-drag
          data-tauri-drag-region="false"
          title={`新建会话 (${shortcutLabel(currentShortcut("Session: New"))})`}
          aria-label="新建会话"
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
        <TitleIconButton
          label={browserOpen ? "新建浏览器标签页" : "打开浏览器"}
          active={browserOpen}
          onClick={() => {
            // The browser is its own column (third column), not a pane: a page
            // needs width, and it must outlive the panes it was opened from.
            const shell = useShell.getState();
            // Closed with pages still in it: bring the column back rather than
            // leaving those pages hidden behind a new, empty tab.
            if (!shell.browserOpen && shell.browserTabs.length > 0) {
              shell.setBrowserOpen(true);
              return;
            }
            shell.openBrowser("");
          }}
        >
          <Globe className="size-3.5" strokeWidth={1.75} />
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
      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="工作区操作" onClose={() => setMenu(null)}>
          <MenuItem onClick={() => { setMenu(null); void tabs.create(menu.workspace.cwd); }}>新建会话</MenuItem>
          <MenuSeparator />
          <MenuItem disabled={workspaces.length < 2} onClick={() => void closeOthers(menu.workspace.id)}>关闭其他会话</MenuItem>
          <MenuItem disabled={workspaces.findIndex((item) => item.id === menu.workspace.id) >= workspaces.length - 1} onClick={() => void closeRight(menu.workspace.id)}>关闭右侧会话</MenuItem>
          <MenuItem danger onClick={() => { const id = menu.workspace.id; setMenu(null); void tabs.close(id); }}>关闭会话</MenuItem>
        </PointMenu>
      ) : null}
    </header>
  );
}
