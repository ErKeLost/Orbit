import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import {
  githubRepo,
  gitlabRepo,
  listGitlabTodos,
  listGitlabWorkItems,
  listGithubWorkItems,
  useGithubStatus,
  useGitlabStatus,
  GITLAB_CHANGE_EVENT,
  type InboxProvider,
  type WorkItemKind,
} from "../../lib/inbox";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { TrafficLightSpacer } from "../shell/chrome";
import {
  Inbox as InboxIcon,
  Eye,
  Loader,
  RefreshCw,
  Search,
} from "../../shared/ui/icons";
import { firstInboxError, isAnyFetching, selectActiveRow, selectInboxRows } from "./model/inboxView";
import { InboxRow, NotConnected, SourceMark } from "./ui/InboxList";
import { DetailPane } from "./ui/InboxDetail";

export { InboxSettings } from "./ui/InboxSettings";

type Source = InboxProvider;

export function InboxView() {
  const workspaceCwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const project = workspaceMode === "project" && workspaceCwd && workspaceCwd !== homeDir ? workspaceCwd : "";
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source>("github");
  const [filter, setFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | WorkItemKind>("all");
  const [assignedOnly, setAssignedOnly] = useState(true);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();

  const githubStatusQ = useGithubStatus();
  const gitlabStatusQ = useGitlabStatus();
  const githubConnected = githubStatusQ.data?.connected === true;
  const gitlabConnected = gitlabStatusQ.data?.connected === true;
  const connected = source === "github" ? githubConnected : gitlabConnected;
  const connectionKnown =
    source === "github" ? githubStatusQ.isSuccess : gitlabStatusQ.isSuccess;

  useEffect(() => {
    const onChange = () => void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    window.addEventListener(GITLAB_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(GITLAB_CHANGE_EVENT, onChange);
  }, [queryClient]);

  // GitHub: repository for the current project, then open issues + PRs.
  const ghRepoQ = useQuery({
    queryKey: ["inbox", "gh-repo", project],
    queryFn: () => githubRepo(project),
    enabled: source === "github" && connected && !!project,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const ghIssueQ = useQuery({
    queryKey: ["inbox", "list", "github", "issue", project, assignedOnly, filter],
    queryFn: () =>
      listGithubWorkItems(project, ghRepoQ.data!, {
        kind: "issue",
        assignedToMe: assignedOnly,
        state: "open",
        search: filter,
        limit: 30,
      }),
    enabled: source === "github" && connected && !!project && ghRepoQ.isSuccess,
    refetchInterval: 120_000,
  });
  const ghPrQ = useQuery({
    queryKey: ["inbox", "list", "github", "pr", project, assignedOnly, filter],
    queryFn: () =>
      listGithubWorkItems(project, ghRepoQ.data!, {
        kind: "pr",
        assignedToMe: assignedOnly,
        state: "open",
        search: filter,
        limit: 30,
      }),
    enabled: source === "github" && connected && !!project && ghRepoQ.isSuccess,
    refetchInterval: 120_000,
  });

  // GitLab: pending todos across every project + assigned MRs/issues for this one.
  const glTodoIssueQ = useQuery({
    queryKey: ["inbox", "list", "gitlab", "todo-issue"],
    queryFn: () => listGitlabTodos({ kind: "issue", limit: 30 }),
    enabled: source === "gitlab" && connected,
    refetchInterval: 120_000,
  });
  const glTodoPrQ = useQuery({
    queryKey: ["inbox", "list", "gitlab", "todo-pr"],
    queryFn: () => listGitlabTodos({ kind: "pr", limit: 30 }),
    enabled: source === "gitlab" && connected,
    refetchInterval: 120_000,
  });
  const glRepoQ = useQuery({
    queryKey: ["inbox", "gl-repo", project],
    queryFn: () => gitlabRepo(project),
    enabled: source === "gitlab" && connected && !!project,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const glMrQ = useQuery({
    queryKey: ["inbox", "list", "gitlab", "mr", project],
    queryFn: () =>
      listGitlabWorkItems(project, { kind: "pr", assignedToMe: true, state: "opened" as unknown as "open", limit: 30 }),
    enabled: source === "gitlab" && connected && !!project && glRepoQ.isSuccess,
    refetchInterval: 120_000,
  });
  const glIssueQ = useQuery({
    queryKey: ["inbox", "list", "gitlab", "issue", project],
    queryFn: () =>
      listGitlabWorkItems(project, { kind: "issue", assignedToMe: true, state: "opened" as unknown as "open", limit: 30 }),
    enabled: source === "gitlab" && connected && !!project && glRepoQ.isSuccess,
    refetchInterval: 120_000,
  });

  const rows = useMemo(
    () =>
      selectInboxRows(source, project, kindFilter, {
        github: [ghIssueQ.data, ghPrQ.data],
        gitlab: [glTodoIssueQ.data, glTodoPrQ.data, glMrQ.data, glIssueQ.data],
      }),
    [source, project, kindFilter, ghIssueQ.data, ghPrQ.data, glTodoIssueQ.data, glTodoPrQ.data, glMrQ.data, glIssueQ.data],
  );

  const listError =
    source === "github"
      ? firstInboxError([ghRepoQ.error, ghIssueQ.error, ghPrQ.error])
      : firstInboxError([glTodoIssueQ.error, glTodoPrQ.error, glRepoQ.error, glMrQ.error, glIssueQ.error]);
  const fetching =
    source === "github"
      ? isAnyFetching([ghRepoQ.isFetching, ghIssueQ.isFetching, ghPrQ.isFetching])
      : isAnyFetching([
          glTodoIssueQ.isFetching,
          glTodoPrQ.isFetching,
          glRepoQ.isFetching,
          glMrQ.isFetching,
          glIssueQ.isFetching,
        ]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  };

  const selected = selectActiveRow(rows, activeKey);

  const needProject = source === "github" && connected && !project;

  return (
    <div role="region" aria-label="Inbox" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region="deep">
        <TrafficLightSpacer />
        <InboxIcon className="size-4 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="text-[13px] font-medium">收件箱</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 w-[340px] shrink-0 flex-col border-r border-stroke">
          <div className="flex shrink-0 items-center gap-2 border-b border-stroke px-2 py-2">
            <div role="tablist" aria-label="Inbox 来源" className="flex min-w-0 flex-1 items-center gap-px">
              {(["github", "gitlab"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={source === tab}
                  onClick={() => {
                    setSource(tab);
                    setActiveKey(null);
                  }}
                  className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] ${
                    source === tab ? "bg-selection text-content" : "text-content/50 hover:text-content"
                  }`}
                >
                  <SourceMark source={tab} />
                  {tab === "github" ? "GitHub" : "GitLab"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "inbox" })}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-content/50 hover:bg-content/10 hover:text-content"
            >
              添加连接
            </button>
          </div>
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
            <div className="relative flex h-7 min-w-0 flex-1 items-center">
              <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选 Inbox"
                aria-label="筛选列表"
                className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pl-7 pr-2 text-[12px] outline-none placeholder:text-content/35"
              />
            </div>
            <div role="radiogroup" aria-label="类型过滤" className="flex shrink-0 items-center gap-px rounded-md bg-content/5 p-0.5">
              {([["all", "全部"], ["issue", "Issue"], ["pr", "PR"]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kindFilter === value}
                  onClick={() => setKindFilter(value)}
                  className={`h-6 rounded px-1.5 text-[11px] ${
                    kindFilter === value ? "bg-selection text-content" : "text-content/50 hover:text-content"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              title={assignedOnly ? "只看指派给我的" : "看全部"}
              aria-label={assignedOnly ? "只看指派给我的" : "看全部"}
              onClick={() => setAssignedOnly((on) => !on)}
              className={`grid size-6 shrink-0 place-items-center rounded-md ${
                assignedOnly ? "bg-selection text-content" : "text-content/50 hover:bg-content/10 hover:text-content"
              }`}
            >
              <Eye className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              title="刷新"
              aria-label="刷新"
              disabled={fetching}
              onClick={refresh}
              className="grid size-6 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
            >
              {fetching ? <Loader className="size-3.5 animate-spin" /> : <RefreshCw className="size-3" strokeWidth={1.75} />}
            </button>
          </div>
          <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto overscroll-none">
            {!connected && connectionKnown ? <NotConnected source={source} /> : null}
            {connected && needProject ? (
              <p className="px-3 py-3 text-[12px] leading-relaxed text-content/50">
                先打开一个 GitHub 项目，收件箱会读取这个项目里指派给你和为你保留的 Issue / Pull Request。
              </p>
            ) : null}
            {connected && !needProject && listError ? (
              <p className="px-3 py-2 text-[12px] text-red-400">{String(listError)}</p>
            ) : null}
            {connected && !needProject && !listError && rows.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-content/50">
                {fetching ? "读取中…" : "暂无待处理"}
              </p>
            ) : null}
            {rows.map((item) => (
              <InboxRow key={item.key} item={item} active={item.key === activeKey} onSelect={() => setActiveKey(item.key)} />
            ))}
          </div>
        </div>
        {selected ? (
          <DetailPane
            key={selected.key}
            provider={selected.provider}
            cwd={project}
            item={selected}
            onBack={() => setActiveKey(null)}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-content/40">
            <InboxIcon className="size-6" strokeWidth={1.5} />
            <p className="text-[13px]">选择一项查看</p>
          </div>
        )}
      </div>
    </div>
  );
}
