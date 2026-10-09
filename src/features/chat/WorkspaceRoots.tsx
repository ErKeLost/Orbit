import { useMemo } from "react";
import { useWorkspace } from "../../lib/store";
import { useGitBranches } from "../../lib/git";
import { workspaceExtraRootList } from "../../lib/workspace-roots";
import { useProjects } from "../../lib/projects";
import { Folder } from "../../shared/ui/icons";
import { BranchPicker } from "./BranchPicker";

/**
 * Composer 顶部的 workspace 列表（Orbit `CwdLabel` + `GitPickerTrigger` 的
 * 多 root 版）。
 *
 * 主 checkout 沿用原来的形态（"Current checkout" + 分支选择器）；每个附加
 * root 是一组更安静的「目录名 + 自己的分支选择器」——分支切换对附加 root
 * 一样可用，因为 `BranchPicker` 本来就按 cwd 工作。
 *
 * root 列表来自 `workspaceExtraRootList`：会话状态优先、项目配置兜底，所以
 * 编辑项目 roots 后立刻可见，不等下一次同步。
 */

function RootLabel({ cwd, home }: { cwd: string; home: boolean }) {
  const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
  return (
    <span
      title={cwd}
      className={`-ml-1.5 flex h-6 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-[12px] ${home ? "max-w-48 text-content/55" : "max-w-40 text-content/40"}`}
    >
      <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate">{home ? (name ? "Current checkout" : "No folder") : name}</span>
    </span>
  );
}

function ComposerRoot({ cwd, home = false, disabled }: { cwd: string; home?: boolean; disabled: boolean }) {
  const branches = useGitBranches(cwd).data;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <RootLabel cwd={cwd} home={home} />
      <BranchPicker cwd={cwd} current={branches?.current ?? null} disabled={disabled} />
    </div>
  );
}

export function WorkspaceRoots({ projectFolder, disabled }: { projectFolder: string; disabled: boolean }) {
  const statuses = useWorkspace((state) => state.statuses);
  const projects = useProjects((state) => state.projects);
  const roots = useMemo(
    () => workspaceExtraRootList(projectFolder, statuses, projects),
    [projectFolder, statuses, projects],
  );
  if (!projectFolder) return null;
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5" data-workspace-roots>
      <ComposerRoot cwd={projectFolder} home disabled={disabled} />
      {roots.map((root) => (
        <ComposerRoot key={root} cwd={root} disabled={disabled} />
      ))}
    </div>
  );
}
