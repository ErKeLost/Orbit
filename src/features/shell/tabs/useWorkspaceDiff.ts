import { useWorkspace } from "../../../lib/store";
import { useGitHead } from "../../source-control/hooks/useGitHead";

/**
 * 当前工作区 checkout 的 diff 索引。顶栏的「有未提交改动」点和右栏的变更数
 * 读同一份轮询，所以这个 checkout 只有一个 git 进程在跑。
 */
export function useWorkspaceDiff() {
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const online = useWorkspace((state) => state.connection === "online");
  const project = cwd && cwd !== homeDir ? cwd : "";
  return useGitHead(project, Boolean(project) && online);
}
