import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { listDir, useGitChangedFiles, type DirEntry, type GitChangedFile } from "../../lib/git";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { MenuItem, MenuSeparator, PointMenu } from "../../shared/ui/controls";
import { ChevronDown, ChevronRight, Copy, Eye, FoldVertical, FolderOpen, RefreshCw } from "../../shared/ui/icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { useShell } from "./shellStore";
import { useAppearance } from "../../lib/appearance";

const GIT_STATUS_COLOR: Record<string, string> = {
  M: "text-amber-400",
  A: "text-diff-add-fg",
  U: "text-diff-add-fg",
  D: "text-diff-del-fg",
};

const dirCache = new Map<string, DirEntry[]>();
const EXPANDED_KEY = "orbit.explorer.expanded.v1";

function loadExpanded(root: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}") as Record<string, string[]>;
    return new Set(all[root] ?? [root]);
  } catch {
    return new Set([root]);
  }
}

function saveExpanded(root: string, expanded: Set<string>) {
  try {
    const all = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "{}") as Record<string, string[]>;
    all[root] = [...expanded].slice(0, 400);
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(all));
  } catch { /* storage unavailable */ }
}

function HeaderIcon({ label, onClick, active = false, children }: { label: string; onClick?: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}

type TreeContext = {
  expanded: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  select: (path: string) => void;
  statuses: Map<string, string>;
  dirtyDirs: Map<string, string>;
  showIgnored: boolean;
  revision: number;
  onMenu: (entry: DirEntry, x: number, y: number) => void;
};

function useDir(path: string, open: boolean, revision: number) {
  const [entries, setEntries] = useState<DirEntry[] | null>(() => dirCache.get(path) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listDir(path).then(
      (next) => {
        dirCache.set(path, next);
        if (!cancelled) {
          setEntries(next);
          setError(null);
        }
      },
      (reason: unknown) => {
        if (!cancelled) setError(String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, open, revision]);
  return { entries, error };
}

function TreeChildren({ parent, depth, ctx }: { parent: string; depth: number; ctx: TreeContext }) {
  const { entries, error } = useDir(parent, true, ctx.revision);
  const visible = ctx.showIgnored ? entries : entries?.filter((entry) => !entry.ignored);
  const pad = { paddingLeft: 28 + depth * 12 };
  if (error) return <p className="truncate pr-2 text-[12px] text-red-400" style={pad}>{error}</p>;
  if (!visible) return null;
  if (visible.length === 0) return <p className="pr-2 text-[12px] text-content/50" style={pad}>空文件夹</p>;
  return (
    <>
      {visible.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={depth} ctx={ctx} />
      ))}
    </>
  );
}

const TreeNode = memo(function TreeNode({ entry, depth, ctx }: { entry: DirEntry; depth: number; ctx: TreeContext }) {
  const open = entry.isDir && ctx.expanded.has(entry.path);
  const selected = ctx.selected === entry.path;
  const status = entry.isDir ? ctx.dirtyDirs.get(entry.path) : ctx.statuses.get(entry.path);
  const gitColor = status ? GIT_STATUS_COLOR[status] : undefined;
  return (
    <div>
      <button
        type="button"
        role="treeitem"
        title={entry.path}
        aria-expanded={entry.isDir ? open : undefined}
        onClick={() => {
          ctx.select(entry.path);
          if (entry.isDir) ctx.toggle(entry.path);
          else useShell.getState().openFile(entry.path);
        }}
        onDoubleClick={() => {
          if (!entry.isDir) useShell.getState().openFile(entry.path, { pin: true });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          ctx.select(entry.path);
          ctx.onMenu(entry, event.clientX, event.clientY);
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`flex h-7.5 w-full cursor-default items-center gap-1 pr-2 text-left text-[14px] leading-none ${
          selected ? "bg-selection text-content" : "text-content hover:bg-content/5"
        }`}
      >
        <span className="grid size-4 shrink-0 place-items-center text-content/50">
          {entry.isDir ? (open ? <ChevronDown className="size-3.5" strokeWidth={1.75} /> : <ChevronRight className="size-3.5" strokeWidth={1.75} />) : null}
        </span>
        <span className="shrink-0">
          <FileTypeIcon name={entry.name} isDir={entry.isDir} isOpen={open} />
        </span>
        <span className={`min-w-0 truncate leading-label ${entry.ignored ? "italic text-content/50" : (gitColor ?? "")}`}>{entry.name}</span>
      </button>
      {open ? <TreeChildren parent={entry.path} depth={depth + 1} ctx={ctx} /> : null}
    </div>
  );
});

function statusMaps(root: string, files: GitChangedFile[] | undefined) {
  const statuses = new Map<string, string>();
  const dirtyDirs = new Map<string, string>();
  const base = root.replace(/\/+$/, "");
  for (const file of files ?? []) {
    const absolute = `${base}/${file.path}`;
    statuses.set(absolute, file.status);
    // Folders take the color of what changed inside, like Orbit/VS Code.
    let dir = absolute.slice(0, absolute.lastIndexOf("/"));
    while (dir.length > base.length) {
      if (!dirtyDirs.has(dir) || file.status === "M") dirtyDirs.set(dir, file.status === "D" ? "M" : file.status);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return { statuses, dirtyDirs };
}

export function FileTree({ cwd, rootLabel }: { cwd: string; rootLabel?: string }) {
  const [expanded, setExpanded] = useState(() => loadExpanded(cwd));
  const [selected, setSelected] = useState<string | null>(null);
  const showExcluded = useAppearance((state) => state.showExcludedFiles);
  const [showIgnored, setShowIgnored] = useState(showExcluded);
  useEffect(() => setShowIgnored(showExcluded), [showExcluded]);
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<{ entry: DirEntry; x: number; y: number } | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const changed = useGitChangedFiles(cwd).data;
  const { statuses, dirtyDirs } = useMemo(() => statusMaps(cwd, changed), [cwd, changed]);
  const name = rootLabel ?? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  const rootOpen = expanded.has(cwd);

  useEffect(() => {
    setExpanded(loadExpanded(cwd));
    setSelected(null);
  }, [cwd]);

  const toggle = useCallback(
    (path: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        saveExpanded(cwd, next);
        return next;
      }),
    [cwd],
  );

  const ctx = useMemo<TreeContext>(
    () => ({
      expanded,
      toggle,
      selected,
      select: setSelected,
      statuses,
      dirtyDirs,
      showIgnored,
      revision,
      onMenu: (entry, x, y) => setMenu({ entry, x, y }),
    }),
    [expanded, toggle, selected, statuses, dirtyDirs, showIgnored, revision],
  );

  return (
    <div className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex h-9 shrink-0 items-center gap-px overflow-visible border-b border-stroke px-2">
        <HeaderIcon label="刷新" onClick={() => { dirCache.clear(); setRevision((value) => value + 1); }}>
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        </HeaderIcon>
        <HeaderIcon label={showIgnored ? "隐藏忽略的文件" : "显示忽略的文件"} active={!showIgnored} onClick={() => setShowIgnored((value) => !value)}>
          <Eye className="size-3.5" strokeWidth={1.75} />
        </HeaderIcon>
        <HeaderIcon
          label="全部折叠"
          onClick={() => {
            const next = new Set([cwd]);
            saveExpanded(cwd, next);
            setExpanded(next);
          }}
        >
          <FoldVertical className="size-3.5" strokeWidth={1.75} />
        </HeaderIcon>
        <HeaderIcon label="在访达中显示" onClick={() => void revealItemInDir(selected ?? cwd).catch(() => undefined)}>
          <FolderOpen className="size-3.5" strokeWidth={1.75} />
        </HeaderIcon>
      </div>
      <div className="flex h-8 shrink-0 items-center">
        <button
          type="button"
          aria-expanded={rootOpen}
          title={cwd}
          onClick={() => toggle(cwd)}
          className="flex h-full min-w-0 flex-1 items-center gap-1 pl-2 text-left"
        >
          <span className="grid size-4 shrink-0 place-items-center text-content/50">
            {rootOpen ? <ChevronDown className="size-3.5" strokeWidth={1.75} /> : <ChevronRight className="size-3.5" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-content/50">{name}</span>
        </button>
      </div>
      <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {rootOpen ? (
          <div role="tree" aria-label={`${name} 文件`}>
            <TreeChildren parent={cwd} depth={0} ctx={ctx} />
          </div>
        ) : null}
      </div>
      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="文件操作" onClose={() => setMenu(null)}>
          {!menu.entry.isDir ? (
            <MenuItem onClick={() => { useShell.getState().openFile(menu.entry.path, { pin: true }); setMenu(null); }}>打开</MenuItem>
          ) : null}
          <MenuItem icon={<FolderOpen strokeWidth={1.75} />} onClick={() => { void revealItemInDir(menu.entry.path).catch(() => undefined); setMenu(null); }}>
            在 Finder 中显示
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Copy strokeWidth={1.75} />} onClick={() => { void navigator.clipboard.writeText(menu.entry.path); setMenu(null); }}>复制路径</MenuItem>
          <MenuItem
            onClick={() => {
              void navigator.clipboard.writeText(menu.entry.path.startsWith(cwd) ? menu.entry.path.slice(cwd.length).replace(/^\//, "") : menu.entry.path);
              setMenu(null);
            }}
          >
            复制相对路径
          </MenuItem>
        </PointMenu>
      ) : null}
    </div>
  );
}
