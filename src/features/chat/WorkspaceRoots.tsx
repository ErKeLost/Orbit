import { useMemo } from "react";
import { useWorkspace } from "../../lib/store";
import { WORKSPACE_STATUS, workspaceExtraRootList } from "../../lib/workspace-roots";
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
  // 只订阅真正参与计算的那一条状态：整个 `statuses` 对象每 5 秒都会换引用
  // （`gui-runtime` 里带着整份 systemPrompt），订阅对象等于每 5 秒白重渲一次。
  const workspaceStatus = useWorkspace((state) => state.statuses[WORKSPACE_STATUS] ?? "");
  const projects = useProjects((state) => state.projects);
  const roots = useMemo(
    () => workspaceExtraRootList(projectFolder, workspaceStatus ? { [WORKSPACE_STATUS]: workspaceStatus } : {}, projects),
    [projectFolder, workspaceStatus, projects],
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
            className="flex h-6 min-w-0 max-w-40 items-center gap-1.5 rounded-md bg-fill px-1.5 text-xs text-ink-3"
          >
            <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}
