import { useCallback, useEffect } from "react";
import { useWorkspace } from "../../lib/store";
import {
  closeWorkspaceConnection,
  focusWorkspaceConnection,
  hasWorkspaceConnection,
  openWorkspaceConnection,
  restoreProjectRoute,
} from "../../lib/rpc";
import { useShell, type WorkspaceTab } from "./shellStore";

/**
 * Binds the shell's workspace tabs to pi connections (MonoCode's workspace tab
 * strip). One workspace = one pi RPC process; `lib/rpc.ts` already keeps a full
 * projection per connection, so switching a workspace is a snapshot swap.
 */
export function useWorkspaceTabs() {
  const connectionId = useWorkspace((state) => state.connectionId);
  const cwd = useWorkspace((state) => state.cwd);

  // The active workspace follows whatever connection the shell is projecting.
  useEffect(() => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    if (!workspace) return;
    if (connectionId && workspace.connectionId !== connectionId) {
      shell.bindWorkspaceConnection(workspace.id, connectionId);
    }
    if (cwd && workspace.cwd !== cwd) shell.setWorkspaceCwd(workspace.id, cwd);
  }, [connectionId, cwd]);

  /** Show a workspace, opening its pi process the first time it is needed. */
  const open = useCallback(async (id: string, options?: { fresh?: boolean }) => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const previous = useWorkspace.getState().connectionId;
    shell.activateWorkspace(id);
    if (!options?.fresh && hasWorkspaceConnection(workspace.connectionId)) {
      focusWorkspaceConnection(workspace.connectionId, workspace.cwd);
      return;
    }
    const target = workspace.connectionId && !hasWorkspaceConnection(workspace.connectionId)
      ? workspace.connectionId
      : `${workspace.cwd}#${crypto.randomUUID()}`;
    shell.bindWorkspaceConnection(id, target);
    await openWorkspaceConnection(workspace.cwd, target, options?.fresh ? undefined : { restoreLast: true });
    // Starting a process must not steal the project's route from the workspace
    // that was on screen.
    if (previous && previous !== target) restoreProjectRoute(workspace.cwd, previous);
    focusWorkspaceConnection(target, workspace.cwd);
  }, []);

  /** ⌘T / the strip's plus: a new workspace with a fresh session. */
  const create = useCallback(async (projectCwd?: string) => {
    const workspace = useShell.getState().newWorkspace(projectCwd);
    await open(workspace.id, { fresh: true });
    return workspace;
  }, [open]);

  const close = useCallback(async (id: string) => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === id);
    if (!workspace || shell.workspaces.length < 2) return;
    const wasActive = shell.activeWorkspaceId === id;
    shell.closeWorkspace(id);
    if (wasActive) {
      const next = useShell.getState();
      const targetWorkspace = next.workspaces.find((item) => item.id === next.activeWorkspaceId);
      if (targetWorkspace) await open(targetWorkspace.id);
    }
    await closeWorkspaceConnection(workspace.connectionId, "工作区已关闭");
  }, [open]);

  /** ⌘D / ⌘⇧D: split a session pane and open a new session in it. */
  const splitSession = useCallback(async (paneId: string, dir: "right" | "down") => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    if (!workspace) return;
    const newPaneId = shell.splitSessionPane(paneId, dir);
    if (!newPaneId) return;
    const connectionId = `${workspace.cwd}#${crypto.randomUUID()}`;
    useShell.getState().bindSessionConnection(newPaneId, connectionId);
    await openWorkspaceConnection(workspace.cwd, connectionId);
    focusWorkspaceConnection(connectionId, workspace.cwd);
  }, []);

  return { open, create, close, splitSession };
}

export type { WorkspaceTab };
