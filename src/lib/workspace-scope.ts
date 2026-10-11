import { projectExtraRoots, useProjects } from "./projects";
import { connect, setSessionRoots } from "./rpc";
import { useWorkspace, type WorkspaceMode } from "./store";

/**
 * 从 UI（项目栏、composer 的范围选择器）切到一个工作范围：注册的项目，或
 * 「不在文件夹里工作」的主目录（home 模式）。
 *
 * 已在同一个范围且连接在线时是 no-op——重复点击仍然算一次「要用它」的请求
 * （连接掉线时会重新连），但同一范围内的在线重复切换不会打断会话。项目模式
 * 会顺带同步项目的附加 roots，让会话状态立刻拿到最新的目录列表。
 */
export async function openWorkspaceScope(path: string, mode: WorkspaceMode) {
  const workspace = useWorkspace.getState();
  if (workspace.cwd === path && workspace.workspaceMode === mode && workspace.connection === "online") return;
  await connect(path, mode);
  if (mode !== "project") return;
  const project = useProjects.getState().projects.find((item) => item.path === path);
  if (project) await setSessionRoots(projectExtraRoots(project));
}
