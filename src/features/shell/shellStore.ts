import { create } from "zustand";

/**
 * Layout state for the MonoCode-style shell. Pi state (connections,
 * transcripts, sessions) stays in `lib/store`; this only knows which rails
 * are open, which sidebar tab is showing and which file tabs are open.
 */
export type SidebarTab = "sessions" | "files" | "changes";
export type CollapsedRailMode = "compact" | "hidden";
export type DockPosition = "bottom" | "top" | "left" | "right";
export type OpenFile = { path: string; name: string; preview: boolean };

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
  /** File tabs open beside the chat; at most one preview (italic) tab. */
  files: OpenFile[];
  activeFile: string | null;
  setProjectRailOpen: (open: boolean) => void;
  setSessionSidebarOpen: (open: boolean) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setProjectRailWidth: (width: number) => void;
  setSessionSidebarWidth: (width: number) => void;
  openFile: (path: string, options?: { pin?: boolean }) => void;
  pinFile: (path: string) => void;
  closeFile: (path: string) => void;
  focusFile: (path: string | null) => void;
};

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export const useShell = create<ShellState>((set, get) => ({
  projectRailOpen: readBool(PROJECT_RAIL_KEY, true),
  sessionSidebarOpen: readBool(SESSION_SIDEBAR_KEY, true),
  sidebarTab: (() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_TAB_KEY);
      return stored === "files" || stored === "changes" ? stored : "changes";
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
  files: [],
  activeFile: null,
  setProjectRailOpen: (open) => { write(PROJECT_RAIL_KEY, String(open)); set({ projectRailOpen: open }); },
  setSessionSidebarOpen: (open) => { write(SESSION_SIDEBAR_KEY, String(open)); set({ sessionSidebarOpen: open }); },
  setSidebarTab: (tab) => { write(SIDEBAR_TAB_KEY, tab); set({ sidebarTab: tab }); },
  setProjectRailWidth: (width) => { write(PROJECT_RAIL_WIDTH_KEY, String(width)); set({ projectRailWidth: width }); },
  setSessionSidebarWidth: (width) => { write(SESSION_SIDEBAR_WIDTH_KEY, String(width)); set({ sessionSidebarWidth: width }); },
  openFile: (path, options) => {
    const { files } = get();
    const existing = files.find((file) => file.path === path);
    if (existing) {
      set({
        activeFile: path,
        files: options?.pin ? files.map((file) => (file.path === path ? { ...file, preview: false } : file)) : files,
      });
      return;
    }
    // Like MonoCode, a single click replaces the current preview tab.
    const kept = options?.pin ? files : files.filter((file) => !file.preview);
    set({ files: [...kept, { path, name: fileName(path), preview: !options?.pin }], activeFile: path });
  },
  pinFile: (path) => set((state) => ({ files: state.files.map((file) => (file.path === path ? { ...file, preview: false } : file)) })),
  closeFile: (path) =>
    set((state) => {
      const files = state.files.filter((file) => file.path !== path);
      return { files, activeFile: state.activeFile === path ? (files.at(-1)?.path ?? null) : state.activeFile };
    }),
  focusFile: (path) => set({ activeFile: path }),
}));
