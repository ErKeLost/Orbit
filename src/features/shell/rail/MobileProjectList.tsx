import { useMemo, useState } from "react"
import { useWorkspace } from "../../../lib/store";
import { useProjects } from "../../../lib/projects";
import { activeProjects, derivedProjectColor, mergeProjects, projectColor, sortPinnedFirst, type Project } from "../../../lib/projects";
import { prettyCwd } from "../../../shared/lib/paths";
import { Check, Folder, Loader, Plus } from "../../../shared/ui/icons";
import { report } from "../../../lib/rpc";
import { useWorkspaceTabs } from "../use-workspace-tabs";
import { NAV, RailAction } from "../project/ProjectRail";
import { ProjectDirectoryPicker } from "../project/ProjectDirectoryPicker";

/**
 * 手机抽屉里的「项目」页。
 *
 * 桌面把切换藏在标题那行菜单的二级浮层里——指针点两下不算事，手机上要先
 * 滑出抽屉、点标题、再点「切换项目」，而且浮层一碰外面就关。手机没有这个
 * 限制：项目本来就是少数几个，一屏放得下，所以这里直接列出来，一行一个，
 * 点一下就切过去，当前那个打勾。
 *
 * 列的是电脑端的注册表（手机只镜像它，见 `useProjectRegistry`），所以这里
 * 看到的顺序和名字跟电脑上一致；新增项目也走电脑端，`ProjectDirectoryPicker`
 * 问的是那台 Mac 的目录。
 */
export function MobileProjectList({ onNavigate }: { onNavigate?: () => void }) {
  const tabs = useWorkspaceTabs();
  const projects = useProjects((state) => state.projects);
  const cwd = useWorkspace((state) => state.cwd);
  const panel = useWorkspace((state) => state.panel);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const [opening, setOpening] = useState("");
  const [picker, setPicker] = useState(false);
  const list = useMemo(
    () => sortPinnedFirst(activeProjects(mergeProjects(projects, cwd && workspaceMode === "project" ? [cwd] : []))),
    [cwd, projects, workspaceMode],
  );

  async function open(path: string) {
    setOpening(path);
    try {
      await tabs.selectProject(path, "project");
      onNavigate?.();
    } catch (error) {
      report(error);
    } finally {
      setOpening("");
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-content/40">电脑上的项目</p>
      <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain px-1.5 pb-4">
        {list.map((project) => (
          <li key={project.path}>
            <ProjectRow
              project={project}
              current={workspaceMode === "project" && project.path === cwd}
              busy={opening === project.path}
              onOpen={() => void open(project.path)}
            />
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={() => setPicker(true)}
            className="rail-row flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-content/50 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-4 shrink-0 opacity-70" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">添加项目</span>
          </button>
        </li>
      </ul>
      <p className="shrink-0 px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-content/40">工作区</p>
      <div className="flex shrink-0 flex-col gap-px px-1.5 pb-3">
        {NAV.filter((item) => item.id !== "mobile-access").map((item) => (
          <RailAction
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={panel === item.id}
            onClick={() => {
              useWorkspace.getState().set({ panel: panel === item.id ? "chat" : item.id });
              onNavigate?.();
            }}
          />
        ))}
      </div>
      {picker ? <ProjectDirectoryPicker open onClose={() => setPicker(false)} /> : null}
    </div>
  );
}

function ProjectRow({ project, current, busy, onOpen }: { project: Project; current: boolean; busy: boolean; onOpen: () => void }) {
  const color = projectColor(project) ?? derivedProjectColor(project.path);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? "true" : undefined}
      className={`rail-row flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left ${
        current ? "bg-selection text-content" : "text-content/80 hover:bg-content/8 hover:text-content"
      }`}
    >
      <Folder className="size-4 shrink-0 opacity-80" style={{ color }} strokeWidth={1.75} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-[14.5px] font-semibold leading-tight">{project.name}</span>
        <span className="min-w-0 truncate text-[11px] leading-tight text-content/45">{prettyCwd(project.path)}</span>
      </span>
      {busy ? (
        <Loader className="size-3.5 shrink-0 animate-spin text-content/45" aria-hidden />
      ) : current ? (
        <Check className="size-4 shrink-0 text-accent" strokeWidth={2} aria-label="当前项目" />
      ) : null}
    </button>
  );
}
