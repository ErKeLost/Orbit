import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { gooeyToast } from "goey-toast";
import type { Session } from "../../lib/protocol";
import type { LiveSession, Panel } from "../../lib/store";
import { useWorkspace } from "../../lib/store";
import { mergeProjects, projectExtraRoots, useProjects, type Project } from "../../lib/projects";
import { installDesktopUpdate, useDesktopUpdate } from "../../lib/desktop-update";
import { changeSession, connect, desktopRuntime, forgetProject, queryClient, report, retireSession, setSessionRoots } from "../../lib/rpc";
import { mergeProjectSessions, useProjectSessionGroups } from "../../hooks/use-project-sessions";
import { sessionGlyph } from "../../lib/session-visual";
import { Button, Modal } from "../UI";
import { Icon } from "../Icon";
import { DeleteSessionDialog } from "../DeleteSessionDialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu";
import { FlowerRail, type FlowerRailItem } from "./FlowerRail";
import { WorkspaceTitlebar } from "./WorkspaceTitlebar";
import { ProjectActions } from "./ProjectActions";
import { ProjectEditorDialog } from "./ProjectEditorDialog";

const SESSION_PREVIEW = 5;
const navigation: { id: Panel; label: string; icon: string }[] = [
  { id: "chat", label: "工作台", icon: "chat-circle-text" },
  { id: "commands", label: "技能与命令", icon: "puzzle-piece" },
  { id: "mobile-access", label: "移动端", icon: "device-mobile" },
];

export type WorkspaceSidebarProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  online: boolean;
  panel: Panel;
  liveSessions: LiveSession[];
  currentSessionFile?: string;
  hideTitlebar?: boolean;
  onNavigate?: () => void;
};

type SessionTarget = { session: Session; projectPath: string };

export function WorkspaceSidebar({ sidebarOpen, onToggleSidebar, online, panel, liveSessions, currentSessionFile, hideTitlebar = false, onNavigate }: WorkspaceSidebarProps) {
  const cwd = useWorkspace(state => state.cwd);
  const workspaceMode = useWorkspace(state => state.workspaceMode);
  const homeDir = useWorkspace(state => state.homeDir);
  const { projects, add, update, remove } = useProjects();
  const visibleProjects = useMemo(() => mergeProjects(projects, cwd && workspaceMode === "project" ? [cwd] : []), [cwd, projects, workspaceMode]);
  const sessionGroups = useProjectSessionGroups(visibleProjects.map(project => project.path));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [busyProject, setBusyProject] = useState("");
  const [deletingSession, setDeletingSession] = useState<SessionTarget | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [expandedMore, setExpandedMore] = useState<Set<string>>(() => new Set());
  const updateOffer = useDesktopUpdate(state => state.update);
  const updateVersion = useDesktopUpdate(state => state.version);
  const updateInstalling = useDesktopUpdate(state => state.installing);

  async function syncProjectRoots(project: Project) {
    await setSessionRoots(projectExtraRoots(project));
  }

  async function chooseProject(path: string) {
    setBusyProject(path);
    setCollapsed(current => { const next = new Set(current); next.delete(path); return next; });
    try {
      await connect(path, "project");
      const project = useProjects.getState().projects.find(item => item.path === path);
      if (project) await syncProjectRoots(project);
      onNavigate?.();
    }
    catch (error) { report(error); }
    finally { setBusyProject(""); }
  }

  async function addProjects() {
    if (!desktopRuntime()) { report("请在电脑端选择文件夹"); return; }
    const selected = await open({ directory: true, multiple: true, title: "添加项目", defaultPath: cwd || undefined });
    if (!selected) return;
    const paths = (Array.isArray(selected) ? selected : [selected]).map(path => path.replace(/\/+$/, "") || "/");
    add(paths);
    setCollapsed(current => { const next = new Set(current); for (const path of paths) next.delete(path); return next; });
    await chooseProject(paths[0]);
  }

  async function openSession(projectPath: string, session: Session) {
    setBusyProject(projectPath);
    try {
      if (cwd !== projectPath || workspaceMode !== "project" || !online) await connect(projectPath, "project");
      await changeSession({ type: "switch_session", sessionPath: session.path });
      const project = useProjects.getState().projects.find(item => item.path === projectPath);
      if (project) await syncProjectRoots(project);
      onNavigate?.();
    } catch (error) { report(error); }
    finally { setBusyProject(""); }
  }

  async function newSession(projectPath = cwd) {
    setBusyProject(projectPath);
    setCollapsed(current => { const next = new Set(current); next.delete(projectPath); return next; });
    try {
      if (cwd !== projectPath || workspaceMode !== "project" || !online) await connect(projectPath, "project");
      await changeSession({ type: "new_session" });
      const project = useProjects.getState().projects.find(item => item.path === projectPath);
      if (project) await syncProjectRoots(project);
      onNavigate?.();
    } catch (error) { report(error); }
    finally { setBusyProject(""); }
  }

  async function saveProject(project: Project) {
    update(project);
    if (workspaceMode === "project" && cwd === project.path && online) await syncProjectRoots(project);
    gooeyToast.success("项目已更新", { description: `${projectExtraRoots(project).length + 1} 个 app root`, showTimestamp: false });
  }

  async function deleteSelectedSession() {
    if (!deletingSession) return;
    const target = deletingSession;
    try {
      await retireSession(target.session.path);
      setDeletingSession(null);
      await queryClient.invalidateQueries({ queryKey: ["pi", "sessions", target.projectPath] });
      gooeyToast.success("会话已删除", { showTimestamp: false });
    } catch (error) { report(error); }
  }

  async function removeSelectedProject() {
    if (!deletingProject) return;
    const target = deletingProject;
    const fallback = projects.find(project => project.path !== target.path);
    setBusyProject(target.path);
    try {
      await forgetProject(target.path);
      remove(target.path);
      setDeletingProject(null);
      if (target.path === cwd) {
        if (fallback) await connect(fallback.path, "project");
        else if (homeDir) await connect(homeDir, "home");
      }
      gooeyToast.success("已移除项目", { description: "磁盘文件不会被删除", showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusyProject(""); }
  }

  function toggleMore(path: string) {
    setExpandedMore(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function setProjectExpanded(path: string, open: boolean) {
    setCollapsed(current => {
      const next = new Set(current);
      if (open) next.delete(path); else next.add(path);
      return next;
    });
  }

  return <div className="sidebar-pane">
    {!hideTitlebar && <WorkspaceTitlebar variant="sidebar" sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />}
    <aside className="sidebar">
      <nav aria-label="主导航">{navigation.map(item => <Button key={item.id} className={`nav-item ${panel === item.id ? "selected" : ""}`} onClick={() => { useWorkspace.getState().set({ panel: item.id }); onNavigate?.(); }}><Icon name={item.icon} /><span>{item.label}</span>{item.id === "commands" && <Icon name="arrow-up-right" />}</Button>)}</nav>

      <div className="sidebar-library">
        <div className="sidebar-section-title sidebar-projects-title"><span><Icon name="folder-simple" />项目</span><Button title="添加项目" disabled={!desktopRuntime()} onClick={() => void addProjects().catch(report)}><Icon name="plus" /></Button></div>
        <div className="sidebar-flower">
          <FlowerRail items={visibleProjects.flatMap((project, index) => {
            const merged = mergeProjectSessions(project.path, sessionGroups[index]?.query.data ?? [], liveSessions);
            const isActiveProject = workspaceMode === "project" && project.path === cwd;
            const isExpanded = !collapsed.has(project.path);
            const showAll = expandedMore.has(project.path);
            const sessions = isExpanded ? (showAll ? merged.sessions : merged.sessions.slice(0, SESSION_PREVIEW)) : [];
            const activeSession = isActiveProject && sessions.some(session => session.path === currentSessionFile);
            const items: FlowerRailItem[] = [{ id: project.path, kind: "project", active: Boolean(isActiveProject && !activeSession) }];
            for (const session of sessions) items.push({ id: session.path, kind: "session", active: Boolean(isActiveProject && session.path === currentSessionFile) });
            if (isExpanded && merged.sessions.length > SESSION_PREVIEW) items.push({ id: `${project.path}-more`, kind: "session", active: false });
            return items;
          })} />
          <div className="sidebar-flower-list">
            {visibleProjects.flatMap((project, index) => {
              const merged = mergeProjectSessions(project.path, sessionGroups[index]?.query.data ?? [], liveSessions);
              const isActiveProject = workspaceMode === "project" && project.path === cwd;
              const isExpanded = !collapsed.has(project.path);
              const showAll = expandedMore.has(project.path);
              const sessions = isExpanded ? (showAll ? merged.sessions : merged.sessions.slice(0, SESSION_PREVIEW)) : [];
              const rows = [<ContextMenu key={project.path}>
                <div className={`sidebar-flower-row is-project${isActiveProject ? " is-current" : ""}`}>
                  <ContextMenuTrigger render={<button type="button" className="sidebar-flower-main" disabled={busyProject === project.path} aria-current={isActiveProject ? "true" : undefined} onClick={() => { if (!isActiveProject) void chooseProject(project.path); else setProjectExpanded(project.path, !isExpanded); }} />}>
                    <Icon name={isExpanded ? "folder-open" : "folder-simple"} /><span title={project.path}>{project.name}</span>{busyProject === project.path && <i className="session-working-indicator" aria-hidden />}
                  </ContextMenuTrigger>
                  <Button className="sidebar-project-new" title={`在 ${project.name} 新建会话`} aria-label={`在 ${project.name} 新建会话`} disabled={busyProject === project.path} onClick={event => { event.preventDefault(); event.stopPropagation(); void newSession(project.path); }}><Icon name="plus-circle" /></Button>
                  <ProjectActions project={project} homeDir={homeDir} taskCount={merged.sessions.length} onEdit={() => setEditingProject(project)} onRemove={() => setDeletingProject(project)} />
                </div>
                <ContextMenuContent className="w-52"><ContextMenuItem onClick={() => void chooseProject(project.path)}><Icon name="folder-simple" />打开项目</ContextMenuItem><ContextMenuItem onClick={() => void newSession(project.path)}><Icon name="note-pencil" />新建会话</ContextMenuItem><ContextMenuItem onClick={() => setEditingProject(project)}><Icon name="gear-six" />编辑项目</ContextMenuItem><ContextMenuItem onClick={() => void navigator.clipboard.writeText(project.path)}><Icon name="copy" />复制路径</ContextMenuItem><ContextMenuSeparator /><ContextMenuItem variant="destructive" onClick={() => setDeletingProject(project)}><Icon name="trash" />移除项目</ContextMenuItem></ContextMenuContent>
              </ContextMenu>];
              if (isExpanded) {
                for (const session of sessions) {
                  const working = liveSessions.some(live => live.cwd === project.path && live.running && live.path === session.path);
                  const label = session.name || session.firstMessage || "未命名会话";
                  const active = isActiveProject && session.path === currentSessionFile;
                  rows.push(<ContextMenu key={session.id}>
                    <ContextMenuTrigger render={<div className={`sidebar-flower-row is-session${active ? " is-active" : ""}${working ? " working" : ""}`} />}>
                      <button type="button" className="sidebar-flower-main" aria-busy={working} onClick={() => void openSession(project.path, session)}>{working ? <span className="session-working-indicator" title="正在工作" aria-hidden /> : <Icon name={sessionGlyph(session.icon)} className="recent-session-glyph" />}<span className="recent-session-title">{label}</span></button>
                      {merged.listedPaths.has(session.path) && <button type="button" className="recent-session-delete" title="删除会话" aria-label={`删除会话 ${label}`} onClick={event => { event.stopPropagation(); setDeletingSession({ session, projectPath: project.path }); }}><Icon name="trash" /></button>}
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-52"><ContextMenuItem onClick={() => void openSession(project.path, session)}><Icon name="chats" />打开会话</ContextMenuItem><ContextMenuItem onClick={() => void navigator.clipboard.writeText(label)}><Icon name="copy" />复制标题</ContextMenuItem>{merged.listedPaths.has(session.path) && <><ContextMenuSeparator /><ContextMenuItem variant="destructive" onClick={() => setDeletingSession({ session, projectPath: project.path })}><Icon name="trash" />删除会话</ContextMenuItem></>}</ContextMenuContent>
                  </ContextMenu>);
                }
                if (merged.sessions.length > SESSION_PREVIEW) rows.push(<button key={`${project.path}-more`} type="button" className="sidebar-flower-row is-session sidebar-flower-more" onClick={() => toggleMore(project.path)}><span className="sidebar-flower-main"><Icon name={showAll ? "caret-up" : "caret-down"} /><span>{showAll ? "收起" : "展示更多"}</span></span></button>);
              }
              return rows;
            })}
            {!visibleProjects.length && <div className="sidebar-project-empty"><span>添加项目后，会话会按目录显示。</span></div>}
          </div>
        </div>
      </div>

      <div className="sidebar-bottom">
        <div className="sidebar-bottom-row">
          <Button className="nav-item" onClick={() => { useWorkspace.getState().set({ panel: "settings", settingsPage: "general" }); onNavigate?.(); }}><Icon name="gear-six" />设置<kbd>⌘ ,</kbd></Button>
          {updateOffer && <Button variant="outline" className={`sidebar-update-button${updateInstalling ? " is-installing" : ""}`} title={updateInstalling ? "正在更新 Orbit" : `下载并安装 Orbit ${updateVersion}`} aria-busy={updateInstalling} disabled={updateInstalling} onClick={() => void installDesktopUpdate()}>更新</Button>}
        </div>
      </div>
    </aside>
    <DeleteSessionDialog open={Boolean(deletingSession)} sessionName={deletingSession?.session.name || deletingSession?.session.firstMessage || "未命名会话"} onCancel={() => setDeletingSession(null)} onConfirm={() => void deleteSelectedSession()} />
    {editingProject && <ProjectEditorDialog key={editingProject.path} project={editingProject} homeDir={homeDir} onClose={() => setEditingProject(null)} onSave={saveProject} />}
    <Modal open={Boolean(deletingProject)} title="移除项目" onCancel={() => setDeletingProject(null)} onOk={() => void removeSelectedProject()} okText="移除" cancelText="取消" destructive><div className="remove-workspace-copy"><strong>{deletingProject?.name}</strong><code>{deletingProject?.path}</code><p>只会从侧栏移除，不会删除磁盘文件。</p></div></Modal>
  </div>;
}
