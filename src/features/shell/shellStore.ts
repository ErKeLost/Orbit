import { create } from "zustand";
import {
  firstLeafId,
  leaf,
  movePane as movePaneLayout,
  placeNewPane,
  removePane,
  setSplitRatio as setSplitRatioLayout,
  siblingLeafId,
  type LayoutNode,
  type PaneEdge,
} from "./paneLayout";

export type { LayoutNode, LayoutSash, PaneEdge, SplitDir } from "./paneLayout";

/**
 * Layout state for the MonoCode-style shell. Pi state (connections,
 * transcripts, sessions) stays in `lib/store`; this owns the pane tree, the
 * rails and which file tabs sit in each editor pane.
 *
 * The tree is MonoCode's (`features/workspace/model/layout.ts`): leaves are
 * "chat" (the session pane) or editor panes ("editor:1", …), and each editor
 * pane keeps its own tab list.
 */
export type SidebarTab = "sessions" | "files" | "changes";
export type CollapsedRailMode = "compact" | "hidden";
export type DockPosition = "bottom" | "top" | "left" | "right";
export type OpenFile = { path: string; name: string; preview: boolean };
export type PaneState = { files: OpenFile[]; activeFile: string | null };

/** The session pane's leaf id; editor panes use `editor:<n>`. */
export const CHAT_PANE_ID = "chat";

const PROJECT_RAIL_KEY = "orbit.shell.projectRail";
const SESSION_SIDEBAR_KEY = "orbit.shell.sessionSidebar";
const SIDEBAR_TAB_KEY = "orbit.shell.sidebarTab";
const PROJECT_RAIL_WIDTH_KEY = "orbit.shell.projectRailWidth";
const SESSION_SIDEBAR_WIDTH_KEY = "orbit.shell.sessionSidebarWidth";
const WORKSPACE_KEY = "orbit.shell.workspace";

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

type Workspace = { layout: LayoutNode; panes: Record<string, PaneState>; activePane: string };

const DEFAULT_WORKSPACE: Workspace = {
  layout: leaf(CHAT_PANE_ID),
  panes: {},
  activePane: CHAT_PANE_ID,
};

/** A stored tree is only trusted when it still describes exactly these panes. */
function readWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(WORKSPACE_KEY);
    if (!raw) return DEFAULT_WORKSPACE;
    const parsed = JSON.parse(raw) as Partial<Workspace>;
    const layout = parsed.layout;
    const panes = parsed.panes;
    if (!layout || typeof layout !== "object" || !panes || typeof panes !== "object") return DEFAULT_WORKSPACE;
    const valid = new Set<string>([CHAT_PANE_ID, ...Object.keys(panes)]);
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
    if (!walk(layout)) return DEFAULT_WORKSPACE;
    if (!seen.includes(CHAT_PANE_ID)) return DEFAULT_WORKSPACE;
    const activePane = typeof parsed.activePane === "string" && seen.includes(parsed.activePane)
      ? parsed.activePane
      : firstLeafId(layout);
    return { layout, panes, activePane };
  } catch {
    return DEFAULT_WORKSPACE;
  }
}

type ShellState = Workspace & {
  projectRailOpen: boolean;
  sessionSidebarOpen: boolean;
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
  focusPane: (paneId: string) => void;
  /** Open a file in the focused editor pane, splitting one off when there is none. */
  openFile: (path: string, options?: { pin?: boolean; pane?: string }) => void;
  pinFile: (path: string, pane?: string) => void;
  closeFile: (path: string, pane?: string) => void;
  focusFile: (path: string | null, pane?: string) => void;
  reorderFiles: (paneId: string, ids: string[]) => void;
  /** MonoCode `movePane`: drag a pane onto another pane's edge. */
  movePane: (fromId: string, toId: string, edge: PaneEdge) => void;
  /** Drag a file tab into another pane. */
  moveFileToPane: (path: string, fromPane: string, toPane: string, index?: number) => void;
  /** Drag a file tab onto a pane edge: open it in a brand new pane there. */
  openFileInNewPane: (path: string, targetPane: string, edge: PaneEdge) => void;
  closePane: (paneId: string) => void;
  setSplitRatio: (splitId: string, index: number, ratio: number) => void;
};

const stored = typeof window === "undefined" ? DEFAULT_WORKSPACE : readWorkspace();

function persist(state: Workspace) {
  write(WORKSPACE_KEY, JSON.stringify({ layout: state.layout, panes: state.panes, activePane: state.activePane }));
}

function findFile(state: Workspace, path: string): { paneId: string; index: number } | null {
  for (const [paneId, pane] of Object.entries(state.panes)) {
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
function detachFile(state: Workspace, path: string): Workspace | null {
  const found = findFile(state, path);
  if (!found) return null;
  const pane = state.panes[found.paneId];
  const files = pane.files.filter((file) => file.path !== path);
  const activeFile = pane.activeFile === path ? (files.at(-1)?.path ?? null) : pane.activeFile;
  if (files.length > 0) {
    return { ...state, panes: { ...state.panes, [found.paneId]: { files, activeFile } } };
  }
  const panes = { ...state.panes };
  delete panes[found.paneId];
  const layout = removePane(state.layout, found.paneId) ?? state.layout;
  const activePane = state.activePane === found.paneId
    ? (siblingLeafId(state.layout, found.paneId) ?? firstLeafId(layout))
    : state.activePane;
  return { layout, panes, activePane };
}

export const useShell = create<ShellState>((set, get) => ({
  ...stored,
  projectRailOpen: readBool(PROJECT_RAIL_KEY, true),
  sessionSidebarOpen: readBool(SESSION_SIDEBAR_KEY, true),
  sidebarTab: (() => {
    try {
      const value = localStorage.getItem(SIDEBAR_TAB_KEY);
      return value === "files" || value === "changes" ? value : "changes";
    } catch { return "changes"; }
  })(),
  terminalPosition: (() => {
    const raw = localStorage.getItem("orbit.terminal.position");
    return raw === "top" || raw === "left" || raw === "right" ? raw : "bottom";
  })() as DockPosition,
  setTerminalPosition: (position) => {
    write("orbit.terminal.position", position);
    set({ terminalPosition: position });
  },
  terminalSize: readNumber("orbit.terminal.size", 220),
  terminalOpen: (() => { try { return localStorage.getItem("orbit.terminal.open") === "true"; } catch { return false; } })(),
  setTerminalSize: (terminalSize) => { write("orbit.terminal.size", String(terminalSize)); set({ terminalSize }); },
  setTerminalOpen: (terminalOpen) => { write("orbit.terminal.open", String(terminalOpen)); set({ terminalOpen }); },
  collapsedRailMode: (localStorage.getItem("orbit.shell.collapsedRail") === "hidden" ? "hidden" : "compact") as CollapsedRailMode,
  setCollapsedRailMode: (mode) => { write("orbit.shell.collapsedRail", mode); set({ collapsedRailMode: mode }); },
  projectRailWidth: readNumber(PROJECT_RAIL_WIDTH_KEY, 240),
  sessionSidebarWidth: readNumber(SESSION_SIDEBAR_WIDTH_KEY, 272),
  setProjectRailOpen: (open) => { write(PROJECT_RAIL_KEY, String(open)); set({ projectRailOpen: open }); },
  setSessionSidebarOpen: (open) => { write(SESSION_SIDEBAR_KEY, String(open)); set({ sessionSidebarOpen: open }); },
  setSidebarTab: (tab) => { write(SIDEBAR_TAB_KEY, tab); set({ sidebarTab: tab }); },
  setProjectRailWidth: (width) => { write(PROJECT_RAIL_WIDTH_KEY, String(width)); set({ projectRailWidth: width }); },
  setSessionSidebarWidth: (width) => { write(SESSION_SIDEBAR_WIDTH_KEY, String(width)); set({ sessionSidebarWidth: width }); },

  focusPane: (activePane) => {
    if (!get().panes[activePane] && activePane !== CHAT_PANE_ID) return;
    set({ activePane });
  },

  openFile: (path, options) => {
    const state = get();
    const found = findFile(state, path);
    if (found) {
      const pane = state.panes[found.paneId];
      const files = options?.pin
        ? pane.files.map((file) => (file.path === path ? { ...file, preview: false } : file))
        : pane.files;
      const next = { ...state, panes: { ...state.panes, [found.paneId]: { files, activeFile: path } }, activePane: found.paneId };
      set(next);
      persist(next);
      return;
    }
    const requested = options?.pane && state.panes[options.pane] ? options.pane : null;
    const target = requested ?? (state.panes[state.activePane] ? state.activePane : Object.keys(state.panes)[0] ?? null);
    const entry: OpenFile = { path, name: fileName(path), preview: !options?.pin };
    if (target) {
      const pane = state.panes[target];
      const files = options?.pin ? pane.files : pane.files.filter((file) => !file.preview);
      const next = { ...state, panes: { ...state.panes, [target]: { files: [...files, entry], activeFile: path } }, activePane: target };
      set(next);
      persist(next);
      return;
    }
    // No editor pane yet: MonoCode opens one beside the focused pane.
    const paneId = nextEditorPaneId(state.panes);
    const next: Workspace = {
      layout: placeNewPane(state.layout, state.activePane, paneId, "right"),
      panes: { ...state.panes, [paneId]: { files: [entry], activeFile: path } },
      activePane: paneId,
    };
    set(next);
    persist(next);
  },

  pinFile: (path, paneId) => {
    const state = get();
    const target = paneId ?? findFile(state, path)?.paneId;
    if (!target || !state.panes[target]) return;
    const pane = state.panes[target];
    const next = {
      ...state,
      panes: { ...state.panes, [target]: { ...pane, files: pane.files.map((file) => (file.path === path ? { ...file, preview: false } : file)) } },
    };
    set(next);
    persist(next);
  },

  closeFile: (path, paneId) => {
    const state = get();
    const target = paneId && state.panes[paneId] ? paneId : findFile(state, path)?.paneId;
    if (!target) return;
    const pane = state.panes[target];
    const files = pane.files.filter((file) => file.path !== path);
    if (files.length > 0) {
      const next = {
        ...state,
        panes: { ...state.panes, [target]: { files, activeFile: pane.activeFile === path ? (files.at(-1)?.path ?? null) : pane.activeFile } },
      };
      set(next);
      persist(next);
      return;
    }
    // Last tab of an editor pane: the pane itself goes away (MonoCode `closeLeaf`).
    const panes = { ...state.panes };
    delete panes[target];
    const layout = removePane(state.layout, target) ?? state.layout;
    const next: Workspace = {
      layout,
      panes,
      activePane: state.activePane === target
        ? (siblingLeafId(state.layout, target) ?? firstLeafId(layout))
        : state.activePane,
    };
    set(next);
    persist(next);
  },

  focusFile: (path, paneId) => {
    const state = get();
    const target = paneId && state.panes[paneId] ? paneId : (path ? findFile(state, path)?.paneId : state.activePane);
    if (!target || !state.panes[target]) {
      if (target === CHAT_PANE_ID) set({ activePane: CHAT_PANE_ID });
      return;
    }
    const pane = state.panes[target];
    const next = { ...state, panes: { ...state.panes, [target]: { ...pane, activeFile: path } }, activePane: target };
    set(next);
    persist(next);
  },

  reorderFiles: (paneId, ids) => {
    const state = get();
    const pane = state.panes[paneId];
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
    const next = { ...state, panes: { ...state.panes, [paneId]: { ...pane, files } } };
    set(next);
    persist(next);
  },

  movePane: (fromId, toId, edge) => {
    const state = get();
    const layout = movePaneLayout(state.layout, fromId, toId, edge);
    const next = { ...state, layout, activePane: fromId };
    set(next);
    persist(next);
  },

  moveFileToPane: (path, fromPane, toPane, index) => {
    const state = get();
    if (fromPane === toPane) return;
    const target = state.panes[toPane];
    const file = state.panes[fromPane]?.files.find((item) => item.path === path);
    if (!target || !file) return;
    const detached = detachFile(state, path);
    if (!detached) return;
    // `detachFile` may have removed the source pane from the tree.
    const pane = detached.panes[toPane] ?? target;
    const files = [...pane.files];
    files.splice(index == null ? files.length : Math.max(0, Math.min(files.length, index)), 0, file);
    const next = {
      ...detached,
      panes: { ...detached.panes, [toPane]: { files, activeFile: path } },
      activePane: toPane,
    };
    set(next);
    persist(next);
  },

  openFileInNewPane: (path, targetPane, edge) => {
    const state = get();
    const entry = state.panes[findFile(state, path)?.paneId ?? ""]?.files.find((item) => item.path === path);
    const detached = detachFile(state, path) ?? state;
    const paneId = nextEditorPaneId(detached.panes);
    const next: Workspace = {
      layout: placeNewPane(detached.layout, targetPane, paneId, edge),
      panes: {
        ...detached.panes,
        [paneId]: {
          files: [entry ?? { path, name: fileName(path), preview: false }],
          activeFile: path,
        },
      },
      activePane: paneId,
    };
    set(next);
    persist(next);
  },

  closePane: (paneId) => {
    const state = get();
    if (paneId === CHAT_PANE_ID || !state.panes[paneId]) return;
    const panes = { ...state.panes };
    delete panes[paneId];
    const layout = removePane(state.layout, paneId) ?? state.layout;
    const next: Workspace = {
      layout,
      panes,
      activePane: state.activePane === paneId
        ? (siblingLeafId(state.layout, paneId) ?? firstLeafId(layout))
        : state.activePane,
    };
    set(next);
    persist(next);
  },

  setSplitRatio: (splitId, index, ratio) => {
    const state = get();
    const next = { ...state, layout: setSplitRatioLayout(state.layout, splitId, index, ratio) };
    set(next);
    persist(next);
  },
}));
