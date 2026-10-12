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
  type PaneEdge,
} from "./paneLayout";
import {
  activeIndex,
  CHAT_PANE_ID,
  detachFile,
  fileName,
  findFile,
  HOME_WORKSPACE_ID,
  insertTab,
  newHomeWorkspace,
  newWorkspaceId,
  newWorkspaceTab,
  nextEditorPaneId,
  nextSessionPaneId,
  type CollapsedRailMode,
  type DockPosition,
  type OpenFile,
  type SidebarTab,
  type WorkspaceTab,
} from "./shellModel";

export { CHAT_PANE_ID, HOME_WORKSPACE_ID, isHomeWorkspace, newHomeWorkspace, newWorkspaceTab } from "./shellModel";
export type { CollapsedRailMode, DockPosition, OpenFile, PaneState, SidebarTab, WorkspaceTab } from "./shellModel";

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
const PROJECT_RAIL_KEY = "orbit.shell.projectRail";
const SESSION_SIDEBAR_KEY = "orbit.shell.sessionSidebar";
const SIDEBAR_TAB_KEY = "orbit.shell.sidebarTab";
const PROJECT_RAIL_WIDTH_KEY = "orbit.shell.projectRailWidth";
const SESSION_SIDEBAR_WIDTH_KEY = "orbit.shell.sessionSidebarWidth";

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

type ShellState = {
  workspaces: WorkspaceTab[];
  activeWorkspaceId: string;
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
  /** Patch one workspace's own fields (sessionPath/title/binding) in place. */
  updateWorkspace: (id: string, patch: Partial<Pick<WorkspaceTab, "sessionPath" | "title" | "cwd" | "connectionId">>) => void;
  /** Switch the visible workspace; the caller activates its pi connection. */
  activateWorkspace: (id: string) => void;
  newWorkspace: (cwd?: string, connectionId?: string, options?: { background?: boolean }) => WorkspaceTab;
  closeWorkspace: (id: string) => void;
  /** 首页工作区发出第一条消息后，把它升格成一个真正的会话标签页。返回新标签的 id。 */
  promoteHomeWorkspace: () => string | null;
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

/**
 * 启动总是落在首页（新会话面），标签页不持久化——恢复某次会话是会话列表的事，
 * 不是“默认落在哪个 tab”的事。`pi-gui.cwd` 只给首页一个初始范围，真正的范围由
 * bootstrap 确认后再刷新。
 */
function initialCwd(): string {
  try { return localStorage.getItem("pi-gui.cwd") ?? ""; } catch { return ""; }
}

const initial = {
  workspaces: [newHomeWorkspace(initialCwd())] as WorkspaceTab[],
  activeWorkspaceId: HOME_WORKSPACE_ID,
};

export const useShell = create<ShellState>((set, get) => {
  /** 把一次改动应用到当前工作区（首页也是一个工作区，所以永远有对象可改）。 */
  const patchActive = (update: (workspace: WorkspaceTab) => WorkspaceTab, extra?: Partial<ShellState>) => {
    const state = get();
    const index = activeIndex(state);
    const workspaces = [...state.workspaces];
    workspaces[index] = update(workspaces[index]);
    set({ workspaces, ...extra });
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

    updateWorkspace: (id, patch) => {
      const state = get();
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, ...patch } : workspace);
      set({ workspaces });
    },

    activateWorkspace: (activeWorkspaceId) => {
      const state = get();
      if (!state.workspaces.some((workspace) => workspace.id === activeWorkspaceId)) return;
      set({ activeWorkspaceId });
    },

    newWorkspace: (cwd, connectionId, options) => {
      const state = get();
      // connectionId 一并建好：新建的标签页绝不能先以空连接渲染一下，
      // 否则 SessionScope 会回退到当前投影（首页/上一个会话）闪一下。
      const workspace = newWorkspaceTab(cwd ?? state.workspaces[activeIndex(state)].cwd, connectionId);
      const workspaces = insertTab(state.workspaces, workspace);
      // background：自动化/子任务在后台开自己的会话，绝不抢用户正在看的标签页。
      set({ workspaces, ...(options?.background ? {} : { activeWorkspaceId: workspace.id }) });
      return workspace;
    },

    closeWorkspace: (id) => {
      const state = get();
      // 首页不是标签页，关不掉：最后一个标签页关掉后就落到它。
      if (id === HOME_WORKSPACE_ID) return;
      const index = state.workspaces.findIndex((workspace) => workspace.id === id);
      if (index < 0) return;
      const tabs = state.workspaces.filter((workspace) => workspace.id !== HOME_WORKSPACE_ID);
      const removedAt = tabs.findIndex((workspace) => workspace.id === id);
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
      // 相邻的那个标签页（先往前找，没有就往后），都没有就回首页。
      const nextId = state.activeWorkspaceId === id
        ? (tabs[removedAt - 1] ?? tabs[removedAt + 1])?.id ?? HOME_WORKSPACE_ID
        : state.activeWorkspaceId;
      set({ workspaces, activeWorkspaceId: nextId });
    },

    promoteHomeWorkspace: () => {
      const state = get();
      if (state.activeWorkspaceId !== HOME_WORKSPACE_ID) return null;
      const home = state.workspaces.find((workspace) => workspace.id === HOME_WORKSPACE_ID);
      if (!home) return null;
      // 首页第一条消息 → 变成真正的标签页（连同它已有的面板树一起），
      // 后面再补一个干净的首页。
      const tab: WorkspaceTab = { ...home, id: newWorkspaceId() };
      const rest = state.workspaces.filter((workspace) => workspace.id !== HOME_WORKSPACE_ID);
      const workspaces = [...rest, tab, newHomeWorkspace(home.cwd)];
      set({ workspaces, activeWorkspaceId: tab.id });
      return tab.id;
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
    },

    setWorkspaceCwd: (id, cwd) => {
      const state = get();
      const workspaces = state.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, cwd } : workspace);
      set({ workspaces });
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
