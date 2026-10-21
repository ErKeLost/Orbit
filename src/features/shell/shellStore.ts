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
  isBrowserPath,
  isHomeWorkspace,
  newHomeWorkspace,
  newWorkspaceId,
  projectWorkspaceTabs,
  newWorkspaceTab,
  nextEditorPaneId,
  nextSessionPaneId,
  type CollapsedRailMode,
  type DockPosition,
  type BrowserPipState,
  type BrowserTabInfo,
  type OpenFile,
  type SidebarTab,
  type WorkspaceTab,
} from "./shellModel";

export { CHAT_PANE_ID, HOME_WORKSPACE_ID, isHomeWorkspace, projectWorkspaceTabs, browserTabPaths, newHomeWorkspace, newWorkspaceTab } from "./shellModel";

export type { BrowserPipState, CollapsedRailMode, DockPosition, OpenFile, PaneState, SidebarTab, WorkspaceTab } from "./shellModel";

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

const BROWSER_PIP_RECT_KEY = "orbit.browser.pip";

/** 画中画上次停在哪。没有就落在右下角。 */
function readPipRect(): { x: number; y: number; width: number; height: number } {
  const fallback = { x: 0, y: 0, width: 460, height: 340 };
  try {
    const raw = localStorage.getItem(BROWSER_PIP_RECT_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<typeof fallback>;
    if (![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part))) {
      return fallback;
    }
    return {
      x: value.x!,
      y: value.y!,
      width: Math.max(240, value.width!),
      height: Math.max(180, value.height!),
    };
  } catch {
    return fallback;
  }
}

function writePipRect(rect: { x: number; y: number; width: number; height: number }) {
  try { localStorage.setItem(BROWSER_PIP_RECT_KEY, JSON.stringify(rect)); } catch { /* storage unavailable */ }
}

/** 窗口有多大。没有窗口的地方（服务端、单测）给一个够用的默认值。 */
function viewport() {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

type ShellState = {
  workspaces: WorkspaceTab[];
  activeWorkspaceId: string;
  /**
   * 每个项目（cwd）最后一次激活的会话标签页。header 上的会话是挂项目的：
   * 在项目栏切项目时用它把那个项目上次的会话原样带回来，而不是每次开一个新的。
   */
  activeByProject: Record<string, string>;
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
  /**
   * Browser Use's第三栏 (`docs/BROWSER_USE.md`). A shell-level column, not a
   * pane: it belongs to the window, not to one workspace, because the web view
   * behind it outlives any single session, pane and panel — the agent may start
   * a task from another workspace, and the page must not disappear when the
   * user splits, closes a pane or opens settings.
   *
   * Tabs live here rather than in a workspace's pane list: a page that a link
   * opened must survive the pane it was opened from.
   */
  browserTabs: BrowserTabInfo[];
  browserActive: string | null;
  browserOpen: boolean;
  browserWidth: number;
  setBrowserOpen: (open: boolean) => void;
  setBrowserWidth: (width: number) => void;
  setBrowserActive: (path: string | null) => void;
  /**
   * 画中画：浮在窗口上的那一页。
   *
   * 它不是第二份页面，而是**同一个原生视图换了个矩形**（`browser_view.rs`
   * 的 `set_position`/`set_size`）——所以浮起来的页面照样能滚动、能选中、
   * 能登录，agent 的通道也照样能驱动它。
   *
   * 同一时刻只有一页在浮：视图只有一个，位置也只有一个。
   */
  browserPip: BrowserPipState | null;
  /** 把某一页弹成画中画；已经是画中画的那一页再点一次就收回列里。 */
  toggleBrowserPip: (path: string) => void;
  /** 把画中画收回浏览器列（页面还在，只是回到了列里）。 */
  dockBrowserPip: () => void;
  /** 拖动或缩放画中画。 */
  moveBrowserPip: (patch: Partial<Pick<BrowserPipState, "x" | "y" | "width" | "height">>) => void;
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
  /** Open a browser tab (a real web view) in a pane, and return its tab path. */
  openBrowser: (url: string, options?: { path?: string }) => string;
  /**
   * Open an http(s) link from inside the app.
   *
   * A link in the transcript belongs beside the conversation, not in the user's
   * own browser: this focuses the browser tab this workspace already has (and
   * navigates it, the way a browser would) or opens one in a pane of its own on
   * the right. It never grows a second `browser:` page per click.
   */
  openLink: (url: string) => string;
  /** The page a browser tab is showing, as the tab strip's label and the page itself report it. */
  updateBrowser: (path: string, patch: { url?: string; title?: string }) => void;
  /**
   * Take a run's tab over, page and all (`browser:handoff`).
   *
   * A run that dead-ends on a sign-in wall or a checkout cannot finish the job,
   * and closing its tab would take the only page that can — the one it just
   * loaded — with it, dropping the window back to whatever was in front before.
   * This is that page staying instead: the tab stops being the run's (a link
   * lands in it, the user types in it) and becomes the column's own.
   */
  adoptBrowser: (path: string, url?: string) => void;
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
  restoreHomeSessionPane: () => void;
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
  activeByProject: {} as Record<string, string>,
};

/** 记录/更新一个工作区作为它项目的「当前会话」；首页本身不是某个项目的会话。 */
function rememberActive(map: Record<string, string>, workspace: WorkspaceTab): Record<string, string> {
  if (isHomeWorkspace(workspace) || !workspace.cwd) return map;
  if (map[workspace.cwd] === workspace.id) return map;
  return { ...map, [workspace.cwd]: workspace.id };
}

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
    // 浏览器列（第三栏）：跟终端 dock 一样属于窗口，不属于某个工作区或面板——切工作区
    // 标签、切设置、关面板都不该带走正在看的页面。
    browserTabs: [] as BrowserTabInfo[],
    browserActive: null as string | null,
    browserOpen: readBool("orbit.browser.open", false),
    browserWidth: readNumber("orbit.browser.size", 520),
    setBrowserOpen: (browserOpen) => { write("orbit.browser.open", String(browserOpen)); set({ browserOpen }); },
    setBrowserWidth: (browserWidth) => { write("orbit.browser.size", String(browserWidth)); set({ browserWidth }); },
    setBrowserActive: (browserActive) => set({ browserActive }),
    // 画中画：位置记在本地，下次弹出还在原处。
    browserPip: null as BrowserPipState | null,
    toggleBrowserPip: (path) => {
      const state = get();
      if (state.browserPip?.tab === path) {
        state.dockBrowserPip();
        return;
      }
      const tab = state.browserTabs.find((item) => item.path === path);
      if (!tab) return;
      const remembered = readPipRect();
      const screen = viewport();
      const width = Math.min(remembered.width, Math.floor(screen.width * 0.5));
      const height = Math.min(remembered.height, Math.floor(screen.height * 0.6));
      // 默认落在右下角：那里是聊天最后一行之外的地方，浮起来不会盖住正在读的话。
      const x = Math.max(0, Math.min(remembered.x, screen.width - width - 16));
      const y = Math.max(0, Math.min(remembered.y, screen.height - height - 16));
      set({ browserPip: { tab: path, x, y, width, height } });
      // 浮起来的页也是"在前面的那一页"：agent 的通道默认对它说话。
      set({ browserActive: path });
    },
    dockBrowserPip: () => set({ browserPip: null }),
    moveBrowserPip: (patch) => {
      const state = get();
      const pip = state.browserPip;
      if (!pip) return;
      const next = { ...pip, ...patch };
      // 记住它停在哪：下次弹出还是这个角落。
      writePipRect(next);
      set({ browserPip: next });
    },
    // On by default, and off only when the user said so: the column is where
    // the browser lives, and a task's page has to stay visible while the user
    // works in other panels.
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
      const workspace = state.workspaces.find((item) => item.id === activeWorkspaceId);
      if (!workspace) return;
      set({ activeWorkspaceId, activeByProject: rememberActive(state.activeByProject, workspace) });
    },

    newWorkspace: (cwd, connectionId, options) => {
      const state = get();
      // connectionId 一并建好：新建的标签页绝不能先以空连接渲染一下，
      // 否则 SessionScope 会回退到当前投影（首页/上一个会话）闪一下。
      const workspace = newWorkspaceTab(cwd ?? state.workspaces[activeIndex(state)].cwd, connectionId);
      const workspaces = insertTab(state.workspaces, workspace);
      // background：自动化/子任务在后台开自己的会话，绝不抢用户正在看的标签页。
      set({
        workspaces,
        ...(options?.background ? {} : {
          activeWorkspaceId: workspace.id,
          activeByProject: rememberActive(state.activeByProject, workspace),
        }),
      });
      return workspace;
    },

    closeWorkspace: (id) => {
      const state = get();
      // 首页不是标签页，关不掉：最后一个标签页关掉后就落到它。
      if (id === HOME_WORKSPACE_ID) return;
      const index = state.workspaces.findIndex((workspace) => workspace.id === id);
      if (index < 0) return;
      const closing = state.workspaces[index];
      // header 上的标签是挂项目的。相邻页只在**同一个项目**里找：关掉这个项目的最
      // 后一页时要落回这个项目的新会话面，而不是被顺手丢进另一个项目还开着的标签页。
      const projectTabs = projectWorkspaceTabs(state.workspaces, closing.cwd);
      const removedAt = projectTabs.findIndex((workspace) => workspace.id === id);
      const neighbours = projectTabs.filter((workspace) => workspace.id !== id);
      const neighbour = neighbours[removedAt - 1] ?? neighbours[0];
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
      const nextId = state.activeWorkspaceId === id
        ? neighbour?.id ?? HOME_WORKSPACE_ID
        : state.activeWorkspaceId;
      // 被关掉的会话不再能被切项目带回来。
      const activeByProject = Object.fromEntries(
        Object.entries(state.activeByProject).filter(([, workspaceId]) => workspaceId !== id),
      );
      set({ workspaces, activeWorkspaceId: nextId, activeByProject });
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
      set({ workspaces, activeWorkspaceId: tab.id, activeByProject: rememberActive(state.activeByProject, tab) });
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
      // 换了范围的会话不该再算作旧项目的「当前会话」；新范围下面再激活时自然记上。
      const activeByProject = Object.fromEntries(
        Object.entries(state.activeByProject).filter(([, workspaceId]) => workspaceId !== id),
      );
      set({ workspaces, activeByProject });
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

    openBrowser: (url, options) => {
      // An agent can name the tab (`browser:open` carries the id the app itself
      // generated), which is what lets a run address the page it asked for
      // instead of whatever happens to be in front. Two rules keep that honest:
      // the same request twice navigates the existing tab instead of adding a
      // second one, and only a real browser path is accepted as a name.
      const asked = options?.path?.trim();
      const existing = asked ? get().browserTabs.find((tab) => tab.path === asked) : undefined;
      if (existing) {
        get().updateBrowser(existing.path, url ? { url } : {});
        get().setBrowserActive(existing.path);
        get().setBrowserOpen(true);
        return existing.path;
      }
      const path = asked && isBrowserPath(asked) ? asked : `browser:${crypto.randomUUID().slice(0, 8)}`;
      // A named tab is the agent's (`browser:open` carries the id the app minted
      // for a run). Marking it is what keeps a link the user clicks from landing
      // on a page that run will close the moment it finishes.
      const tab: BrowserTabInfo = { path, url, ...(asked ? { agent: true as const } : {}) };
      set({
        browserTabs: [...get().browserTabs, tab],
        browserActive: path,
        browserOpen: true,
      });
      return path;
    },

    openLink: (url) => {
      // The user's own page, if the window has one: a link navigates it and
      // brings it forward, instead of leaving a stale page per click behind. A
      // run's tab is never the destination — it is closed when the run ends.
      const own = get().browserTabs.find((tab) => !tab.agent);
      if (own) {
        get().updateBrowser(own.path, { url });
        get().setBrowserActive(own.path);
        get().setBrowserOpen(true);
        return own.path;
      }
      return get().openBrowser(url);
    },

    adoptBrowser: (path, url) => {
      // Exactly one handed-over page: a takeover surface is not a log, so the
      // previous one goes as the new one arrives. Closing it here is what keeps
      // "every run leaves a tab behind" from becoming a tab strip of dead ends.
      for (const stale of get().browserTabs.filter((tab) => tab.handoff && tab.path !== path)) {
        get().closeFile(stale.path);
      }
      const tabs = get().browserTabs;
      const existing = tabs.find((tab) => tab.path === path);
      if (!existing) {
        set({ browserTabs: [...tabs, { path, url: url ?? "", handoff: true as const }], browserActive: path, browserOpen: true });
        return;
      }
      // `agent` has to go, not become false: `openLink` looks for a tab without
      // it, and a link the user clicks must be able to land on this page.
      const { agent: _wasTheRuns, ...rest } = existing;
      set({
        browserTabs: tabs.map((tab) => (tab.path === path ? { ...rest, url: url || tab.url, handoff: true as const } : tab)),
        browserActive: path,
        browserOpen: true,
      });
    },

    updateBrowser: (path, patch) => {
      const tabs = get().browserTabs;
      const tab = tabs.find((item) => item.path === path);
      if (!tab) return;
      const next = { ...tab, ...patch };
      if (next.url === tab.url && next.title === tab.title) return;
      set({ browserTabs: tabs.map((item) => (item.path === path ? next : item)) });
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
      // A browser tab is closed here, not by the pane holding it: the page is the
      // window's. `browser_view_reconcile` sees the shorter tab list and destroys
      // the native view (`use-browser-views.ts`).
      if (isBrowserPath(path)) {
        const tabs = get().browserTabs;
        if (!tabs.some((tab) => tab.path === path)) return;
        const rest = tabs.filter((tab) => tab.path !== path);
        set({
          browserTabs: rest,
          browserActive: get().browserActive === path ? (rest.at(-1)?.path ?? null) : get().browserActive,
          // An empty browser column is nothing to look at: with its last page
          // gone the column goes too (there is nothing left to lose).
          browserOpen: rest.length === 0 ? false : get().browserOpen,
        });
        return;
      }
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
      if (path && isBrowserPath(path)) {
        get().setBrowserActive(path);
        get().setBrowserOpen(true);
        return;
      }
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
      if (!session && !workspace.panes[paneId]) return;
      // 文件面板可以独占工作区；只保留最后一个可见面板。
      const layout = removePane(workspace.layout, paneId);
      if (!layout) return;
      patchActive((current) => {
        const panes = { ...current.panes };
        delete panes[paneId];
        const sessions = { ...current.sessions };
        delete sessions[paneId];
        const connectionId = session && current.connectionId === current.sessions[paneId].connectionId
          ? Object.values(sessions)[0]?.connectionId ?? ""
          : current.connectionId;
        return {
          ...current,
          layout,
          panes,
          sessions,
          connectionId,
          activePane: current.activePane === paneId
            ? (siblingLeafId(current.layout, paneId) ?? firstLeafId(layout))
            : current.activePane,
        };
      });
    },

    restoreHomeSessionPane: () => {
      const state = get();
      const home = state.workspaces.find((workspace) => workspace.id === HOME_WORKSPACE_ID);
      if (!home || home.sessions[CHAT_PANE_ID]) return;
      // 只剩悬挂的文件叶子（panes 已被删空）时直接回到单会话面板，
      // 否则会在首页旁边留一块空的黑面板。
      const hasPanes = Object.keys(home.panes).length > 0;
      set({ workspaces: state.workspaces.map((workspace) => workspace !== home ? workspace : {
        ...home,
        layout: hasPanes ? placeNewPane(home.layout, home.activePane, CHAT_PANE_ID, "bottom") : leaf(CHAT_PANE_ID),
        sessions: { ...home.sessions, [CHAT_PANE_ID]: { connectionId: "" } },
        activePane: CHAT_PANE_ID,
      }) });
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
