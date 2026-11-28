import { firstLeafId, removePane, siblingLeafId } from "../paneLayout";
import { CHAT_PANE_ID, HOME_WORKSPACE_ID, isHomeWorkspace, newHomeWorkspace, projectWorkspaceTabs, type WorkspaceTab } from "../shellModel";

type SessionViews = { workspaces: WorkspaceTab[]; activeWorkspaceId: string; activeByProject: Record<string, string> };

/** Remove every view of the session in one store update, retaining unrelated panes. */
export function removeSessionViews(state: SessionViews, path: string, owners: ReadonlySet<string>): SessionViews {
  const removedIds = new Set<string>();
  let changed = false;
  const workspaces = state.workspaces.flatMap(workspace => {
    const ownsPrimary = owners.has(workspace.connectionId) || workspace.sessionPath === path;
    const primaryPane = Object.keys(workspace.sessions).find(id => workspace.sessions[id].connectionId === workspace.connectionId);
    const removedPanes = Object.keys(workspace.sessions).filter(id =>
      owners.has(workspace.sessions[id].connectionId) || (ownsPrimary && id === (primaryPane ?? CHAT_PANE_ID)));
    if (!ownsPrimary && !removedPanes.length) return [workspace];
    changed = true;
    let layout = workspace.layout;
    let activePane = workspace.activePane;
    const sessions = { ...workspace.sessions };
    for (const pane of removedPanes) {
      delete sessions[pane];
      const next = removePane(layout, pane);
      if (!next) {
        if (isHomeWorkspace(workspace)) return [newHomeWorkspace(workspace.cwd)];
        removedIds.add(workspace.id);
        return [];
      }
      if (activePane === pane) activePane = siblingLeafId(layout, pane) ?? firstLeafId(next);
      layout = next;
    }
    return [{
      ...workspace, layout, activePane, sessions,
      ...(ownsPrimary && {
        connectionId: sessions[activePane]?.connectionId ?? Object.values(sessions)[0]?.connectionId ?? "",
        sessionPath: undefined,
        title: undefined,
      }),
    }];
  });
  if (!changed) return state;
  const active = state.workspaces.find(workspace => workspace.id === state.activeWorkspaceId);
  let activeWorkspaceId = state.activeWorkspaceId;
  if (active && removedIds.has(active.id)) {
    const tabs = projectWorkspaceTabs(state.workspaces, active.cwd);
    const index = tabs.findIndex(workspace => workspace.id === active.id);
    const previous = tabs.slice(0, index).findLast(workspace => !removedIds.has(workspace.id));
    const next = tabs.slice(index + 1).find(workspace => !removedIds.has(workspace.id));
    activeWorkspaceId = previous?.id ?? next?.id ?? HOME_WORKSPACE_ID;
  }
  return {
    workspaces, activeWorkspaceId,
    activeByProject: Object.fromEntries(Object.entries(state.activeByProject).filter(([, id]) => !removedIds.has(id))),
  };
}
