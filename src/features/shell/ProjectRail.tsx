import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspace, type Panel } from "../../lib/store";
import { mergeProjects, projectExtraRoots, projectRoots, useProjects, type Project } from "../../lib/projects";
import { connect, desktopRuntime, forgetProject, report, setSessionRoots } from "../../lib/rpc";
import { installDesktopUpdate, useDesktopUpdate } from "../../lib/desktop-update";
import { useGitDiffStats } from "../../lib/git";
import { useAnimatedReorder } from "../../shared/hooks/useAnimatedReorder";
import { useDragResize } from "../../shared/hooks/useDragResize";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { Popover } from "../../shared/ui/Popover";
import { Shimmer } from "../../shared/ui/Shimmer";
import { MenuItem, MenuSeparator, PointMenu } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";
import {
  Inbox as InboxIcon,
  ArrowDownCircle,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Loader,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  SmartPhone,
  File,
  Trash2 as Trash,
  Zap,
  type IconComponent,
} from "../../shared/ui/icons";
import { DevModeSlot, DiffStat, IS_MAC, MOD, ResizeHandle, TabVisitNav } from "./chrome";
import { useShell } from "./shellStore";
import { ProjectEditorDialog } from "./ProjectEditorDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsNav } from "../settings/SettingsNav";

const RAIL_MIN = 200;
const RAIL_MAX = 360;

type RailActionProps = {
  label: string;
  icon: IconComponent;
  onClick?: () => void;
  active?: boolean;
  shortcut?: string;
  ariaLabel?: string;
};

/** MonoCode `RailAction`. */
export function RailAction({ label, icon: Icon, onClick, active = false, shortcut, ariaLabel }: RailActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel ?? label}
      className={`relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/10 hover:text-content"
      } disabled:cursor-default disabled:opacity-40`}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{label}</span>
      {shortcut ? <span aria-hidden className="shrink-0 text-[11px] text-content/40">{shortcut}</span> : null}
    </button>
  );
}

/** MonoCode `RailSearch`. */
function RailSearch({ onClick, active }: { onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={`搜索 (${MOD}K)`}
      className={`relative flex h-8 w-full items-center gap-2 rounded-md border border-content/8 px-1.5 text-left ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/10 hover:text-content"
      } disabled:cursor-default disabled:opacity-40`}
    >
      <Search className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">搜索</span>
      <span aria-hidden className="shrink-0 text-[11px] text-content/40">{MOD}K</span>
    </button>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
      <span className="min-w-0 flex-1 truncate px-1 text-xs leading-5 text-content/50">{label}</span>
      {onAdd ? (
        <>
          <button
            ref={anchor}
            type="button"
            title="打开项目"
            aria-label="打开项目"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((value) => !value)}
            className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/8 hover:text-content aria-expanded:bg-content/8 aria-expanded:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          {menu ? (
            <Popover anchor={anchor} align="start" width={230} onDismiss={() => setMenu(false)} role="menu" aria-label="打开项目" className="p-1">
              <MenuItem icon={<FolderPlus strokeWidth={1.75} />} onClick={() => { setMenu(false); onAdd(); }}>
                打开文件夹…
              </MenuItem>
            </Popover>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

type SortableApi = ReturnType<typeof useAnimatedReorder>;

function ProjectCard({
  project,
  selected,
  busy,
  statsEnabled,
  canDrag,
  sortable,
  onSelect,
  onOpenMenu,
}: {
  project: Project;
  selected: boolean;
  busy: boolean;
  statsEnabled: boolean;
  canDrag: boolean;
  sortable: SortableApi;
  onSelect: (path: string) => void;
  onOpenMenu: (project: Project, x: number, y: number) => void;
}) {
  const stats = useGitDiffStats(project.path, statsEnabled).data;
  const additions = stats?.additions ?? 0;
  const deletions = stats?.deletions ?? 0;
  const roots = projectRoots(project);
  const labelClassName = "min-w-0 flex-1 truncate text-sm font-medium leading-tight";
  return (
    <div
      ref={(el) => sortable.setItemRef(project.path, el)}
      data-selected={selected || undefined}
      className={`reorder-item project-reorder-item group relative flex h-8 cursor-default touch-none items-stretch rounded-md px-2 ${
        selected ? "bg-selection-strong text-content" : "opacity-65 hover:opacity-100"
      }`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        if (canDrag) sortable.onItemPointerDown(project.path, event);
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-no-drag]")) return;
        if (sortable.consumeClick()) return;
        onSelect(project.path);
      }}
      onContextMenu={(event: ReactMouseEvent) => {
        event.preventDefault();
        onOpenMenu(project, event.clientX, event.clientY);
      }}
    >
      <button
        type="button"
        title={`${project.name}\n${project.path}`}
        aria-label={project.name}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 text-left transition-[padding] duration-150 group-hover:pr-6 motion-reduce:transition-none"
      >
        {selected ? (
          <FolderOpen className="size-4 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden />
        ) : (
          <Folder className="size-4 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden />
        )}
        {busy ? (
          <Shimmer as="span" duration={1.4} className={labelClassName}>{project.name}</Shimmer>
        ) : (
          <span className={labelClassName}>{project.name}</span>
        )}
        {roots.length > 1 ? (
          <span
            title={roots.map((root, index) => (index === 0 ? `${root}（主目录）` : root)).join("\n")}
            className="project-card-stats flex shrink-0 items-center gap-1 rounded bg-content/8 px-1.5 py-0.5 text-[10.5px] leading-4 tabular-nums text-content/50 group-hover:hidden"
          >
            <FolderTree className="size-3 shrink-0" strokeWidth={1.75} />
            {roots.length}
          </span>
        ) : null}
        {additions > 0 || deletions > 0 ? (
          <span className="project-card-stats shrink-0 group-hover:hidden">
            <DiffStat additions={additions} deletions={deletions} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        data-no-drag
        title="项目选项"
        aria-label="项目选项"
        aria-haspopup="menu"
        onClick={(event) => {
          event.stopPropagation();
          onOpenMenu(project, event.clientX, event.clientY);
        }}
        className="absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 hover:bg-content/8 hover:text-content group-hover:grid"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function UpdateFooter() {
  const update = useDesktopUpdate((state) => state.update);
  const version = useDesktopUpdate((state) => state.version);
  const installing = useDesktopUpdate((state) => state.installing);
  if (!update) return null;
  return (
    <div className="flex flex-col gap-1.5 p-2 pb-0">
      <button
        type="button"
        onClick={() => void installDesktopUpdate()}
        disabled={installing}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
          installing ? "bg-content/5 text-content/75" : "bg-accent/15 text-content hover:bg-accent/20"
        } disabled:cursor-default disabled:opacity-70`}
      >
        <span className="grid size-[18px] shrink-0 place-items-center">
          {installing ? <Loader className="size-4 animate-spin opacity-70" /> : <ArrowDownCircle className="size-4 text-accent" />}
        </span>
        <span className="block min-w-0 flex-1 truncate text-[12px] font-medium leading-tight">
          {installing ? "正在下载…" : `更新到 ${version}`}
        </span>
      </button>
    </div>
  );
}

const NAV: { id: Panel; label: string; icon: IconComponent }[] = [
  { id: "inbox", label: "收件箱", icon: InboxIcon },
  { id: "notes", label: "笔记", icon: File },
  { id: "automations", label: "自动化", icon: Zap },
  // 「技能与命令」和「常用工具」从侧栏撤下；面板保留，仍可从设置里进。
  { id: "mobile-access", label: "移动端", icon: SmartPhone },
];

export function ProjectRail({ visible, onSearch }: { visible: boolean; onSearch: () => void }) {
  const panel = useWorkspace((state) => state.panel);
  const cwd = useWorkspace((state) => state.cwd);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const homeDir = useWorkspace((state) => state.homeDir);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const { projects, add, update, remove, reorder } = useProjects();
  const width = useShell((state) => state.projectRailWidth);
  const setWidth = useShell((state) => state.setProjectRailWidth);
  const setProjectRailOpen = useShell((state) => state.setProjectRailOpen);
  const [busyProject, setBusyProject] = useState("");
  const [menu, setMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const settingsOpen = panel === "settings";
  const resize = useDragResize({
    min: RAIL_MIN,
    max: () => RAIL_MAX,
    defaultWidth: 240,
    initial: width,
    onCommit: setWidth,
  });

  const visibleProjects = useMemo(
    () => mergeProjects(projects, cwd && workspaceMode === "project" ? [cwd] : []),
    [cwd, projects, workspaceMode],
  );
  const projectIds = useMemo(() => visibleProjects.map((project) => project.path), [visibleProjects]);
  const onReorderProjects = (ids: string[]) => reorder(ids);
  const projectSortable = useAnimatedReorder(projectIds, onReorderProjects, "y");
  const canDragProjects = visibleProjects.length > 1;
  const runningProjects = useMemo(
    () => new Set(liveSessions.filter((session) => session.running).map((session) => session.cwd)),
    [liveSessions],
  );

  async function chooseProject(path: string) {
    useWorkspace.getState().set({ panel: "chat" });
    if (path === cwd && workspaceMode === "project") return;
    setBusyProject(path);
    try {
      await connect(path, "project");
      const project = useProjects.getState().projects.find((item) => item.path === path);
      if (project) await setSessionRoots(projectExtraRoots(project));
    } catch (error) {
      report(error);
    } finally {
      setBusyProject("");
    }
  }

  async function addProjects() {
    if (!desktopRuntime()) {
      report("请在电脑端选择文件夹");
      return;
    }
    const selected = await open({ directory: true, multiple: true, title: "打开项目", defaultPath: cwd || undefined });
    if (!selected) return;
    const paths = (Array.isArray(selected) ? selected : [selected]).map((path) => path.replace(/\/+$/, "") || "/");
    add(paths);
    await chooseProject(paths[0]);
  }

  async function removeSelected() {
    if (!removing) return;
    const target = removing;
    const fallback = projects.find((project) => project.path !== target.path);
    setBusyProject(target.path);
    try {
      await forgetProject(target.path);
      remove(target.path);
      setRemoving(null);
      if (target.path === cwd) {
        if (fallback) await connect(fallback.path, "project");
        else if (homeDir) await connect(homeDir, "home");
      }
      toast.success("已移除项目", { description: "磁盘文件不会被删除" });
    } catch (error) {
      report(error);
    } finally {
      setBusyProject("");
    }
  }

  return (
    <nav
      ref={resize.setPaneRef}
      aria-label="项目"
      className={`sidebar-glass relative shrink-0 flex-col border-r border-stroke ${visible ? "flex" : "hidden"}`}
    >
      <div className="flex h-10 shrink-0 select-none items-center pr-1.5" data-tauri-drag-region="deep">
        {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
        <DevModeSlot />
        <TabVisitNav onTogglePanel={settingsOpen ? undefined : () => setProjectRailOpen(false)} panelActive />
      </div>

      {settingsOpen ? (
        <SettingsNav />
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-0.5">
            <RailSearch onClick={onSearch} />
            <div className="mt-0.5" />
            {NAV.map((item) => (
              <RailAction
                key={item.id}
                label={item.label}
                icon={item.icon}
                active={panel === item.id}
                onClick={() => useWorkspace.getState().set({ panel: panel === item.id ? "chat" : item.id })}
              />
            ))}
          </div>

          <div ref={lockOverscroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2">
            <div className="mb-2 shrink-0">
              <SectionHeader label="项目" onAdd={desktopRuntime() ? () => void addProjects().catch(report) : undefined} />
              {visibleProjects.length === 0 ? (
                <p className="px-4 pb-1 text-[11px] leading-tight text-content/40">还没有项目</p>
              ) : null}
              <div className="flex flex-col gap-px px-2">
                {visibleProjects.map((project) => (
                  <ProjectCard
                    key={project.path}
                    project={project}
                    selected={workspaceMode === "project" && project.path === cwd}
                    busy={busyProject === project.path || runningProjects.has(project.path)}
                    statsEnabled={visible}
                    canDrag={canDragProjects}
                    sortable={projectSortable}
                    onSelect={(path) => void chooseProject(path)}
                    onOpenMenu={(target, x, y) => setMenu({ project: target, x, y })}
                  />
                ))}
              </div>
            </div>
          </div>

          <UpdateFooter />
          <div className="flex shrink-0 flex-col gap-px p-2">
            <RailAction
              label="设置"
              icon={Settings}
              shortcut={`${MOD},`}
              ariaLabel={`设置 (${MOD},)`}
              onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}
            />
          </div>
        </>
      )}

      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="项目选项" onClose={() => setMenu(null)}>
          <MenuItem icon={<Pencil strokeWidth={1.75} />} onClick={() => { setEditing(menu.project); setMenu(null); }}>编辑项目</MenuItem>
          <MenuItem icon={<Copy strokeWidth={1.75} />} onClick={() => { void navigator.clipboard.writeText(menu.project.path); setMenu(null); }}>复制路径</MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash strokeWidth={1.75} />} onClick={() => { setRemoving(menu.project); setMenu(null); }}>移除项目</MenuItem>
        </PointMenu>
      ) : null}
      {editing ? (
        <ProjectEditorDialog
          project={editing}
          homeDir={homeDir}
          onClose={() => setEditing(null)}
          onSave={async (project) => {
            update(project);
            if (workspaceMode === "project" && cwd === project.path) await setSessionRoots(projectExtraRoots(project));
            toast.success("项目已更新", { description: `${projectExtraRoots(project).length + 1} 个 app root` });
          }}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title="移除项目"
          confirmLabel="移除"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => void removeSelected()}
        >
          <p className="text-[13px] font-medium text-content">{removing.name}</p>
          <code className="mt-1 block break-all font-mono text-[11px] text-content/50">{removing.path}</code>
          <p className="mt-3 text-[12px] leading-relaxed text-content/55">只会从侧栏移除，不会删除磁盘文件。</p>
        </ConfirmDialog>
      ) : null}
      <ResizeHandle label="调整项目栏宽度" dragging={resize.dragging} onPointerDown={resize.onPointerDown} onDoubleClick={resize.onDoubleClick} />
    </nav>
  );
}
