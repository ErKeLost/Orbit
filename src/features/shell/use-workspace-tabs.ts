import { useCallback, useEffect } from "react";
import { useWorkspace } from "../../lib/store";
import {
  closeWorkspaceConnection,
  focusWorkspaceConnection,
  hasWorkspaceConnection,
  openWorkspaceConnection,
  primeConnectionSnapshot,
  restoreProjectRoute,
} from "../../lib/rpc";
import { CHAT_PANE_ID, isHomeWorkspace, useShell, type WorkspaceTab } from "./shellStore";

/**
 * Binds the shell's workspace tabs to pi connections (Orbit's workspace tab
 * strip). One workspace = one pi RPC process; `lib/rpc.ts` already keeps a full
 * projection per connection, so switching a workspace is a snapshot swap.
 */
export function useWorkspaceTabs() {
  const connectionId = useWorkspace((state) => state.connectionId);
  const cwd = useWorkspace((state) => state.cwd);
  const activeWorkspaceId = useShell((state) => state.activeWorkspaceId);

  // The active workspace follows whatever connection the shell is projecting.
  // The hidden home workspace is excluded: it owns its own fresh session and
  // must never be hijacked by the project route (which restores the last one).
  useEffect(() => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    if (!workspace || isHomeWorkspace(workspace)) return;
    if (connectionId && workspace.connectionId !== connectionId) {
      shell.bindWorkspaceConnection(workspace.id, connectionId);
    }
    if (cwd && workspace.cwd !== cwd) shell.setWorkspaceCwd(workspace.id, cwd);
  }, [connectionId, cwd, activeWorkspaceId]);

  /** Show a workspace, opening its pi process the first time it is needed. */
  const open = useCallback(async (id: string, options?: { fresh?: boolean }) => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const home = isHomeWorkspace(workspace);
    // 首页永远是一个新会话；切回首页时复用已经开好的那个空会话，不再重开进程。
    const fresh = options?.fresh === true || home;
    const previous = useWorkspace.getState().connectionId;
    shell.activateWorkspace(id);
    if (hasWorkspaceConnection(workspace.connectionId) && (home || !options?.fresh)) {
      focusWorkspaceConnection(workspace.connectionId, workspace.cwd);
      return;
    }
    const target = workspace.connectionId && !hasWorkspaceConnection(workspace.connectionId)
      ? workspace.connectionId
      : home ? `${workspace.cwd}#home` : `${workspace.cwd}#${crypto.randomUUID()}`;
    // Bind the pane *before* the process starts: otherwise the new tab keeps
    // projecting the connection that was on screen and looks like a copy of the
    // current session until `pi_connect` returns.
    shell.bindWorkspaceConnection(id, target);
    shell.bindSessionConnection(CHAT_PANE_ID, target);
    primeConnectionSnapshot(target);
    await openWorkspaceConnection(workspace.cwd, target, fresh ? { keepTranscript: true } : { restoreLast: true });
    // Starting a process must not steal the project's route from the workspace
    // that was on screen.
    if (previous && previous !== target) restoreProjectRoute(workspace.cwd, previous);
    focusWorkspaceConnection(target, workspace.cwd);
  }, []);

  /** ⌘T / the strip's plus: a new workspace with a fresh session (home page). */
  const create = useCallback(async (projectCwd?: string) => {
    const shell = useShell.getState();
    const active = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    const workspace = shell.newWorkspace(projectCwd ?? active?.cwd ?? useWorkspace.getState().cwd);
    await open(workspace.id, { fresh: true });
    return workspace;
  }, [open]);

  const close = useCallback(async (id: string) => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === id);
    // 首页工作区不是标签页；关掉最后一个标签页时 store 会自动把它补出来。
    if (!workspace || isHomeWorkspace(workspace)) return;
    const wasActive = shell.activeWorkspaceId === id;
    shell.closeWorkspace(id);
    if (wasActive) {
      const next = useShell.getState();
      const targetWorkspace = next.workspaces.find((item) => item.id === next.activeWorkspaceId);
      if (targetWorkspace) await open(targetWorkspace.id);
    }
    await closeWorkspaceConnection(workspace.connectionId, "工作区已关闭");
  }, [open]);

  /** 首页会话发出第一条消息：把它变成一个正常的标签页。 */
  const promoteHome = useCallback(() => {
    useShell.getState().promoteHomeWorkspace();
  }, []);

  /** ⌘D / ⌘⇧D: split a session pane and open a new session in it. */
  const splitSession = useCallback(async (paneId: string, dir: "right" | "down") => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    if (!workspace || isHomeWorkspace(workspace)) return;
    const newPaneId = shell.splitSessionPane(paneId, dir);
    if (!newPaneId) return;
    const connectionId = `${workspace.cwd}#${crypto.randomUUID()}`;
    useShell.getState().bindSessionConnection(newPaneId, connectionId);
    await openWorkspaceConnection(workspace.cwd, connectionId);
    focusWorkspaceConnection(connectionId, workspace.cwd);
  }, []);

  return { open, create, close, promoteHome, splitSession };
}

export type { WorkspaceTab };
