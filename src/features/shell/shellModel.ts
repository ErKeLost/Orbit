import {
  firstLeafId,
  leaf,
  removePane,
  siblingLeafId,
  type LayoutNode,
} from "./paneLayout";

/**
 * Pure shell model: the workspace-tab / pane-tree shapes and the functions that
 * transform them. No zustand, no pi, no DOM — `shellStore.ts` owns the mutable
 * state and calls into this file, so the layout rules can be tested or reused
 * on their own.
 */
export type SidebarTab = "sessions" | "files" | "changes";
export type CollapsedRailMode = "compact" | "hidden";
export type DockPosition = "bottom" | "top" | "left" | "right";
export type OpenFile = { path: string; name: string; preview: boolean; /** Set on a diff tab: the working-tree comparison it shows. */ diff?: "staged" | "unstaged"; /**
   * Set on an all-changes review tab: every staged/unstaged file in one view.
   * The path is synthetic (`changes:<kind>`); there is no real file behind it.
   */ changes?: true; /**
   * Set on a commit review tab: one historical commit's files and diffs.
   * The path is synthetic (`commit:<sha>`).
   */ commit?: { sha: string; shortSha: string; subject: string }; /**
   * Known on a folder opened from the tree or a listing, so the pane does not
   * have to ask the disk before it knows not to read a directory as text.
   * `lib/path-meta` stays the authority; this only avoids the first round trip.
   */ isDir?: boolean };
export type PaneState = { files: OpenFile[]; activeFile: string | null };

/** The path prefix that marks a tab as a browser page rather than a file. */
export const BROWSER_PATH_PREFIX = "browser:";

export function isBrowserPath(path: string): boolean {
  return path.startsWith(BROWSER_PATH_PREFIX);
}

/**
 * A browser tab: the window's own page, not a file in a pane.
 *
 * It belongs to the window the way the terminal dock does — the browser column
 * keeps its pages while the pane grid is split, closed, or swapped for a
 * full-page surface, and while the user switches workspace tabs. A synthetic
 * path (`browser:<id>`) is the identity the native view is keyed by
 * (`browser_view.rs`).
 *
 * `agent` marks a page a browser run has temporarily claimed. The claim is
 * released when the run ends; the page remains available for the user and the
 * next run can reuse it without destroying its history.
 */
export type BrowserTabInfo = {
  path: string;
  url: string;
  title?: string;
  audioMuted?: boolean;
  /** A run currently has exclusive operation rights for this tab. */
  agent?: true;
  /**
   * A run's tab that outlived its run because only the person can continue
   * there (a sign-in wall, a checkout). It is the column's tab now: links land
   * in it and the user drives it. Only one is kept.
   */
  handoff?: true;
};

/**
 * The page that floats over the app instead of sitting in the browser column.
 *
 * It is **the same page**: a native view placed at a rectangle, and a floating
 * page is that view asked to sit somewhere else. Nothing is screenshotted,
 * mirrored or streamed a second time — which is why the floating page keeps
 * scrolling, selection, IME and its login session, and why the agent's
 * channel can keep driving it while it floats.
 *
 * The rectangle is in window-logical pixels, the same units the view is placed
 * in (`browser_view.rs`), so a floating page is exactly a second placement of
 * one view rather than a second view.
 */
export type BrowserPipState = {
  /** The tab whose page is floating (`browser:<id>`). */
  tab: string;
  /** Where it sits, in window-logical pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Every browser tab the window has open, by tab path (`browser:<id>`). */
export function browserTabPaths(tabs: BrowserTabInfo[]): string[] {
  return tabs.map((tab) => tab.path);
}

/** The session pane's leaf id; editor panes use `editor:<n>`. */
export const CHAT_PANE_ID = "chat";

export type WorkspaceTab = {
  id: string;
  cwd: string;
  /** Pi RPC process bound to this workspace (empty until it is opened). */
  connectionId: string;
  /**
   * The session file this tab shows. Outlives the process: a hibernated tab (its
   * connection reclaimed, or restored after a restart) is revived from it.
   */
  sessionPath?: string;
  /** Last known session title, for the tab label while it has no live process. */
  title?: string;
  layout: LayoutNode;
  panes: Record<string, PaneState>;
  /** Session panes: leaf id → the connection that pane shows (Orbit leaves). */
  sessions: Record<string, { connectionId: string }>;
  activePane: string;
};

/** Index into `workspaces` of the active surface; 0 when it is missing. */
export function activeIndex(state: { workspaces: WorkspaceTab[]; activeWorkspaceId: string }): number {
  const index = state.workspaces.findIndex((workspace) => workspace.id === state.activeWorkspaceId);
  return index < 0 ? 0 : index;
}

export function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function newWorkspaceId() {
  return `ws-${crypto.randomUUID().slice(0, 8)}`;
}

export function newWorkspaceTab(cwd: string, connectionId = ""): WorkspaceTab {
  return {
    id: newWorkspaceId(),
    cwd,
    connectionId,
    layout: leaf(CHAT_PANE_ID),
    panes: {},
    sessions: { [CHAT_PANE_ID]: { connectionId } },
    activePane: CHAT_PANE_ID,
  };
}

/**
 * The hidden 「新会话」工作区：没有 pi 进程的 tab，只在所有标签页关掉之后
 * 撑起首页（EmptySession）。它有自己的连接，由 `use-workspace-tabs.show` 开成
 * 一个全新的空会话，所以它永远不是某个旧会话的副本。
 */
export const HOME_WORKSPACE_ID = "home";

export function newHomeWorkspace(cwd: string): WorkspaceTab {
  return { ...newWorkspaceTab(cwd), id: HOME_WORKSPACE_ID };
}

export function isHomeWorkspace(workspace: WorkspaceTab | undefined): boolean {
  return workspace?.id === HOME_WORKSPACE_ID;
}

/** 去掉尾部斜杠再比，`/a` 与 `/a/` 是同一个项目。 */
function sameProjectCwd(left: string, right: string): boolean {
  return (left.replace(/\/+$/, "") || "/") === (right.replace(/\/+$/, "") || "/");
}

/**
 * header 里的标签页是挂项目的：只返回当前项目的会话标签页，首页永远不是标签页。
 *
 * 其它项目的会话不会被删，也不影响它们后台继续跑；只是不出现在这个项目的条里，
 * 切回那个项目时再整套换回来（见 `activeByProject`）。
 */
export function projectWorkspaceTabs(workspaces: WorkspaceTab[], cwd: string): WorkspaceTab[] {
  return workspaces.filter(
    (workspace) => !isHomeWorkspace(workspace) && (!cwd || sameProjectCwd(workspace.cwd, cwd)),
  );
}

/** Next free session pane id; the first one is always `chat`. */
export function nextSessionPaneId(sessions: Record<string, { connectionId: string }>) {
  let n = Object.keys(sessions).length;
  while (sessions[`session:${n}`]) n += 1;
  return `session:${n}`;
}

/** 标签页一律插在首页前面，首页永远排在最后。 */
export function insertTab(workspaces: WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  const home = workspaces.findIndex((workspace) => workspace.id === HOME_WORKSPACE_ID);
  const next = [...workspaces];
  next.splice(home < 0 ? next.length : home, 0, tab);
  return next;
}

export function findFile(workspace: WorkspaceTab, path: string) {
  for (const [paneId, pane] of Object.entries(workspace.panes)) {
    const index = pane.files.findIndex((file) => file.path === path);
    if (index >= 0) return { paneId, index };
  }
  return null;
}

export function nextEditorPaneId(panes: Record<string, PaneState>) {
  let n = Object.keys(panes).length + 1;
  while (panes[`editor:${n}`]) n += 1;
  return `editor:${n}`;
}

/** Take a file out of its pane; the pane closes when it was its last tab. */
export function detachFile(workspace: WorkspaceTab, path: string): WorkspaceTab | null {
  const found = findFile(workspace, path);
  if (!found) return null;
  const pane = workspace.panes[found.paneId];
  const files = pane.files.filter((file) => file.path !== path);
  const activeFile = pane.activeFile === path ? (files.at(-1)?.path ?? null) : pane.activeFile;
  if (files.length > 0) {
    return { ...workspace, panes: { ...workspace.panes, [found.paneId]: { files, activeFile } } };
  }
  const panes = { ...workspace.panes };
  delete panes[found.paneId];
  const layout = removePane(workspace.layout, found.paneId) ?? workspace.layout;
  const activePane = workspace.activePane === found.paneId
    ? (siblingLeafId(workspace.layout, found.paneId) ?? firstLeafId(layout))
    : workspace.activePane;
  return { ...workspace, layout, panes, activePane };
}
