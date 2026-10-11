import { create } from "zustand";
import {
  firstLeafId,
  leaf,
  leafIds,
  movePane as movePaneLayout,
  placeNewPane,
  removePane,
  setSplitRatio as setSplitRatioLayout,
  siblingLeafId,
  type LayoutNode,
  type PaneEdge,
} from "./paneLayout";

/**
 * Layout state for the Orbit-style shell. Pi state (connections,
 * transcripts, sessions) stays in `lib/store`; this owns the workspace tabs,
 * each with its own pane tree and its own file tabs.
 *
 * The tree is Orbit's (`features/workspace/model/layout.ts`): leaves are
 * "chat" (a session pane) or editor panes ("editor:1", …). A workspace is
 * Orbit's `WorkspaceTab` minus the tab strip's own persistence concerns:
 * one pi connection, one tree.
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

/** The session pane's leaf id; editor panes use `editor:<n>`. */
export const CHAT_PANE_ID = "chat";

export type WorkspaceTab = {
  id: string;
  cwd: string;
  /** Pi RPC process bound to this workspace (empty until it is opened). */
  connectionId: string;
  layout: LayoutNode;
  panes: Record<string, PaneState>;
  /** Session panes: leaf id → the connection that pane shows (Orbit leaves). */
  sessions: Record<string, { connectionId: string }>;
  activePane: string;
};

const PROJECT_RAIL_KEY = "orbit.shell.projectRail";
const SESSION_SIDEBAR_KEY = "orbit.shell.sessionSidebar";
const SIDEBAR_TAB_KEY = "orbit.shell.sidebarTab";
const PROJECT_RAIL_WIDTH_KEY = "orbit.shell.projectRailWidth";
const SESSION_SIDEBAR_WIDTH_KEY = "orbit.shell.sessionSidebarWidth";
const WORKSPACES_KEY = "orbit.shell.workspaces";

function readBool(key: string, fallback: boolean) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function readNumber(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function newWorkspaceId() {
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
 * 撑起首页（EmptySession）。它有自己的连接 id（`<cwd>#home`），由
 * `useWorkspaceTabs.open` 开成一个全新的空会话，所以它永远不是某个旧会话的副本。
 */
export const HOME_WORKSPACE_ID = "home";

export function newHomeWorkspace(cwd: string): WorkspaceTab {
  return { ...newWorkspaceTab(cwd), id: HOME_WORKSPACE_ID };
}

export function isHomeWorkspace(workspace: WorkspaceTab | undefined): boolean {
  return workspace?.id === HOME_WORKSPACE_ID;
}

/** Next free session pane id; the first one is always `chat`. */
function nextSessionPaneId(sessions: Record<string, { connectionId: string }>) {
  let n = Object.keys(sessions).length;
  while (sessions[`session:${n}`]) n += 1;
  return `session:${n}`;
}

type Persisted = { workspaces: WorkspaceTab[]; activeWorkspaceId: string };

/** A stored workspace is only trusted when its tree still describes its panes. */
function readWorkspaces(cwd: string): Persisted {
  const fallback = (): Persisted => {
    const workspace = newWorkspaceTab(cwd);
    return { workspaces: [workspace], activeWorkspaceId: workspace.id };
  };
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (!raw) return fallback();
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (!Array.isArray(parsed.workspaces)) return fallback();
    const workspaces: WorkspaceTab[] = [];
    for (const entry of parsed.workspaces) {
      if (!entry || typeof entry !== "object") continue;
      const panes = entry.panes && typeof entry.panes === "object" ? entry.panes : {};
      const layout = entry.layout;
      if (!layout || typeof layout !== "object") continue;
      const sessions: Record<string, { connectionId: string }> = { [CHAT_PANE_ID]: { connectionId: "" } };
      if (entry.sessions && typeof entry.sessions === "object") {
        for (const id of Object.keys(entry.sessions)) {
          if (id === CHAT_PANE_ID) continue;
          sessions[id] = { connectionId: "" };
        }
      }
      const valid = new Set<string>([...Object.keys(sessions), ...Object.keys(panes)]);
      const seen: string[] = [];
      const walk = (node: LayoutNode): boolean => {
        if (node.type === "leaf") {
          if (!valid.has(node.id) || seen.includes(node.id)) return false;
          seen.push(node.id);
          return true;
        }
        if (!Array.isArray(node.children) || !Array.isArray(node.sizes)) return false;
        if (node.children.length < 2 || node.children.length !== node.sizes.length) return false;
        return node.children.every(walk);
      };
      if (!walk(layout) || !seen.includes(CHAT_PANE_ID)) continue;
      workspaces.push({
        id: typeof entry.id === "string" && entry.id ? entry.id : newWorkspaceId(),
        cwd: typeof entry.cwd === "string" && entry.cwd ? entry.cwd : cwd,
        connectionId: "",
        layout,
        panes,
        sessions,
        activePane: typeof entry.activePane === "string" && seen.includes(entry.activePane)
          ? entry.activePane
          : firstLeafId(layout),
      });
    }
    if (workspaces.length === 0) return fallback();
    const activeWorkspaceId = workspaces.some((workspace) => workspace.id === parsed.activeWorkspaceId)
      ? (parsed.activeWorkspaceId as string)
      : workspaces[0].id;
    return { workspaces, activeWorkspaceId };
  } catch {
    return fallback();
  }
}

type ShellState = Persisted & {
  /** Panes that just appeared from a split, keyed by pane id (transient). */
  entering: Record<string, PaneEdge>;
  /**
   * Bumped by every `openFile`, so a surface narrower than the desktop can
   * bring the file forward.
   *
   * The phone has no pane grid: it shows one file at a time and needs to know
   * that the user just asked for one, even when that file was already open
   * behind the conversation. Watching the open files alone cannot tell those
   * two apart.
   */
  fileOpenSeq: number;
  projectRailOpen: boolean;
  sessionSidebarOpen: boolean;
  /** monocode 风格的 ⌘P 快速打开浮层（转到文件 / `>` 命令）。 */
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  sidebarTab: SidebarTab;
  terminalPosition: DockPosition;
  terminalSize: number;
  terminalOpen: boolean;
  setTerminalSize: (size: number) => void;
  setTerminalOpen: (open: boolean) => void;
  setTerminalPosition: (position: DockPosition) => void;
  collapsedRailMode: CollapsedRailMode;
  setCollapsedRailMode: (mode: CollapsedRailMode) => void;
  projectRailWidth: number;
  sessionSidebarWidth: number;
  setProjectRailOpen: (open: boolean) => void;
  setSessionSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setProjectRailWidth: (width: number) => void;
  setSessionSidebarWidth: (width: number) => void;
  /** Switch the visible workspace; the caller activates its pi connection. */
  activateWorkspace: (id: string) => void;
  newWorkspace: (cwd?: string, connectionId?: string) => WorkspaceTab;
  closeWorkspace: (id: string) => void;
  /** 首页工作区发出第一条消息后，把它升格成一个真正的会话标签页。 */
  promoteHomeWorkspace: () => void;
  /** Split a session pane and open a new session in it (Orbit ⌘D / ⌘⇧D). */
  splitSessionPane: (paneId: string, dir: "right" | "down") => string | null;
  bindSessionConnection: (paneId: string, connectionId: string) => void;
  /** Move a pane out into a workspace of its own (Orbit `onDetachPane`).
   *  给出 targetTabId/position 时插到那个工作区标签页的前后（monocode 的
   *  标题栏插入行为），否则加在当前标签页后面。 */
  detachPaneToWorkspace: (paneId: string, targetTabId?: string, position?: "before" | "after") => WorkspaceTab | null;
  bindWorkspaceConnection: (id: string, connectionId: string) => void;
  setWorkspaceCwd: (id: string, cwd: string) => void;
  focusPane: (paneId: string) => void;
  /** Open a file in the focused editor pane, splitting one off when there is none.
   * `diff` opens the tab as a working-tree diff instead of an editable file;
   * `changes`/`commit` open the review tabs (synthetic paths, no real file). */
  openFile: (path: string, options?: { pin?: boolean; pane?: string; diff?: "staged" | "unstaged"; isDir?: boolean; changes?: true; commit?: { sha: string; shortSha: string; subject: string }; name?: string }) => void;
  pinFile: (path: string, pane?: string) => void;
  closeFile: (path: string, pane?: string) => void;
  focusFile: (path: string | null, pane?: string) => void;
  reorderFiles: (paneId: string, ids: string[]) => void;
  /** Orbit `movePane`: drag a pane onto another pane's edge. */
  movePane: (fromId: string, toId: string, edge: PaneEdge) => void;
  /** Drag a file tab into another pane. */
  moveFileToPane: (path: string, fromPane: string, toPane: string, index?: number) => void;
  /** Drag a file tab onto a pane edge: open it in a brand new pane there. */
  openFileInNewPane: (path: string, targetPane: string, edge: PaneEdge) => void;
  closePane: (paneId: string) => void;
  clearEntering: (paneId: string) => void;
  setSplitRatio: (splitId: string, index: number, ratio: number) => void;
};

const initial = typeof window === "undefined"
  ? { workspaces: [newWorkspaceTab("")], activeWorkspaceId: "" }
  : readWorkspaces(localStorage.getItem("pi-gui.cwd") ?? "");
if (!initial.activeWorkspaceId) initial.activeWorkspaceId = initial.workspaces[0].id;

function persist(state: Persisted) {
  // 首页工作区不入库：重开应用时按正常流程恢复上一次的会话标签页，不记住「全关了」。
  const real = state.workspaces.filter((workspace) => workspace.id !== HOME_WORKSPACE_ID);
  const activeWorkspaceId = real.some((workspace) => workspace.id === state.activeWorkspaceId)
    ? state.activeWorkspaceId
    : (real[0]?.id ?? "");
  write(WORKSPACES_KEY, JSON.stringify({
    activeWorkspaceId,
    workspaces: real.map(({ id, cwd, layout, panes, sessions, activePane }) => ({ id, cwd, layout, panes, sessions, activePane })),
  }));
}

function activeIndex(state: Pick<ShellState, "workspaces" | "activeWorkspaceId">) {
  const index = state.workspaces.findIndex((workspace) => workspace.id === state.activeWorkspaceId);
  return index < 0 ? 0 : index;
}

function findFile(workspace: WorkspaceTab, path: string) {
  for (const [paneId, pane] of Object.entries(workspace.panes)) {
    const index = pane.files.findIndex((file) => file.path === path);
    if (index >= 0) return { paneId, index };
  }
  return null;
}

function nextEditorPaneId(panes: Record<string, PaneState>) {
  let n = Object.keys(panes).length + 1;
  while (panes[`editor:${n}`]) n += 1;
  return `editor:${n}`;
}

/** Take a file out of its pane; the pane closes when it was its last tab. */
function detachFile(workspace: WorkspaceTab, path: string): WorkspaceTab | null {
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

export const useShell = create<ShellState>((set, get) => {
  /** Apply an update to the active workspace and persist the result. */
  const patchActive = (update: (workspace: WorkspaceTab) => WorkspaceTab, extra?: Partial<ShellState>) => {
    const state = get();
    const index = activeIndex(state);
    const workspaces = [...state.workspaces];
    workspaces[index] = update(workspaces[index]);
    const next = { ...state, ...extra, workspaces };
    set({ workspaces, ...extra });
    persist(next);
    return workspaces[index];
  };

  return {
    ...initial,
    entering: {},
    fileOpenSeq: 0,
    projectRailOpen: readBool(PROJECT_RAIL_KEY, true),
    sessionSidebarOpen: readBool(SESSION_SIDEBAR_KEY, true),
    quickOpen: false,
    setQuickOpen: (open) => set({ quickOpen: open }),
    sidebarTab: (() => {
      try {
        const value = localStorage.getItem(SIDEBAR_TAB_KEY);
        return value === "files" || value === "changes" ? value : "changes";
      } catch { return "changes"; }
    })(),
    terminalPosition: (() => {
      try {
        const raw = localStorage.getItem("orbit.terminal.position");
        return raw === "top" || raw === "left" || raw === "right" ? raw : "bottom";
      } catch { return "bottom"; }
    })() as DockPosition,
    setTerminalPosition: (position) => {
      write("orbit.terminal.position", position);
      set({ terminalPosition: position });
    },
    terminalSize: readNumber("orbit.terminal.size", 220),
    terminalOpen: (() => { try { return localStorage.getItem("orbit.terminal.open") === "true"; } catch { return false; } })(),
    setTerminalSize: (terminalSize) => { write("orbit.terminal.size", String(terminalSize)); set({ terminalSize }); },
    setTerminalOpen: (terminalOpen) => { write("orbit.terminal.open", String(terminalOpen)); set({ terminalOpen }); },
    collapsedRailMode: (() => { try { return localStorage.getItem("orbit.shell.collapsedRail") === "hidden" ? "hidden" : "compact"; } catch { return "compact"; } })() as CollapsedRailMode,
    setCollapsedRailMode: (mode) => { write("orbit.shell.collapsedRail", mode); set({ collapsedRailMode: mode }); },
    projectRailWidth: readNumber(PROJECT_RAIL_WIDTH_KEY, 240),
    sessionSidebarWidth: readNumber(SESSION_SIDEBAR_WIDTH_KEY, 272),
    setProjectRailOpen: (open) => { write(PROJECT_RAIL_KEY, String(open)); set({ projectRailOpen: open }); },
    setSessionSidebarOpen: (open) => { write(SESSION_SIDEBAR_KEY, String(open)); set({ sessionSidebarOpen: open }); },
    setSidebarTab: (tab) => { write(SIDEBAR_TAB_KEY, tab); set({ sidebarTab: tab }); },
    setProjectRailWidth: (width) => { write(PROJECT_RAIL_WIDTH_KEY, String(width)); set({ projectRailWidth: width }); },
    setSessionSidebarWidth: (width) => { write(SESSION_SIDEBAR_WIDTH_KEY, String(width)); set({ sessionSidebarWidth: width }); },

    activateWorkspace: (activeWorkspaceId) => {
      const state = get();
      if (!state.workspaces.some((workspace) => workspace.id === activeWorkspaceId)) return;
      set({ activeWorkspaceId });
      persist({ workspaces: state.workspaces, activeWorkspaceId });
    },

    newWorkspace: (cwd, connectionId) => {
      const state = get();
      const workspace = newWorkspaceTab(cwd ?? state.workspaces[activeIndex(state)].cwd, connectionId);
      const workspaces = [...state.workspaces, workspace];
      set({ workspaces, activeWorkspaceId: workspace.id });
      persist({ workspaces, activeWorkspaceId: workspace.id });
      return workspace;
    },

    closeWorkspace: (id) => {
      const state = get();
      // 首页工作区不是标签页，不能关；关掉最后一个标签页时它会被自动补出来。
      if (id === HOME_WORKSPACE_ID) return;
      const index = state.workspaces.findIndex((workspace) => workspace.id === id);
      if (index < 0) return;
      const removed = state.workspaces[index];
      let workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
      // 所有标签页都关掉了：留一个隐藏的首页工作区，内容走 EmptySession。
      if (!workspaces.some((workspace) => workspace.id === HOME_WORKSPACE_ID)) {
        const real = workspaces.filter((workspace) => workspace.id !== HOME_WORKSPACE_ID);
        if (real.length === 0) workspaces = [...workspaces, newHomeWorkspace(removed.cwd)];
      }
      let activeWorkspaceId = state.activeWorkspaceId;
      if (activeWorkspaceId === id) {
        const real = workspaces.filter((workspace) => workspace.id !== HOME_WORKSPACE_ID);
        activeWorkspaceId = real[Math.min(index, real.length - 1)]?.id ?? HOME_WORKSPACE_ID;
      }
      if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
        activeWorkspaceId = workspaces[0].id;
      }
      set({ workspaces, activeWorkspaceId });
      persist({ workspaces, activeWorkspaceId });
    },

    promoteHomeWorkspace: () => {
      const state = get();
      const index = state.workspaces.findIndex((workspace) => workspace.id === HOME_WORKSPACE_ID);
      if (index < 0 || state.activeWorkspaceId !== HOME_WORKSPACE_ID) return;
      const workspaces = [...state.workspaces];
      const id = newWorkspaceId();
      workspaces[index] = { ...workspaces[index], id };
      set({ workspaces, activeWorkspaceId: id });
      persist({ workspaces, activeWorkspaceId: id });
    },

    detachPaneToWorkspace: (paneId, targetTabId, position) => {
      const state = get();
      const index = activeIndex(state);
      const source = state.workspaces[index];
      if (paneId === CHAT_PANE_ID || !source.panes[paneId]) return null;
      const ids = leafIds(source.layout);
      const layout = removePane(source.layout, paneId);
      if (!layout) return null;
      const panes = { ...source.panes };
      const pane = panes[paneId];
      delete panes[paneId];
      const sourceNext: WorkspaceTab = {
        ...source,
        layout,
        panes,
        activePane: source.activePane === paneId
          ? (siblingLeafId(source.layout, paneId) ?? firstLeafId(layout))
          : source.activePane,
      };
      const workspace: WorkspaceTab = {
        id: newWorkspaceId(),
        cwd: source.cwd,
        connectionId: "",
        layout: leaf(paneId),
        panes: { [paneId]: pane },
        sessions: {} as Record<string, { connectionId: string }>,
        activePane: paneId,
      };
      const workspaces = [...state.workspaces];
      workspaces[index] = sourceNext;
      let insertAt = index + (ids.length > 1 ? 1 : 0);
      if (targetTabId) {
        const target = workspaces.findIndex((item) => item.id === targetTabId);
        if (target >= 0) insertAt = position === "after" ? target + 1 : target;
      }
      workspaces.splice(insertAt, 0, workspace);
      set({ workspaces, activeWorkspaceId: workspace.id });
      persist({ workspaces, activeWorkspaceId: workspace.id });
      return workspace;
    },

    splitSessionPane: (paneId, dir) => {
      const state = get();
      const workspace = state.workspaces[activeIndex(state)];
      if (!workspace.sessions[paneId]) return null;
      const newPaneId = nextSessionPaneId(workspace.sessions);
      patchActive((current) => ({
        ...current,
        layout: placeNewPane(current.layout, paneId, newPaneId, dir === "right" ? "right" : "bottom"),
        sessions: { ...current.sessions, [newPaneId]: { connectionId: "" } },
        activePane: newPaneId,
      }), { entering: { ...state.entering, [newPaneId]: dir === "right" ? "right" as PaneEdge : "bottom" as PaneEdge } });
      return newPaneId;
    },

    bindSessionConnection: (paneId, connectionId) => {
      patchActive((current) => (current.sessions[paneId]
        ? { ...current, sessions: { ...current.sessions, [paneId]: { connectionId } } }
        : current));
    },

    bindWorkspaceConnection: (id, connectionId) => {
      const state = get();
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, connectionId } : workspace);
      set({ workspaces });
      persist({ workspaces, activeWorkspaceId: state.activeWorkspaceId });
    },

    setWorkspaceCwd: (id, cwd) => {
      const state = get();
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, cwd } : workspace);
      set({ workspaces });
      persist({ workspaces, activeWorkspaceId: state.activeWorkspaceId });
    },

    focusPane: (paneId) => {
      patchActive((workspace) => {
        if (paneId !== CHAT_PANE_ID && !workspace.panes[paneId]) return workspace;
        return workspace.activePane === paneId ? workspace : { ...workspace, activePane: paneId };
      });
    },

    openFile: (path, options) => {
      const state = get();
      set({ fileOpenSeq: state.fileOpenSeq + 1 });
      const index = activeIndex(state);
      const workspace = state.workspaces[index];
      const found = findFile(workspace, path);
      const review = {
        ...(options?.changes ? { changes: true as const } : {}),
        ...(options?.commit ? { commit: options.commit } : {}),
      };
      if (found) {
        patchActive((current) => {
          const pane = current.panes[found.paneId];
          const files = pane.files.map((file) =>
            file.path === path
              ? { ...file, preview: options?.pin ? false : file.preview, diff: options?.diff, ...(options?.isDir ? { isDir: true } : {}), ...(options?.name ? { name: options.name } : {}), ...review }
              : file,
          );
          return { ...current, panes: { ...current.panes, [found.paneId]: { files, activeFile: path } }, activePane: found.paneId };
        });
        return;
      }
      const requested = options?.pane && workspace.panes[options.pane] ? options.pane : null;
      const target = requested ?? (workspace.panes[workspace.activePane] ? workspace.activePane : Object.keys(workspace.panes)[0] ?? null);
      const entry: OpenFile = { path, name: options?.name ?? fileName(path), preview: !options?.pin, ...(options?.diff ? { diff: options.diff } : {}), ...(options?.isDir ? { isDir: true } : {}), ...review };
      if (target) {
        patchActive((current) => {
          const pane = current.panes[target];
          const files = options?.pin ? pane.files : pane.files.filter((file) => !file.preview);
          return { ...current, panes: { ...current.panes, [target]: { files: [...files, entry], activeFile: path } }, activePane: target };
        });
        return;
      }
      // No editor pane yet: Orbit opens one beside the focused pane.
      const paneId = nextEditorPaneId(workspace.panes);
      patchActive(
        (current) => ({
          ...current,
          layout: placeNewPane(current.layout, current.activePane, paneId, "right"),
          panes: { ...current.panes, [paneId]: { files: [entry], activeFile: path } },
          activePane: paneId,
        }),
        { entering: { ...state.entering, [paneId]: "right" as PaneEdge } },
      );
    },

    pinFile: (path, paneId) => {
      const workspace = get().workspaces[activeIndex(get())];
      const target = paneId ?? findFile(workspace, path)?.paneId;
      if (!target || !workspace.panes[target]) return;
      patchActive((current) => {
        const pane = current.panes[target];
        return { ...current, panes: { ...current.panes, [target]: { ...pane, files: pane.files.map((file) => (file.path === path ? { ...file, preview: false } : file)) } } };
      });
    },

    closeFile: (path, paneId) => {
      const workspace = get().workspaces[activeIndex(get())];
      const target = paneId && workspace.panes[paneId] ? paneId : findFile(workspace, path)?.paneId;
      if (!target) return;
      patchActive((current) => {
        const pane = current.panes[target];
        const files = pane.files.filter((file) => file.path !== path);
        if (files.length > 0) {
          return {
            ...current,
            panes: { ...current.panes, [target]: { files, activeFile: pane.activeFile === path ? (files.at(-1)?.path ?? null) : pane.activeFile } },
          };
        }
        // Last tab of an editor pane: the pane itself goes away (Orbit `closeLeaf`).
        const panes = { ...current.panes };
        delete panes[target];
        const layout = removePane(current.layout, target) ?? current.layout;
        return {
          ...current,
          layout,
          panes,
          activePane: current.activePane === target
            ? (siblingLeafId(current.layout, target) ?? firstLeafId(layout))
            : current.activePane,
        };
      });
    },

    focusFile: (path, paneId) => {
      const workspace = get().workspaces[activeIndex(get())];
      const target = paneId && workspace.panes[paneId] ? paneId : (path ? findFile(workspace, path)?.paneId : workspace.activePane);
      if (!target || !workspace.panes[target]) {
        if (target === CHAT_PANE_ID) patchActive((current) => ({ ...current, activePane: CHAT_PANE_ID }));
        return;
      }
      patchActive((current) => ({
        ...current,
        panes: { ...current.panes, [target]: { ...current.panes[target], activeFile: path } },
        activePane: target,
      }));
    },

    reorderFiles: (paneId, ids) => {
      const workspace = get().workspaces[activeIndex(get())];
      const pane = workspace.panes[paneId];
      if (!pane) return;
      const byPath = new Map(pane.files.map((file) => [file.path, file]));
      const files: OpenFile[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        const file = byPath.get(id);
        if (!file || seen.has(id)) continue;
        seen.add(id);
        files.push(file);
      }
      for (const file of pane.files) if (!seen.has(file.path)) files.push(file);
      patchActive((current) => ({ ...current, panes: { ...current.panes, [paneId]: { ...pane, files } } }));
    },

    movePane: (fromId, toId, edge) => {
      patchActive((current) => ({
        ...current,
        layout: movePaneLayout(current.layout, fromId, toId, edge),
        activePane: fromId,
      }));
    },

    moveFileToPane: (path, fromPane, toPane, index) => {
      const state = get();
      const workspace = state.workspaces[activeIndex(state)];
      if (fromPane === toPane) return;
      const target = workspace.panes[toPane];
      const file = workspace.panes[fromPane]?.files.find((item) => item.path === path);
      if (!target || !file) return;
      const detached = detachFile(workspace, path);
      if (!detached) return;
      const pane = detached.panes[toPane] ?? target;
      const files = [...pane.files];
      files.splice(index == null ? files.length : Math.max(0, Math.min(files.length, index)), 0, file);
      patchActive(() => ({
        ...detached,
        panes: { ...detached.panes, [toPane]: { files, activeFile: path } },
        activePane: toPane,
      }));
    },

    openFileInNewPane: (path, targetPane, edge) => {
      const state = get();
      const workspace = state.workspaces[activeIndex(state)];
      const entry = findFile(workspace, path);
      const source = entry ? workspace.panes[entry.paneId].files.find((item) => item.path === path) : null;
      const detached = detachFile(workspace, path) ?? workspace;
      const paneId = nextEditorPaneId(detached.panes);
      patchActive(
        () => ({
          ...detached,
          layout: placeNewPane(detached.layout, targetPane, paneId, edge),
          panes: {
            ...detached.panes,
            [paneId]: {
              files: [source ?? { path, name: fileName(path), preview: false }],
              activeFile: path,
            },
          },
          activePane: paneId,
        }),
        { entering: { ...state.entering, [paneId]: edge } },
      );
    },

    closePane: (paneId) => {
      const workspace = get().workspaces[activeIndex(get())];
      const session = Boolean(workspace.sessions[paneId]);
      if (session && Object.keys(workspace.sessions).length < 2) return;
      if (!session && !workspace.panes[paneId]) return;
      patchActive((current) => {
        const panes = { ...current.panes };
        delete panes[paneId];
        const sessions = { ...current.sessions };
        delete sessions[paneId];
        const layout = removePane(current.layout, paneId) ?? current.layout;
        return {
          ...current,
          layout,
          panes,
          sessions,
          activePane: current.activePane === paneId
            ? (siblingLeafId(current.layout, paneId) ?? firstLeafId(layout))
            : current.activePane,
        };
      });
    },

    clearEntering: (paneId) => {
      const state = get();
      if (!(paneId in state.entering)) return;
      const entering = { ...state.entering };
      delete entering[paneId];
      set({ entering });
    },

    setSplitRatio: (splitId, index, ratio) => {
      patchActive((current) => ({ ...current, layout: setSplitRatioLayout(current.layout, splitId, index, ratio) }));
    },
  };
});

/** The workspace the shell is showing. */
export function useActiveWorkspace<T>(selector: (workspace: WorkspaceTab) => T): T {
  return useShell((state) => selector(state.workspaces[activeIndex(state)]));
}

export type { LayoutNode, LayoutSash, PaneEdge, SplitDir } from "./paneLayout";
