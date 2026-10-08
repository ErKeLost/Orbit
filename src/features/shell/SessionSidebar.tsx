import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Session } from "../../lib/protocol";
import { useWorkspace } from "../../lib/store";
import { useProjects } from "../../lib/projects";
import { changeSession, connect, queryClient, report, retireSession } from "../../lib/rpc";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";
import { useGitBranches } from "../../lib/git";
import { useDragResize } from "../../shared/hooks/useDragResize";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { MenuItem, MenuSeparator, PointMenu } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";
import { CircleAlert, Copy, GitBranch, ListFilter, MessageSquare, Plus, Search, Trash2 as Trash } from "../../shared/ui/icons";
import { Icon } from "../../components/Icon";
import { sessionGlyph } from "../../lib/session-visual";
import { DevModeSlot, IS_MAC, MOD, ResizeHandle, TabVisitNav, TitleIconButton } from "./chrome";
import { useShell, type SidebarTab } from "./shellStore";
import { FileTree } from "./FileTree";
import { ConfirmDialog } from "./ConfirmDialog";
import { GitChangesPanel } from "../source-control/ui/GitChangesPanel";
import { TerminalSpinner } from "./TerminalSpinner";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;

function relativeTime(iso: string) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function sessionTitle(session: Session) {
  return (session.name || session.firstMessage || "新会话").replace(/\s+/g, " ").trim();
}

function SessionCard({
  session,
  active,
  working,
  needsInput,
  branch,
  onSelect,
  onContextMenu,
}: {
  session: Session;
  active: boolean;
  working: boolean;
  needsInput: boolean;
  branch: string | null;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  const title = sessionTitle(session);
  const statusClass = needsInput ? "text-amber-400" : working ? "text-accent" : "text-content/45";
  return (
    <li className="group relative">
      <div
        title={title}
        data-session-card={session.path}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className={`relative flex w-full cursor-default select-none flex-col rounded-md border px-2.5 py-2 text-left ${
          needsInput
            ? "border-dashed border-content/30 bg-content/20 text-content"
            : active
              ? "border-transparent bg-selection text-content"
              : "border-transparent text-content/80 hover:bg-content/5 hover:text-content"
        }`}
      >
        <div role="button" tabIndex={0} aria-current={active ? "true" : undefined} onKeyDown={(event) => { if (event.key === "Enter") onSelect(); }} className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent/50">
          <span className="relative flex min-w-0 items-center gap-2">
            <Icon name={sessionGlyph(session.icon)} className="size-3.5 shrink-0 text-content/55" />
            <span className="line-clamp-1 min-w-0 flex-1 text-[13px] font-semibold leading-snug text-content">{title}</span>
            <span className={`flex shrink-0 items-center gap-1 text-[11px] tabular-nums ${statusClass}`}>
              {needsInput ? (
                <>
                  <CircleAlert className="size-3" strokeWidth={1.75} />
                  <span>需要处理</span>
                </>
              ) : working ? (
                <>
                  <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none text-accent" />
                  <span>Working...</span>
                </>
              ) : (
                <span>{relativeTime(session.modified)}</span>
              )}
            </span>
          </span>
        </div>
        <span className="relative mt-1 flex items-center gap-2">
          {branch ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-content/45">
              <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">{branch}</span>
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
        </span>
      </div>
    </li>
  );
}

function SessionsList({ cwd, query }: { cwd: string; query: string }) {
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const currentFile = useWorkspace((state) => state.state?.sessionFile);
  const dialogs = useWorkspace((state) => state.dialogs.length);
  const projects = useProjects((state) => state.projects);
  const sessions = useProjectSessions(cwd);
  const branches = useGitBranches(cwd).data;
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const merged = useMemo(() => mergeProjectSessions(cwd, sessions.data ?? [], liveSessions), [cwd, sessions.data, liveSessions]);
  const projectName = projects.find((project) => project.path === cwd)?.name ?? cwd.split("/").filter(Boolean).at(-1) ?? "";
  const branchLabel = branches?.current ? `${projectName}/${branches.current}` : projectName;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? merged.sessions.filter((session) => sessionTitle(session).toLowerCase().includes(needle)) : merged.sessions;
  }, [merged.sessions, query]);

  async function open(session: Session) {
    try {
      const workspace = useWorkspace.getState();
      if (workspace.cwd !== cwd || workspace.workspaceMode !== "project" || workspace.connection !== "online") await connect(cwd, "project");
      await changeSession({ type: "switch_session", sessionPath: session.path });
    } catch (error) {
      report(error);
    }
  }

  async function remove() {
    if (!deleting) return;
    const target = deleting;
    try {
      await retireSession(target.path);
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ["pi", "sessions", cwd] });
      toast.success("会话已删除");
    } catch (error) {
      report(error);
    }
  }

  if (sessions.isPending && !merged.sessions.length) return null;
  if (sessions.isError && !merged.sessions.length) return <p className="px-3 py-2 text-[12px] text-content/50">无法读取会话</p>;
  if (!visible.length) {
    return query.trim() ? (
      <p className="px-3 py-2 text-[12px] text-content/50">没有匹配的会话</p>
    ) : (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <MessageSquare className="size-5 text-content/30" strokeWidth={1.5} />
        <p className="text-[12px] text-content/45">还没有会话</p>
      </div>
    );
  }
  return (
    <>
      <ul data-session-list className="flex flex-col gap-0.5 p-1.5 pb-10">
        {visible.map((session) => {
          const live = liveSessions.find((item) => item.path === session.path);
          const active = session.path === currentFile;
          return (
            <SessionCard
              key={session.path}
              session={session}
              active={active}
              working={Boolean(live?.running)}
              needsInput={active && dialogs > 0}
              branch={branchLabel}
              onSelect={() => void open(session)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ session, x: event.clientX, y: event.clientY });
              }}
            />
          );
        })}
      </ul>
      {menu ? (
        <PointMenu x={menu.x} y={menu.y} label="会话操作" onClose={() => setMenu(null)}>
          <MenuItem icon={<MessageSquare strokeWidth={1.75} />} onClick={() => { void open(menu.session); setMenu(null); }}>打开会话</MenuItem>
          <MenuItem icon={<Copy strokeWidth={1.75} />} onClick={() => { void navigator.clipboard.writeText(sessionTitle(menu.session)); setMenu(null); }}>复制标题</MenuItem>
          {merged.listedPaths.has(menu.session.path) ? (
            <>
              <MenuSeparator />
              <MenuItem danger icon={<Trash strokeWidth={1.75} />} onClick={() => { setDeleting(menu.session); setMenu(null); }}>删除会话</MenuItem>
            </>
          ) : null}
        </PointMenu>
      ) : null}
      {deleting ? (
        <ConfirmDialog title="删除会话" confirmLabel="删除" danger onCancel={() => setDeleting(null)} onConfirm={() => void remove()}>
          <p className="font-medium text-content">{sessionTitle(deleting)}</p>
          <p className="mt-2 text-[12px] leading-relaxed text-content/55">会话文件会从 Pi 的会话目录中永久删除。</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function WorkspaceTabs({ tab, onPick }: { tab: SidebarTab; onPick: (tab: SidebarTab) => void }) {
  const items: { id: SidebarTab; label: string }[] = [
    { id: "sessions", label: "会话" },
    { id: "files", label: "文件" },
    { id: "changes", label: "变更" },
  ];
  return (
    <div role="tablist" aria-label="Workspace" className="flex h-9 shrink-0 items-center gap-px border-b border-stroke px-2">
      {items.map((item) => {
        const active = tab === item.id;
        return (
          <div key={item.id} className="workspace-tab relative flex min-w-0 flex-1 items-stretch">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-tauri-drag-region="false"
              onClick={() => onPick(item.id)}
              className={`flex h-6 min-w-0 flex-1 items-center justify-center self-center rounded-md px-2 text-[12px] leading-none ${
                active ? "bg-selection text-content" : "text-content/50"
              }`}
            >
              <span className="block truncate leading-label">{item.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function SessionSidebar({ visible, railVisible, onSearch }: { visible: boolean; railVisible: boolean; onSearch: () => void }) {
  const cwd = useWorkspace((state) => state.cwd);
  const online = useWorkspace((state) => state.connection === "online");
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const tab = useShell((state) => state.sidebarTab);
  const setTab = useShell((state) => state.setSidebarTab);
  const openFile = useShell((state) => state.openFile);
  const width = useShell((state) => state.sessionSidebarWidth);
  const setWidth = useShell((state) => state.setSessionSidebarWidth);
  const setProjectRailOpen = useShell((state) => state.setProjectRailOpen);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const project = workspaceMode === "project" && cwd && cwd !== homeDir ? cwd : "";
  const resize = useDragResize({ min: SIDEBAR_MIN, max: () => SIDEBAR_MAX, defaultWidth: 272, initial: width, onCommit: setWidth });

  useEffect(() => setQuery(""), [project]);

  const newSession = () => {
    useWorkspace.getState().set({ panel: "chat" });
    void (async () => {
      // Pi only accepts a new session over a live worker, so connect first if
      // the connection dropped (app restart, project switch, closed settings).
      const state = useWorkspace.getState();
      if (state.connection !== "online" && state.cwd) await connect(state.cwd, "project");
      await changeSession({ type: "new_session" });
    })().catch(report);
  };

  return (
    <aside ref={resize.setPaneRef} className={`body-glass relative h-full min-h-0 shrink-0 flex-col border-r border-stroke ${visible ? "flex" : "hidden"}`}>
      {!railVisible ? (
        <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke pr-1.5" data-tauri-drag-region="deep">
          {IS_MAC ? <div className="w-[78px] shrink-0" /> : null}
          <DevModeSlot />
          <TabVisitNav onTogglePanel={() => setProjectRailOpen(true)} />
        </div>
      ) : null}
      <div className="flex h-10 shrink-0 select-none items-center gap-1 border-b border-stroke pl-3 pr-1.5" data-tauri-drag-region="deep">
        <div className="flex min-w-0 flex-1 items-center">
          <span className="min-w-0 truncate text-sm font-medium leading-tight">工作区</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" data-tauri-drag-region="false">
          <TitleIconButton label={`搜索 (${MOD}K)`} onClick={onSearch}>
            <Search className="size-3.5" strokeWidth={1.75} />
          </TitleIconButton>
          <TitleIconButton label={`新会话 (${MOD}N)`} disabled={!online} onClick={newSession}>
            <Plus className="size-3.5" strokeWidth={1.75} />
          </TitleIconButton>
        </div>
      </div>
      <WorkspaceTabs tab={tab} onPick={setTab} />

      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${tab === "files" ? "" : "hidden"}`}>
        {project ? <FileTree cwd={project} /> : <p className="px-3 py-2 text-[12px] text-content/50">没有项目文件夹</p>}
      </div>

      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${tab === "changes" ? "" : "hidden"}`}>
        {project ? (
          <GitChangesPanel
            cwd={project}
            enabled={visible && tab === "changes" && online}
            onOpenFile={(path, _kind, pin) => openFile(path, { pin })}
            onOpenAllChanges={() => undefined}
            onOpenCommit={() => undefined}
          />
        ) : (
          <p className="px-3 py-2 text-[12px] text-content/50">没有项目文件夹</p>
        )}
      </div>

      {tab === "sessions" && project ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
          <div className="relative flex h-7 min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话…"
              aria-label="搜索会话"
              className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </div>
          <button
            type="button"
            title="筛选会话"
            aria-label="筛选会话"
            onClick={() => searchRef.current?.focus()}
            className="relative grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <ListFilter className="size-3" strokeWidth={1.75} />
          </button>
        </div>
      ) : null}
      <div ref={lockOverscroll} className={`sidebar-session-scroll min-h-0 flex-1 overflow-y-auto overscroll-none ${tab === "sessions" ? "" : "hidden"}`}>
        {project ? <SessionsList cwd={project} query={query} /> : <p className="px-3 py-2 text-[12px] text-content/50">没有项目文件夹</p>}
      </div>
      <ResizeHandle label="调整侧栏宽度" dragging={resize.dragging} onPointerDown={resize.onPointerDown} onDoubleClick={resize.onDoubleClick} />
    </aside>
  );
}
