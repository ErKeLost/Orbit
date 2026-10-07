import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../../lib/store";
import { useProjects } from "../../lib/projects";
import { useGithubInbox, useGitlabInbox, useGithubStatus, useGitlabStatus, gitlabConnect, gitlabDisconnect, type InboxItem } from "../../lib/inbox";
import { report } from "../../lib/rpc";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { Group, PageHeader, Row, SecondaryButton, TextField } from "../../shared/ui/controls";
import { BellOff, ChevronRight, CircleAlert, GitMerge, Inbox as InboxIcon, Loader, RefreshCw, Search } from "../../shared/ui/icons";
import { ProjectMascot } from "../shell/ProjectMascot";
import { projectColor } from "../shell/chrome";

const time = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function relativeStamp(iso: string) {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return "";
  const minutes = Math.round((value - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return time.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return time.format(hours, "hour");
  return time.format(Math.round(hours / 24), "day");
}

function SourceMark({ source }: { source: "github" | "gitlab" }) {
  if (source === "github") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0 fill-current">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 shrink-0">
      <path d="M12 21.4 8.6 10.9h6.8L12 21.4ZM12 21.4 7.5 10.9H2.1L12 21.4ZM2.1 10.9 1 14.2c-.1.3 0 .7.3.9l10.7 6.3-9.9-10.5ZM2.1 10.9h5.4L5.2 4.1c-.1-.4-.6-.4-.7 0l-2.4 6.8ZM12 21.4l4.5-10.5h5.4L12 21.4ZM21.9 10.9 23 14.2c.1.3 0 .7-.3.9L12 21.4l9.9-10.5ZM21.9 10.9h-5.4l2.3-6.8c.1-.4.6-.4.7 0l2.4 6.8ZM12 21.4l3.4-10.5H8.6L12 21.4Z" fill="#fc6d26" />
    </svg>
  );
}

function ItemRow({ item, active, onSelect }: { item: InboxItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full flex-col gap-0.5 border-b border-content/5 px-3.5 py-2.5 text-left last:border-b-0 ${
        active ? "bg-selection text-content" : "hover:bg-content/5"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {item.kind === "issue" ? (
          <CircleAlert className="size-3.5 shrink-0 text-emerald-400" strokeWidth={1.75} />
        ) : (
          <GitMerge className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.title}</span>
        <span className="shrink-0 text-[11px] text-content/40">{relativeStamp(item.updated)}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2 pl-5.5 text-[11px] text-content/45">
        <span className="min-w-0 truncate">{item.repo}</span>
        <span className="shrink-0 rounded bg-content/8 px-1.5 py-px text-[10px] font-medium tracking-wide">{item.state}</span>
      </span>
    </button>
  );
}

function Detail({ item }: { item: InboxItem | null }) {
  if (!item) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-content/40">
        <InboxIcon className="size-6" strokeWidth={1.5} />
        <p className="text-[13px]">选择一项查看</p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none px-6 py-6">
        <PageHeader title={item.title} />
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-content/50">
          <span className="rounded-md bg-content/8 px-2 py-0.5 text-[11px] font-medium">
            {item.kind === "issue" ? "Issue" : item.kind === "mr" ? "合并请求" : "Pull Request"}
          </span>
          <span className="font-mono">{item.repo}</span>
          <span>#{item.id.split("#").at(-1)}</span>
          {item.author ? <span>· {item.author}</span> : null}
          <span>· {relativeStamp(item.updated)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stroke px-4 py-2.5">
        <button
          type="button"
          onClick={() => void openUrl(item.url).catch(report)}
          className="h-7 rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/80"
        >
          在浏览器打开
        </button>
      </div>
    </div>
  );
}

/** Shown instead of a bare error when the source has no connection yet. */
function NotConnected({ source }: { source: "github" | "gitlab" }) {
  const name = source === "github" ? "GitHub" : "GitLab";
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-content/6">
        <span className="scale-[1.6]"><SourceMark source={source} /></span>
      </span>
      <div>
        <p className="text-[13px] font-medium text-content">尚未连接 {name}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-content/45">
          {source === "github"
            ? "在终端用 gh auth login 登录后即可在此查看 Pull Request 与 Issue。"
            : "在设置里填写实例地址和 Access Token 后即可在此查看合并请求。"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => useWorkspace.getState().set({ panel: "settings", settingsPage: "inbox" })}
        className="h-7 rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/80"
      >
        打开连接设置
      </button>
    </div>
  );
}

/** MonoCode's Inbox: source tab strip + filterable list + detail pane. */
export function InboxView() {
  const [source, setSource] = useState<"github" | "gitlab">("github");
  const [filter, setFilter] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const github = useGithubInbox();
  const gitlab = useGitlabInbox();
  const githubStatus = useGithubStatus();
  const gitlabStatus = useGitlabStatus();
  const active = source === "github" ? github : gitlab;
  const connected = source === "github" ? githubStatus.data?.connected === true : gitlabStatus.data?.connected === true;
  const connectionKnown = source === "github" ? githubStatus.data != null : gitlabStatus.data != null;
  const items = active.data ?? [];
  const visible = items.filter((item) => !filter.trim() || `${item.title} ${item.repo} ${item.author}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const selected = items.find((item) => item.id === activeId) ?? null;

  return (
    <div role="region" aria-label="Inbox" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region>
        <InboxIcon className="size-4 shrink-0 text-content/60" strokeWidth={1.75} />
        <span className="text-[13px] font-medium">收件箱</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-r border-stroke">
          <div className="flex shrink-0 items-center gap-2 border-b border-stroke px-2 py-2">
            <div role="tablist" aria-label="Inbox 来源" className="flex min-w-0 flex-1 items-center gap-px">
              {(["github", "gitlab"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={source === tab}
                  onClick={() => setSource(tab)}
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
            <button
              type="button"
              title="刷新"
              aria-label="刷新"
              disabled={active.isFetching}
              onClick={() => void active.refetch()}
              className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
            >
              {active.isFetching ? <Loader className="size-3.5 animate-spin" /> : <RefreshCw className="size-3" strokeWidth={1.75} />}
            </button>
          </div>
          <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto overscroll-none">
            {!connected && connectionKnown ? <NotConnected source={source} /> : null}
            {connected && active.error ? <p className="px-3 py-2 text-[12px] text-red-400">{String(active.error)}</p> : null}
            {connected && !active.error && visible.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-content/50">
                {active.isFetching ? "读取中…" : filter ? "没有匹配的 Issue 或 Pull Request" : "暂无待处理"}
              </p>
            ) : null}
            {visible.map((item) => (
              <ItemRow key={item.id} item={item} active={item.id === activeId} onSelect={() => setActiveId(item.id)} />
            ))}
          </div>
        </div>
        <Detail item={selected} />
      </div>
    </div>
  );
}

/** Inbox settings: connection cards for GitHub (gh CLI) and GitLab (PAT). */
export function InboxSettings() {
  const github = useGithubStatus();
  const gitlab = useGitlabStatus();
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await gitlabConnect(host, token);
      setToken("");
      await gitlab.refetch();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  };

  const { projects } = useProjects();
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceProjects = [...new Set([...(cwd && cwd !== homeDir ? [cwd] : []), ...projects.map((p) => p.path)])];
  const mutedKey = (path: string) => `orbit.inboxMuted.${path}`;
  const muted = workspaceProjects.filter((path) => localStorage.getItem(mutedKey(path)) === "true");

  return (
    <>
      <Group
        title="项目通知"
        description="按分类选择声音、横幅与侧栏提示。静音只是暂停，不会改动你的选择；未读项仍会在收件箱标记。"
        action={<SecondaryButton onClick={() => useWorkspace.getState().set({ panel: "chat" })}>选择项目</SecondaryButton>}
      >
        {workspaceProjects.map((path) => {
          const name = projects.find((p) => p.path === path)?.name ?? path.split("/").filter(Boolean).at(-1) ?? path;
          const isMuted = localStorage.getItem(mutedKey(path)) === "true";
          return (
            <div key={path} className="flex items-center gap-3 border-b border-content/5 px-4 py-3 last:border-b-0">
              <ProjectMascot project={path} color={projectColor(path)} className="size-4" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-content">{name}</div>
                <div className="truncate text-[12px] text-content/45">
                  {isMuted ? `已静音 ${muted.length > 1 ? `· 共 ${muted.length} 个` : ""}` : "本地项目 · 全部分类已启用"}
                </div>
              </div>
              <ChevronRight className="size-3.5 shrink-0 text-content/35" strokeWidth={1.75} />
              <SecondaryButton
                onClick={() => {
                  localStorage.setItem(mutedKey(path), isMuted ? "false" : "true");
                  useWorkspace.getState().set({ notices: [] });
                  setHost((h) => h);
                }}
              >
                <BellOff className="size-3.5" strokeWidth={1.75} />
                {isMuted ? "取消静音" : "静音"}
              </SecondaryButton>
            </div>
          );
        })}
        {workspaceProjects.length === 0 ? <p className="px-4 py-3.5 text-[12px] text-content/45">还没有项目。</p> : null}
      </Group>
      <Group title={<span className="inline-flex items-center gap-2"><SourceMark source="github" />GitHub</span>} description="通过 GitHub CLI 读取的 Pull Request、评审与 Issue。">
        <Row
          label="连接"
          description={
            github.data?.connected
              ? "GitHub CLI 已安装并登录，收件箱用它读取 GitHub 条目。"
              : github.data?.installed
                ? "GitHub CLI 已安装但未登录。在终端运行 `gh auth login` 后重新检查。"
                : "未安装 GitHub CLI（gh）。安装并登录后，Inbox 会自动读取。"
          }
        >
          <span className="text-[12px] text-content/55">{github.data?.connected ? "已连接" : github.isFetching ? "检查中…" : "未连接"}</span>
          <SecondaryButton onClick={() => void github.refetch()}>重新检查</SecondaryButton>
        </Row>
      </Group>
      <Group title={<span className="inline-flex items-center gap-2"><SourceMark source="gitlab" />GitLab</span>} description="来自 GitLab.com 或自建实例的合并请求。">
        {gitlab.data?.connected ? (
          <Row label="连接" description={`已连接 ${gitlab.data.host ?? "GitLab"}。Token 保存在本机，断开即删除。`}>
            <span className="text-[12px] text-content/55">Connected</span>
            <SecondaryButton
              danger
              onClick={() => {
                void gitlabDisconnect()
                  .then(() => gitlab.refetch())
                  .catch(report);
              }}
            >
              Disconnect
            </SecondaryButton>
          </Row>
        ) : (
          <Row
            label="连接"
            description="连接 GitLab.com 或自建实例。请使用带 API 权限的 Personal Access Token；Token 只保存在本机，断开即删除。"
          >
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
              <TextField
                className="!w-52"
                placeholder="https://gitlab.com"
                aria-label="GitLab 地址"
                value={host}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setHost(event.target.value)}
              />
              <TextField
                className="!w-40"
                type="password"
                placeholder="glpat-…"
                aria-label="GitLab Access Token"
                value={token}
                autoComplete="off"
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setToken(event.target.value)}
              />
              <SecondaryButton disabled={busy || !token.trim()} onClick={() => void connect()}>
                {busy ? "连接中…" : "连接"}
              </SecondaryButton>
            </div>
          </Row>
        )}
        {error ? <p className="px-4 pb-3.5 text-[12px] text-red-400">{error}</p> : null}
      </Group>
    </>
  );
}
