import { useMemo } from "react";
import { useWorkspace } from "../../lib/store";
import { workspaceExtraRootList } from "../../lib/workspace-roots";
import { useProjects } from "../../lib/projects";
import { Folder } from "../../shared/ui/icons";

/**
 * Composer 顶部的附加 root 列表（多 root 版）。
 *
 * 主 checkout 不在这里重复：它已经是输入框头部的项目名了。这里只列**附加**的
 * 目录，每颗筹码悬停给出完整路径——安静但一眼看出这个会话还能读写哪几个目录。
 *
 * root 列表来自 `workspaceExtraRootList`：会话状态优先、项目配置兜底，所以
 * 编辑项目 roots 后立刻可见，不等下一次同步。
 */
export function WorkspaceRoots({ projectFolder }: { projectFolder: string; disabled?: boolean }) {
  const statuses = useWorkspace((state) => state.statuses);
  const projects = useProjects((state) => state.projects);
  const roots = useMemo(
    () => workspaceExtraRootList(projectFolder, statuses, projects),
    [projectFolder, statuses, projects],
  );
  if (!projectFolder || roots.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-workspace-roots>
      {roots.map((root) => {
        const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
        return (
          <span
            key={root}
            title={root}
            className="flex h-6 min-w-0 max-w-40 items-center gap-1.5 rounded-md bg-content/6 px-1.5 text-[12px] text-content/45"
          >
            <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}
