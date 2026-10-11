import { useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspace } from "../../lib/store";
import { activeProjects, derivedProjectColor, projectColor, sortPinnedFirst, useProjects } from "../../lib/projects";
import { changeSession, connect, report } from "../../lib/rpc";
import { useGitDiffStats } from "../../lib/git";
import {
  FileDiff,
  Folder,
  FolderOpen,
  FolderTree,
  Inbox as InboxIcon,
  File,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Settings,
  SmartPhone,
  Zap,
  type IconComponent,
} from "../../shared/ui/icons";
import { MOD, IS_MAC } from "./chrome";
import { useShell, type SidebarTab } from "./shellStore";
import { toast } from "../../shared/ui/toast";

/**
 * 收起态的项目栏：参照 monocode 的 CompactProjectRail——一列 32px 图标，
 * 上层是工作区切换与导航动作，中间是项目，底部是新会话与设置。任意图标
 * 都能回到完整功能，收起只是把列表藏起来，不削减入口。
 */

function CompactRailAction({
  label,
  icon: Icon,
  tab = false,
  active = false,
  dot = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: IconComponent;
  tab?: boolean;
  active?: boolean;
  dot?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role={tab ? "tab" : undefined}
      title={label}
      aria-label={label}
      aria-selected={tab ? active : undefined}
      aria-pressed={tab ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      className={`relative grid size-8 shrink-0 place-items-center rounded-md active:scale-[0.97] disabled:cursor-default disabled:opacity-35 ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/10 hover:text-content"
      }`}
    >
      <Icon className={`size-4 ${dot ? "compact-rail-icon-with-dot" : ""}`} strokeWidth={1.75} />
      {dot ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" /> : null}
    </button>
  );
}

/** 与展开侧栏一致的三个工作区标签；点击会同时把侧栏拉出来。 */
const WORKSPACE_TABS: { id: SidebarTab; label: string; icon: IconComponent }[] = [
  { id: "sessions", label: "会话", icon: MessageSquare },
  { id: "files", label: "文件", icon: FolderTree },
  { id: "changes", label: "变更", icon: FileDiff },
];

/** 与展开项目栏一致的导航面板（设置里可撤下的那组）。 */
const NAV_PANELS: { id: "inbox" | "notes" | "automations" | "mobile-access"; label: string; icon: IconComponent }[] = [
  { id: "inbox", label: "收件箱", icon: InboxIcon },
  { id: "notes", label: "笔记", icon: File },
  { id: "automations", label: "自动化", icon: Zap },
  { id: "mobile-access", label: "移动端", icon: SmartPhone },
];

export function CompactRail() {
  const cwd = useWorkspace((state) => state.cwd);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const homeDir = useWorkspace((state) => state.homeDir);
  const online = useWorkspace((state) => state.connection === "online");
  const panel = useWorkspace((state) => state.panel);
  const liveSessions = useWorkspace((state) => state.liveSessions);
  const { projects } = useProjects();
  const sidebarOpen = useShell((state) => state.sessionSidebarOpen);
  const sidebarTab = useShell((state) => state.sidebarTab);
  const setProjectRailOpen = useShell((state) => state.setProjectRailOpen);
  const withSessions = workspaceMode === "project" && Boolean(cwd) && cwd !== homeDir;
  const running = new Set(liveSessions.filter((session) => session.running).map((session) => session.cwd));
  const sortedProjects = useMemo(() => sortPinnedFirst(activeProjects(projects)), [projects]);
  const stats = useGitDiffStats(withSessions ? cwd : undefined, !sidebarOpen).data;
  const hasChanges = (stats?.files ?? 0) > 0;
  const chromeless = panel === "settings" || panel === "inbox" || panel === "search" || panel === "automations" || panel === "mobile-access" || panel === "notes";

  const openWorkspaceTab = (next: SidebarTab) => {
    // 先退出当前全屏面板（搜索/设置等），否则侧栏被 chromeless 规则藏著，
    // 点了标签也看不到任何变化（monocode 的 onLeaveActive 行为）。
    useWorkspace.getState().set({ panel: "chat" });
    const shell = useShell.getState();
    shell.setSessionSidebarOpen(true);
    shell.setSidebarTab(next);
  };

  const togglePanel = (id: "inbox" | "notes" | "automations" | "mobile-access") => {
    useWorkspace.getState().set({ panel: panel === id ? "chat" : id });
  };

  const newSession = () => {
    useWorkspace.getState().set({ panel: "chat" });
    void (async () => {
      // Pi 只在活的 worker 上接受新会话，掉线时先重连。
      const state = useWorkspace.getState();
      if (state.connection !== "online" && state.cwd) await connect(state.cwd, "project");
      await changeSession({ type: "new_session" });
    })().catch(report);
  };

  return (
    <nav
      aria-label="项目快捷方式"
      data-compact-project-rail
      className={`sidebar-glass relative flex h-full w-12 shrink-0 flex-col items-center ${IS_MAC ? "pt-10" : ""}`}
    >
      <span aria-hidden className="pointer-events-none absolute bottom-0 right-0 top-0 w-px bg-stroke" />

      {/* 上层：展开、工作区标签、搜索、导航面板 */}
      <div className="flex w-full shrink-0 flex-col items-center gap-1.5 py-1.5">
        <CompactRailAction label="展开项目栏" icon={PanelLeft} onClick={() => setProjectRailOpen(true)} />
        {withSessions ? (
          <div role="tablist" aria-label="Workspace" aria-orientation="vertical" className="flex flex-col items-center gap-1.5">
            {WORKSPACE_TABS.map((item) => (
              <CompactRailAction
                key={item.id}
                tab
                label={item.label}
                icon={item.icon}
                active={!chromeless && sidebarOpen && sidebarTab === item.id}
                dot={item.id === "changes" && hasChanges}
                onClick={() => openWorkspaceTab(item.id)}
              />
            ))}
          </div>
        ) : null}
        <CompactRailAction
          label={`搜索 (${MOD}K)`}
          icon={Search}
          active={panel === "search"}
          onClick={() => useWorkspace.getState().set({ panel: panel === "search" ? "chat" : "search" })}
        />
        {NAV_PANELS.map((item) => (
          <CompactRailAction
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={panel === item.id}
            onClick={() => togglePanel(item.id)}
          />
        ))}
      </div>

      <span aria-hidden className="h-px w-6 shrink-0 bg-stroke" />

      {/* 中段：项目 + 添加，放得下就全展示，放不下滚动 */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1.5">
        {sortedProjects.map((project) => {
          const selected = workspaceMode === "project" && project.path === cwd;
          return (
            <button
              key={project.path}
              type="button"
              title={`${project.name}\n${project.path}`}
              aria-label={project.name}
              aria-current={selected ? "true" : undefined}
              onClick={() => {
                if (selected) {
                  setProjectRailOpen(true);
                  return;
                }
                void connect(project.path, "project").catch(report);
              }}
              className={`relative grid size-8 shrink-0 place-items-center rounded-md active:scale-[0.97] ${
                selected ? "bg-selection-strong text-content" : "text-content/70 opacity-65 hover:bg-content/10 hover:opacity-100"
              }`}
            >
              {/* Logo 图片优先，否则文件夹图标（选中 = 打开态）。 */}
              {project.logoPath ? (
                <img src={convertFileSrc(project.logoPath)} alt="" className="size-5 rounded object-cover" />
              ) : (
                <span className="grid place-items-center" style={{ color: projectColor(project) ?? derivedProjectColor(project.path) }}>
                  {selected ? (
                    <FolderOpen className="size-4" strokeWidth={1.75} />
                  ) : (
                    <Folder className="size-4" strokeWidth={1.75} />
                  )}
                </span>
              )}
              {running.has(project.path) ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" /> : null}
            </button>
          );
        })}
        <button
          type="button"
          title="添加项目"
          aria-label="添加项目"
          onClick={() => {
            setProjectRailOpen(true);
            toast.info("在展开的项目栏里点击 + 添加项目");
          }}
          className="grid size-8 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content active:scale-[0.97]"
        >
          <Plus className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      {/* 底部：新会话、设置 */}
      <div className="flex w-full shrink-0 flex-col items-center gap-1 py-1.5">
        <CompactRailAction
          label={`新会话 (${MOD}N)`}
          icon={MessageSquare}
          disabled={!online && !cwd}
          onClick={newSession}
        />
        <CompactRailAction
          label={`设置 (${MOD},)`}
          icon={Settings}
          active={panel === "settings"}
          onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "general" })}
        />
      </div>
    </nav>
  );
}
