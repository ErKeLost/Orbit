import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspace, type Panel } from "../../../lib/store";
import type { Session } from "../../../lib/protocol";
import {
  activeProjects,
  archivedProjects,
  mergeProjects,
  sortPinnedFirst,
  useProjects,
  type Project,
} from "../../../lib/projects";
import { connect, desktopRuntime, forgetProject, prefetchSession, queryClient, renameSession, report } from "../../../lib/rpc";
import { useWorkspaceTabs } from "../use-workspace-tabs";
import { useSessionContextMenu } from "../sessions/SessionMenu";
import { SessionTitleField } from "../sessions/SessionTitleField";
import { runRemoteHostOperation } from "../../../lib/remote-runtime";
import { useProjectSessionGroups } from "../../../hooks/use-project-sessions";
import { sessionGlyph, sessionRelativeTime, sessionTitle } from "../../../lib/session-visual";
import { projectName as pathProjectName } from "../../../shared/lib/paths";
import { Icon } from "../../../components/Icon";
import { ProjectDirectoryPicker } from "./ProjectDirectoryPicker";
import { installDesktopUpdate, useDesktopUpdate } from "../../../lib/desktop-update";
import { useDragResize } from "../../../shared/hooks/useDragResize";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { toast } from "../../../shared/ui/toast";
import {
  Archive,
  ChartBreakoutSquare,
  ChevronDown,
  Inbox as InboxIcon,
  ArrowDownCircle,
  Loader,
  Search,
  Settings,
  SmartPhone,
  File,
  Zap,
  type IconComponent,
} from "../../../shared/ui/icons";
import { DevModeSlot, IS_MAC, MOD, ResizeHandle, TabVisitNav } from "../chrome";
import { TerminalSpinner } from "../TerminalSpinner";
import { ProjectContextMenu } from "./ProjectContextMenu";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useShell } from "../shellStore";
import { ProjectEditorDialog } from "./ProjectEditorDialog";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsNav } from "../../settings/SettingsNav";

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

/** Orbit `RailAction`. */
export function RailAction({ label, icon: Icon, onClick, active = false, shortcut, ariaLabel }: RailActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={ariaLabel ?? label}
      className={`rail-row relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/10 hover:text-content"
      } disabled:cursor-default disabled:opacity-40`}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{label}</span>
      {shortcut ? <span aria-hidden className="shrink-0 text-[11px] text-content/40">{shortcut}</span> : null}
    </button>
  );
}

/** Orbit `RailSearch`. */
function RailSearch({ onClick, active }: { onClick?: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={`搜索 (${MOD}K)`}
      className={`rail-row rail-search-row relative flex h-8 w-full items-center gap-2 rounded-md border border-content/8 px-1.5 text-left ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/10 hover:text-content"
      } disabled:cursor-default disabled:opacity-40`}
    >
      <Search className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">搜索</span>
      <span aria-hidden className="rail-shortcut shrink-0 text-[11px] text-content/40">{MOD}K</span>
    </button>
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

/** 已归档项目：折叠在底部，展开后可逐个恢复（monocode 的 Archive 精简版）。 */
function ArchivedFooter({ projects }: { projects: Project[] }) {
  const { update } = useProjects();
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return null;
  return (
    <div className="shrink-0 px-2 pb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className={`flex h-7 w-full items-center gap-1 rounded-md px-2 text-left ${open ? "bg-content/5" : "hover:bg-content/5"}`}
      >
        <Archive className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-content/50">已归档</span>
        <span className="shrink-0 rounded-full bg-content/8 px-1.5 text-[10px] tabular-nums text-content/50">{projects.length}</span>
      </button>
      {open ? (
        <div className="mt-0.5 flex flex-col gap-px">
          {projects.map(project => (
            <div key={project.path} className="group flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-content/5">
              <span className="min-w-0 flex-1 truncate text-[12px] text-content/60" title={project.path}>{project.name}</span>
              <button
                type="button"
                title="恢复项目"
                onClick={() => update({ ...project, archivedAt: undefined })}
                className="shrink-0 rounded px-1.5 text-[11px] text-content/50 hover:bg-content/10 hover:text-content"
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const AGE_GROUPS = ["今天", "昨天", "最近 7 天", "更早"] as const;
type AgeGroup = (typeof AGE_GROUPS)[number];

/**
 * 一条会话的最近活动落在哪一段。
 *
 * 按**日历日**分界而不是「多少小时前」：凌晨两点看到的「今天」应该还是今天，
 * 而不是一个跟着时钟滑动的窗口。这也是 monocode 侧栏的分法。
 */
function sessionAge(updatedAt: number, now: number): AgeGroup {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startOfToday = start.getTime();
  if (!Number.isFinite(updatedAt) || updatedAt < startOfToday - 6 * DAY_MS) return "更早";
  if (updatedAt >= startOfToday) return "今天";
  if (updatedAt >= startOfToday - DAY_MS) return "昨天";
  return "最近 7 天";
}

/** 项目栏里的会话行：标题 + 所属项目，右侧是运行状态或相对时间。 */
function RailSessionCard({
  session,
  projectLabel,
  active,
  running,
  renaming,
  onSelect,
  onContextMenu,
  onStartRename,
  onCancelRename,
  onRename,
}: {
  session: Session;
  projectLabel: string;
  active: boolean;
  running: boolean;
  /** 这一行是否正在行内编辑标题（右键菜单或双击标题进入）。 */
  renaming?: boolean;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onStartRename?: () => void;
  onCancelRename?: () => void;
  onRename?: (name: string) => void;
}) {
  const title = sessionTitle(session);
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${title}\n${projectLabel}`}
      data-session-card={session.path}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onPointerEnter={() => prefetchSession(session.path)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
        else if (event.key === "F2" && onStartRename) {
          event.preventDefault();
          onStartRename();
        }
      }}
      className={`group flex h-7 w-full cursor-default select-none items-center gap-2 rounded-md px-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
        active ? "bg-selection-strong text-content" : "text-content/75 hover:bg-content/5 hover:text-content"
      }`}
    >
      {/* 图标列定宽：标题的左沿必须是一条线，否则一列扫下去全是毛边。 */}
      <span className="grid w-4 shrink-0 place-items-center">
        <Icon name={sessionGlyph(session.icon)} className="size-3.5 text-content/45 group-hover:text-content/70" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        {renaming && onRename && onCancelRename ? (
          <SessionTitleField value={title} onCommit={onRename} onCancel={onCancelRename} className="text-[12.5px]" />
        ) : (
          <span
            className={`truncate text-[12.5px] leading-tight ${active ? "font-medium" : ""}`}
            onDoubleClick={(event) => {
              if (!onStartRename) return;
              event.preventDefault();
              event.stopPropagation();
              onStartRename();
            }}
          >
            {title}
          </span>
        )}
      </span>
      <span className="flex w-6 shrink-0 items-center justify-end text-[10px] tabular-nums text-content/30 group-hover:text-content/45">
        {running ? (
          <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none text-accent" />
        ) : (
          sessionRelativeTime(session.modified)
        )}
      </span>
    </div>
  );
}

export const NAV: { id: Panel; label: string; icon: IconComponent }[] = [
  { id: "inbox", label: "收件箱", icon: InboxIcon },
  { id: "notes", label: "笔记", icon: File },
  { id: "artifacts", label: "产物", icon: ChartBreakoutSquare },
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
  const currentSessionFile = useWorkspace((state) => state.state?.sessionFile);
  const { projects, add, update, remove } = useProjects();
  const width = useShell((state) => state.projectRailWidth);
  const setWidth = useShell((state) => state.setProjectRailWidth);
  const setProjectRailOpen = useShell((state) => state.setProjectRailOpen);
  const [busyProject, setBusyProject] = useState("");
  // 项目栏的会话行同样支持行内改名；和会话侧栏一样，同一时刻只允许一行在编辑。
  const [renamingPath, setRenamingPath] = useState("");
  const tabs = useWorkspaceTabs();
  const { openMenu: openSessionMenu, menuNode: sessionMenuNode } = useSessionContextMenu({
    onOpen: (session) => void openSession(session).catch(report),
    onRename: (session) => setRenamingPath(session.path),
    onDeleted: (session) => void queryClient.invalidateQueries({ queryKey: ["pi", "sessions", session.cwd] }),
  });
  const [picker, setPicker] = useState(false);
  // 会话区块的展开状态：和其它 shell 偏好一样存 localStorage，重启后保持。
  const [sessionsOpen, setSessionsOpen] = useState(() => {
    try { return localStorage.getItem("orbit.shell.railSessions") !== "false"; } catch { return true; }
  });
  const runtimeTarget = useWorkspace((state) => state.runtimeTarget);
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
    () =>
      sortPinnedFirst(
        activeProjects(mergeProjects(projects, cwd && workspaceMode === "project" ? [cwd] : [])),
      ),
    [cwd, projects, workspaceMode],
  );
  const hidden = useMemo(() => archivedProjects(projects), [projects]);
  /** 侧栏标题认的项目：只有“在这个项目里工作”时才算，首页不属于任何项目。 */
  const currentProject = useMemo(
    () =>
      workspaceMode === "project"
        ? (visibleProjects.find((project) => project.path === cwd) ?? null)
        : null,
    [cwd, visibleProjects, workspaceMode],
  );

  /**
   * 会话区块只扫**当前**作用域：项目模式下是这个项目，主目录模式下是主目录。
   * 别的项目的会话仍然活着（后台跑、被收养/休眠），只是不在这里列——要看它们，
   * 从标题上的项目菜单切过去。
   */
  const sessionRoots = useMemo(() => (cwd ? [cwd] : []), [cwd]);
  const sessionGroups = useProjectSessionGroups(sessionRoots);

  /** 跨项目的最近会话（含还没落盘的活跃会话），新到旧；不设上限，列表随项目栏滚动。 */
  const railSessions = useMemo(() => {
    type RailSession = { session: Session; project: string };
    const entries: RailSession[] = [];
    const seen = new Set<string>();
    for (const group of sessionGroups) {
      const listed = group.query.data ?? [];
      const listedPaths = new Set(listed.map((session) => session.path));
      for (const live of liveSessions) {
        if (live.cwd !== group.cwd || !live.path || listedPaths.has(live.path) || seen.has(live.path)) continue;
        seen.add(live.path);
        entries.push({
          session: {
            path: live.path,
            id: live.path,
            cwd: live.cwd,
            firstMessage: live.title,
            messageCount: 0,
            modified: new Date().toISOString(),
          },
          project: live.cwd,
        });
      }
      for (const session of listed) {
        if (seen.has(session.path)) continue;
        seen.add(session.path);
        entries.push({ session, project: group.cwd });
      }
    }
    entries.sort((a, b) => Date.parse(b.session.modified) - Date.parse(a.session.modified));
    return entries;
  }, [sessionGroups, liveSessions]);

  /**
   * 会话按最近活动分组。29 条排成一列、每条都一样重，读起来就是一堵墙；
   * 分成四段之后，每一段自己就有了边界，找东西靠位置而不是靠逐行读。
   */
  const sessionAgeSections = useMemo(() => {
    const now = Date.now();
    const buckets = new Map<AgeGroup, typeof railSessions>(
      AGE_GROUPS.map((label) => [label, [] as typeof railSessions]),
    );
    for (const entry of railSessions) {
      buckets.get(sessionAge(Date.parse(entry.session.modified), now))!.push(entry);
    }
    return AGE_GROUPS.map((label) => ({ label, items: buckets.get(label)! })).filter(
      (group) => group.items.length > 0,
    );
  }, [railSessions]);

  /** 会话所属项目的展示名；主目录不是注册项目，单独给它名字。 */
  const projectLabel = (path: string) => {
    if (homeDir && path === homeDir) return "主目录";
    return projects.find((project) => project.path === path)?.name ?? pathProjectName(path);
  };

  async function openSession(session: Session) {
    useWorkspace.getState().set({ panel: "chat" });
    // 真实会话进 header 的标签页；首页只留给“新会话”。
    await tabs.openSession(session);
  }

  /** 提交项目栏里的改名。列表面自己刷新（`renameSession` 会作废所有项目缓存）。 */
  function commitRailRename(session: Session, name: string) {
    setRenamingPath("");
    if (name.trim() === sessionTitle(session)) return;
    void renameSession(session.path, name, liveSessions.find((item) => item.path === session.path)?.connectionId).catch(report);
  }

  async function chooseHome() {
    if (!homeDir) {
      report("还没有找到主目录");
      return;
    }
    useWorkspace.getState().set({ panel: "chat" });
    setBusyProject(homeDir);
    try {
      await tabs.openScope(homeDir, "home");
    } catch (error) {
      report(error);
    } finally {
      setBusyProject("");
    }
  }

  async function chooseProject(path: string) {
    useWorkspace.getState().set({ panel: "chat" });
    setBusyProject(path);
    try {
      // 优先带出这个项目上次的会话（header 上的会话是挂项目的），没有才开新会话首页。
      await tabs.selectProject(path, "project");
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
      // On a phone the registry lives on the desktop, so the removal has to go
      // there; the local store is a mirror and will be replaced by the desktop's
      // next publication anyway.
      if (runtimeTarget === "mobile") {
        await runRemoteHostOperation({ name: "project.forget", path: target.path });
        setRemoving(null);
        toast.success("已在电脑上移除项目", { description: "磁盘文件不会被删除" });
        return;
      }
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
            {/* 侧栏标题：项目名 + 分支，切换下沉成菜单里的子级。
                和下面的搜索/导航同宽同高，图标左沿对齐，中间空出一行呼吸。 */}
            <div className="flex shrink-0 items-center pb-1.5">
              <ProjectSwitcher
                current={currentProject}
                projects={visibleProjects}
                pending={Boolean(cwd) && busyProject === cwd}
                onSelectProject={(path) => void chooseProject(path)}
                onAddProject={
                  runtimeTarget === "mobile"
                    ? () => setPicker(true)
                    : desktopRuntime()
                      ? () => void addProjects().catch(report)
                      : undefined
                }
                onOpenHome={homeDir ? () => void chooseHome() : undefined}
                onOpenProjectMenu={(project, x, y) => setMenu({ project, x, y })}
                onOpenSettings={() => useWorkspace.getState().set({ panel: "settings" })}
                settingsShortcut={`${MOD},`}
              />
            </div>
            <RailSearch onClick={onSearch} />
            <div className="mt-0.5" />
            {NAV
              // 「移动端」是电脑上的 Host 页面（开关 + 二维码），手机点进去只能看自己的配对页，
              // 所以在手机上不占一行。
              .filter((item) => !(runtimeTarget === "mobile" && item.id === "mobile-access"))
              .map((item) => (
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
            {railSessions.length > 0 ? (
              <div className="mb-2 shrink-0">
                <button
                  type="button"
                  aria-expanded={sessionsOpen}
                  aria-label={sessionsOpen ? "收起会话列表" : "展开会话列表"}
                  onClick={() => {
                    try { localStorage.setItem("orbit.shell.railSessions", String(!sessionsOpen)); } catch { /* storage unavailable */ }
                    setSessionsOpen((value) => !value);
                  }}
                  className="flex h-7 w-full items-center gap-1 px-3 pb-1.5 text-left"
                >
                  <ChevronDown
                    className={`size-3 shrink-0 text-content/50 transition-transform ${sessionsOpen ? "" : "-rotate-90"}`}
                    strokeWidth={1.75}
                  />
                  <span className="min-w-0 flex-1 truncate px-0.5 text-xs leading-5 text-content/50">会话</span>
                  <span className="shrink-0 rounded-full bg-content/8 px-1.5 text-[10px] tabular-nums leading-4 text-content/50">
                    {railSessions.length}
                  </span>
                </button>
                {sessionsOpen ? (
                  <div className="flex flex-col pb-1">
                    {sessionAgeSections.map((group) => (
                      <section key={group.label} aria-label={group.label}>
                        {/* 分组标题：11px、40% 灰，只做分隔不做主角。 */}
                        <h3 className="flex items-center gap-2 px-3 pb-1 pt-2 text-[10.5px] font-medium tracking-wide text-content/35">
                          <span className="min-w-0 truncate">{group.label}</span>
                          <span className="shrink-0 tabular-nums text-content/25">{group.items.length}</span>
                        </h3>
                        <div className="flex flex-col gap-px px-2">
                          {group.items.map(({ session, project }) => (
                            <RailSessionCard
                              key={session.path}
                              session={session}
                              projectLabel={projectLabel(project)}
                              active={session.path === currentSessionFile}
                              running={Boolean(liveSessions.find((live) => live.path === session.path)?.running)}
                              renaming={renamingPath === session.path}
                              onSelect={() => void openSession(session).catch(report)}
                              onContextMenu={(event) => openSessionMenu(session, event)}
                              onStartRename={() => setRenamingPath(session.path)}
                              onCancelRename={() => setRenamingPath("")}
                              onRename={(name) => commitRailRename(session, name)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <UpdateFooter />
          <ArchivedFooter projects={hidden} />
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
        <ProjectContextMenu
          project={menu.project}
          x={menu.x}
          y={menu.y}
          onEdit={setEditing}
          onRemove={setRemoving}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {sessionMenuNode}
      {editing ? (
        <ProjectEditorDialog
          project={editing}
          homeDir={homeDir}
          onClose={() => setEditing(null)}
          onSave={async (project) => {
            update(project);
            toast.success("项目已更新");
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
      {picker ? <ProjectDirectoryPicker open onClose={() => setPicker(false)} /> : null}
      <ResizeHandle label="调整项目栏宽度" dragging={resize.dragging} onPointerDown={resize.onPointerDown} onDoubleClick={resize.onDoubleClick} />
    </nav>
  );
}
