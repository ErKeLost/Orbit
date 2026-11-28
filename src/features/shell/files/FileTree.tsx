import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  createDir,
  deletePath,
  listDir,
  renamePath,
  useGitChangedFiles,
  writeTextFile,
  type DirEntry,
  type GitChangedFile,
} from "../../../lib/git";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { MenuItem, MenuSeparator, PointMenu } from "../../../shared/ui/controls";
import { toast } from "../../../shared/ui/toast";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  FilePlus,
  FoldVertical,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash,
} from "../../../shared/ui/icons";
import { ConfirmDialog } from "../ConfirmDialog";
import { FileTypeIcon } from "../FileTypeIcon";
import { useShell } from "../shellStore";
import { useAppearance } from "../../../lib/appearance";

const GIT_STATUS_COLOR: Record<string, string> = {
  M: "text-warning",
  A: "text-diff-add-fg",
  U: "text-diff-add-fg",
  D: "text-diff-del-fg",
};

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

/** Trim trailing slashes so `a/b/` and `a/b` produce the same path. */
function trimSlash(path: string) {
  return path.replace(/\/+$/, "");
}

/** Parent directory of a path, falling back to the workspace root. */
function parentDir(path: string, root: string) {
  const slash = path.lastIndexOf("/");
  const parent = slash > 0 ? path.slice(0, slash) : "";
  return parent.length >= root.length ? parent : root;
}

/** Where "new file/folder" should land for a given selection. */
function createTargetFor(cache: QueryClient, path: string | null, root: string) {
  if (!path || path === root) return root;
  const parent = parentDir(path, root);
  const entries = cache.getQueryData<DirEntry[]>(["dir", parent]);
  return entries?.some(entry => entry.path === path && entry.isDir) ? path : parent;
}

function joinPath(parent: string, name: string) {
  return `${trimSlash(parent)}/${name}`;
}

type EditState =
  | { mode: "create"; parent: string; kind: "file" | "folder" }
  | { mode: "rename"; path: string; kind: "file" | "folder" };

type HeaderIconProps = { label: string; onClick?: () => void; active?: boolean; children: ReactNode };

function HeaderIcon({ label, onClick, active = false, children }: HeaderIconProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md ${
        active ? "bg-selection text-ink-1" : "text-ink-3 hover:bg-fill hover:text-ink-1"
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
  activeFile: string | null;
  activeTrail: ReadonlySet<string>;
  revealRow: (row: HTMLButtonElement) => void;
  statuses: Map<string, string>;
  dirtyDirs: Map<string, string>;
  showIgnored: boolean;
  visible: boolean;
  editing: EditState | null;
  commitEdit: (value: string) => void;
  cancelEdit: () => void;
  onMenu: (entry: DirEntry | null, x: number, y: number) => void;
};

/** Directory tabs and tree branches share the same cached listing and pending request. */
function useDir(path: string, visible: boolean) {
  const listing = useQuery({
    queryKey: ["dir", path],
    queryFn: () => listDir(path),
    enabled: visible,
    staleTime: 5_000,
  });
  return { entries: listing.data, error: listing.error };
}

/**
 * The inline name field for creating and renaming.
 *
 * Enter (or clicking away with a non-empty name) commits, Escape cancels. It is
 * a plain row rather than a dialog so the name is typed where the entry will
 * appear, matching the explorer it lives in.
 */
function EditRow({ depth, isDir, initial, onCommit, onCancel }: { depth: number; isDir: boolean; initial: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const finish = (accept: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = value.trim().replace(/^\/+|\/+$/g, "");
    if (accept && next) onCommit(next);
    else onCancel();
  };
  return (
    <div style={{ paddingLeft: 8 + depth * 12 }} className="flex h-7.5 w-full items-center gap-1 pr-2">
      <span className="grid size-4 shrink-0 place-items-center" />
      <span className="shrink-0">
        <FileTypeIcon name={value || (isDir ? "folder" : "untitled.txt")} isDir={isDir} />
      </span>
      <input
        autoFocus
        spellCheck={false}
        value={value}
        placeholder={isDir ? "文件夹名称" : "文件名称"}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        onFocus={(event) => {
          const input = event.currentTarget;
          const dot = isDir ? -1 : input.value.lastIndexOf(".");
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        }}
        className="h-6 min-w-0 flex-1 rounded-xs border border-accent/60 bg-fill-weak px-1.5 text-ui leading-none text-ink-1 outline-none ring-2 ring-accent/15 placeholder:text-ink-3"
      />
    </div>
  );
}

function TreeChildren({ parent, depth, ctx }: { parent: string; depth: number; ctx: TreeContext }) {
  const { entries, error } = useDir(parent, ctx.visible);
  const shownEntries = ctx.showIgnored ? entries : entries?.filter((entry) => !entry.ignored || ctx.activeTrail.has(entry.path));
  const creating = ctx.editing?.mode === "create" && ctx.editing.parent === parent ? ctx.editing : null;
  const pad = { paddingLeft: 28 + depth * 12 };
  if (error && !entries) return <p className="truncate pr-2 text-xs text-negative" style={pad}>{String(error)}</p>;
  return (
    <>
      {creating ? (
        <EditRow key="__create" depth={depth} isDir={creating.kind === "folder"} initial="" onCommit={ctx.commitEdit} onCancel={ctx.cancelEdit} />
      ) : null}
      {shownEntries?.map((entry) => <TreeNode key={entry.path} entry={entry} depth={depth} ctx={ctx} />)}
      {!creating && shownEntries?.length === 0 ? (
        <p className="pr-2 text-xs text-ink-3" style={pad}>空文件夹</p>
      ) : null}
    </>
  );
}

const TreeNode = memo(function TreeNode({ entry, depth, ctx }: { entry: DirEntry; depth: number; ctx: TreeContext }) {
  const open = entry.isDir && ctx.expanded.has(entry.path);
  const selected = ctx.selected === entry.path;
  const active = ctx.activeFile === entry.path;
  const { revealRow } = ctx;
  const row = useRef<HTMLButtonElement>(null);
  const status = entry.isDir ? ctx.dirtyDirs.get(entry.path) : ctx.statuses.get(entry.path);
  const gitColor = status ? GIT_STATUS_COLOR[status] : undefined;
  const renaming = ctx.editing?.mode === "rename" && ctx.editing.path === entry.path;

  // A nested row may mount several async directory reads after activation.
  useEffect(() => {
    if (active && !renaming && row.current) revealRow(row.current);
  }, [active, renaming, revealRow]);

  if (renaming) {
    return (
      <div>
        <EditRow depth={depth} isDir={entry.isDir} initial={entry.name} onCommit={ctx.commitEdit} onCancel={ctx.cancelEdit} />
      </div>
    );
  }

  return (
    <div>
      <button
        ref={row}
        type="button"
        role="treeitem"
        title={entry.path}
        aria-expanded={entry.isDir ? open : undefined}
        aria-selected={selected}
        aria-current={active || undefined}
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
        className={`flex h-7.5 w-full cursor-default items-center gap-1 pr-2 text-left text-base leading-none ${
          active ? "bg-accent/15 font-medium text-ink-1 shadow-[inset_2px_0_0_var(--color-accent)]"
            : selected ? "bg-selection text-ink-1" : "text-ink-1 hover:bg-fill"
        }`}
      >
        <span className="grid size-4 shrink-0 place-items-center text-ink-3">
          {entry.isDir ? (open ? <ChevronDown className="size-3.5" strokeWidth={1.75} /> : <ChevronRight className="size-3.5" strokeWidth={1.75} />) : null}
        </span>
        <span className="shrink-0">
          <FileTypeIcon name={entry.name} isDir={entry.isDir} isOpen={open} />
        </span>
        <span className={`min-w-0 truncate leading-label ${entry.ignored ? "italic text-ink-3" : (gitColor ?? "")}`}>{entry.name}</span>
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

export function FileTree({ cwd, rootLabel, activeFile, visible = true }: {
  cwd: string;
  rootLabel?: string;
  activeFile?: string | null;
  visible?: boolean;
}) {
  const [expanded, setExpanded] = useState(() => loadExpanded(cwd));
  const [selected, setSelected] = useState<string | null>(null);
  const showExcluded = useAppearance((state) => state.showExcludedFiles);
  const [showIgnored, setShowIgnored] = useState(showExcluded);
  useEffect(() => setShowIgnored(showExcluded), [showExcluded]);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<EditState | null>(null);
  const [menu, setMenu] = useState<{ target: DirEntry | null; x: number; y: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DirEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement>(null);
  const attachScroller = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    lockOverscroll(element);
  }, [lockOverscroll]);
  const revealRow = useCallback((row: HTMLButtonElement) => {
    const viewport = scroller.current;
    if (!visible || !viewport) return;
    const { top, bottom } = row.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    if (top < bounds.top) viewport.scrollTop += top - bounds.top;
    else if (bottom > bounds.bottom) viewport.scrollTop += bottom - bounds.bottom;
  }, [visible]);
  const root = trimSlash(cwd);
  const path = activeFile ? trimSlash(activeFile.replaceAll("\\", "/")) : "";
  const activePath = path.startsWith(`${root}/`) ? path : null;
  const activeTrail = useMemo(() => {
    const trail = new Set<string>();
    if (!activePath) return trail;
    for (let path = activePath; path.length > root.length; path = path.slice(0, path.lastIndexOf("/"))) {
      trail.add(path);
    }
    return trail;
  }, [activePath, root]);
  const changed = useGitChangedFiles(cwd, visible).data;
  const { statuses, dirtyDirs } = useMemo(() => statusMaps(cwd, changed), [cwd, changed]);
  const name = rootLabel ?? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  const rootOpen = expanded.has(cwd);

  useEffect(() => {
    setExpanded(loadExpanded(cwd));
    setSelected(null);
    setEditing(null);
  }, [cwd]);

  useEffect(() => {
    if (!visible) return;
    setSelected(activePath);
    if (!activePath) return;
    setExpanded((current) => {
      const next = new Set(current).add(cwd);
      for (const ancestor of activeTrail) {
        if (ancestor !== activePath) next.add(ancestor);
      }
      return next.size === current.size ? current : next;
    });
  }, [activePath, activeTrail, cwd, visible]);

  const refreshTree = useCallback(() => {
    const scope = trimSlash(cwd);
    void queryClient.invalidateQueries({
      queryKey: ["dir"],
      predicate: ({ queryKey: [, path] }) => typeof path === "string" && (trimSlash(path) === scope || path.startsWith(`${scope}/`)),
    });
  }, [cwd, queryClient]);

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

  const expand = useCallback(
    (path: string) =>
      setExpanded((current) => {
        if (current.has(path)) return current;
        const next = new Set(current);
        next.add(path);
        saveExpanded(cwd, next);
        return next;
      }),
    [cwd],
  );

  const beginCreate = useCallback(
    (parent: string, kind: "file" | "folder") => {
      setMenu(null);
      expand(parent);
      setSelected(parent);
      setEditing({ mode: "create", parent: trimSlash(parent), kind });
    },
    [expand],
  );

  const beginRename = useCallback((entry: DirEntry) => {
    setMenu(null);
    setEditing({ mode: "rename", path: entry.path, kind: entry.isDir ? "folder" : "file" });
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const commitEdit = useCallback(
    (value: string) => {
      const current = editing;
      setEditing(null);
      if (!current) return;
      void (async () => {
        try {
          if (current.mode === "create") {
            const target = joinPath(current.parent, value);
            if (current.kind === "folder") {
              await createDir(target);
              expand(target);
            } else {
              await writeTextFile(target, "");
              useShell.getState().openFile(target, { pin: true });
            }
            setSelected(target);
          } else {
            const target = joinPath(parentDir(current.path, cwd), value);
            if (target !== current.path) await renamePath(current.path, target);
            setSelected(target);
          }
          refreshTree();
        } catch (error) {
          toast.error(`${current.mode === "create" ? "新建" : "重命名"}失败：${String(error)}`);
        }
      })();
    },
    [editing, cwd, expand, refreshTree],
  );

  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete;
    if (!entry) return;
    setDeleting(true);
    try {
      await deletePath(entry.path);
      // Close any editor tab that pointed at the removed path (or inside it).
      const { workspaces, activeWorkspaceId } = useShell.getState();
      const workspace = workspaces.find((item) => item.id === activeWorkspaceId);
      const openPaths = Object.values(workspace?.panes ?? {}).flatMap((pane) => pane.files.map((file) => file.path));
      const prefix = entry.isDir ? `${trimSlash(entry.path)}/` : null;
      for (const path of openPaths) {
        if (path === entry.path || (prefix && path.startsWith(prefix))) useShell.getState().closeFile(path);
      }
      setSelected((current) => (current === entry.path || (prefix && current?.startsWith(prefix)) ? null : current));
      toast.success(`已删除「${entry.name}」`, { showTimestamp: false });
      refreshTree();
    } catch (error) {
      toast.error(`删除失败：${String(error)}`);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, refreshTree]);

  const ctx = useMemo<TreeContext>(
    () => ({
      expanded,
      toggle,
      selected,
      select: setSelected,
      activeFile: activePath,
      activeTrail,
      revealRow,
      statuses,
      dirtyDirs,
      showIgnored,
      visible,
      editing,
      commitEdit,
      cancelEdit,
      onMenu: (entry, x, y) => setMenu({ target: entry, x, y }),
    }),
    [expanded, toggle, selected, activePath, activeTrail, revealRow, statuses, dirtyDirs, showIgnored, visible, editing, commitEdit, cancelEdit],
  );

  const createParent = menu ? createTargetFor(queryClient, menu.target?.path ?? null, cwd) : cwd;

  return (
    <div className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex h-9 shrink-0 items-center gap-px overflow-visible border-b border-stroke px-2">
        <HeaderIcon label="新建文件" onClick={() => beginCreate(createTargetFor(queryClient, selected, cwd), "file")}>
          <FilePlus className="size-3.5" strokeWidth={1.75} />
        </HeaderIcon>
        <HeaderIcon label="新建文件夹" onClick={() => beginCreate(createTargetFor(queryClient, selected, cwd), "folder")}>
          <FolderPlus className="size-3.5" strokeWidth={1.75} />
        </HeaderIcon>
        <HeaderIcon label="刷新" onClick={refreshTree}>
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
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ target: null, x: event.clientX, y: event.clientY });
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1 pl-2 text-left"
        >
          <span className="grid size-4 shrink-0 place-items-center text-ink-3">
            {rootOpen ? <ChevronDown className="size-3.5" strokeWidth={1.75} /> : <ChevronRight className="size-3.5" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 truncate text-2xs font-semibold uppercase tracking-[0.08em] text-ink-3">{name}</span>
        </button>
      </div>
      <div
        ref={attachScroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none"
        onContextMenu={(event) => {
          // Rows stop propagation, so anything that reaches here is empty space.
          event.preventDefault();
          setMenu({ target: null, x: event.clientX, y: event.clientY });
        }}
      >
        {rootOpen ? (
          <div role="tree" aria-label={`${name} 文件`}>
            <TreeChildren parent={cwd} depth={0} ctx={ctx} />
          </div>
        ) : null}
      </div>

      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="文件操作" onClose={() => setMenu(null)}>
          {menu.target && !menu.target.isDir ? (
            <MenuItem onClick={() => { useShell.getState().openFile(menu.target!.path, { pin: true }); setMenu(null); }}>打开</MenuItem>
          ) : null}
          {menu.target && !menu.target.isDir ? <MenuSeparator /> : null}
          <MenuItem icon={<FilePlus strokeWidth={1.75} />} onClick={() => beginCreate(createParent, "file")}>新建文件</MenuItem>
          <MenuItem icon={<FolderPlus strokeWidth={1.75} />} onClick={() => beginCreate(createParent, "folder")}>新建文件夹</MenuItem>
          {menu.target ? <MenuSeparator /> : null}
          {menu.target ? (
            <MenuItem icon={<Pencil strokeWidth={1.75} />} onClick={() => beginRename(menu.target!)}>重命名</MenuItem>
          ) : null}
          {menu.target ? (
            <MenuItem icon={<Trash strokeWidth={1.75} />} danger onClick={() => { setPendingDelete(menu.target); setMenu(null); }}>删除</MenuItem>
          ) : null}
          <MenuItem icon={<FolderOpen strokeWidth={1.75} />} onClick={() => { void revealItemInDir(menu.target?.path ?? cwd).catch(() => undefined); setMenu(null); }}>
            在 Finder 中显示
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Copy strokeWidth={1.75} />} onClick={() => { void navigator.clipboard.writeText(menu.target?.path ?? cwd); setMenu(null); }}>复制路径</MenuItem>
          <MenuItem
            onClick={() => {
              const path = menu.target?.path ?? cwd;
              void navigator.clipboard.writeText(path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\//, "") : path);
              setMenu(null);
            }}
          >
            复制相对路径
          </MenuItem>
        </PointMenu>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.isDir ? "删除文件夹" : "删除文件"}
          confirmLabel="删除"
          danger
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        >
          确定要删除「{pendingDelete.name}」吗？{pendingDelete.isDir ? "文件夹内的所有内容都会一并删除，" : ""}此操作不可撤销。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
