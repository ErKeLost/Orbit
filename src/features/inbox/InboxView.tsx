import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWorkspace } from "../../lib/store";
import { Markdown } from "../../components/Markdown";
import { report } from "../../lib/rpc";
import { toast } from "../../shared/ui/toast";
import {
  formatRelativeTime,
  githubAvatarUrl,
  githubPrAction,
  githubPrChecks,
  githubPrDiff,
  githubRepo,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  gitlabMrDiff,
  gitlabRepo,
  gitlabWorkItemComment,
  gitlabWorkItemDetails,
  gitlabWorkItemThread,
  disconnectGitlab,
  listGitlabTodos,
  listGitlabWorkItems,
  listGithubWorkItems,
  saveGitlabConfig,
  useGithubStatus,
  useGitlabStatus,
  GITLAB_CHANGE_EVENT,
  type GithubPrAction,
  type InboxProvider,
  type PrDiff,
  type PrChecks,
  type WorkItem,
  type WorkItemComment,
  type WorkItemKind,
  type WorkItemThread,
} from "../../lib/inbox";
import { mergePrDiff, parsePrPatch } from "../source-control/model/prDiff";
import { blocksFromLines, type UnifiedLine } from "../source-control/model/unifiedDiff";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "../source-control/ui/UnifiedDiffView";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { Group, PageHeader, Row, SecondaryButton, TextArea, TextField } from "../../shared/ui/controls";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CornerDownRight,
  ExternalLink,
  Eye,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Inbox as InboxIcon,
  Loader,
  MessageSquare,
  RefreshCw,
  Search,
  X,
} from "../../shared/ui/icons";

type Source = InboxProvider;
type TabId = "overview" | "discussion" | "changes" | "checks";

type RowItem = WorkItem & { key: string };

const rowKey = (item: WorkItem) => `${item.provider}:${item.repo}:${item.kind}:${item.number}`;

function SourceMark({ source }: { source: Source }) {
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

function KindIcon({ kind, state, draft, className }: { kind: WorkItemKind; state: string; draft: boolean; className?: string }) {
  if (kind === "issue") return <CircleAlert className={className ?? "size-3.5"} strokeWidth={1.75} />;
  if (draft) return <GitPullRequestDraft className={className ?? "size-3.5"} strokeWidth={1.75} />;
  if (state !== "open") return <GitPullRequestClosed className={className ?? "size-3.5"} strokeWidth={1.75} />;
  return <GitPullRequest className={className ?? "size-3.5"} strokeWidth={1.75} />;
}

function Avatar({ login, url, size = 16 }: { login: string; url?: string; size?: number }) {
  const source = url?.trim() || (login ? githubAvatarUrl(login) : "");
  const [failed, setFailed] = useState(false);
  if (!source || failed) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-full bg-content/10 text-[9px] font-semibold text-content/60"
        style={{ width: size, height: size }}
      >
        {(login || "?").slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full bg-content/10 object-cover"
    />
  );
}

const STATE_LABEL: Record<string, string> = {
  open: "打开",
  closed: "已关闭",
  merged: "已合并",
};

function StatePill({ item }: { item: WorkItem }) {
  const tone =
    item.state === "open"
      ? "text-emerald-400 bg-emerald-400/10"
      : item.state === "merged"
        ? "text-violet-400 bg-violet-400/10"
        : "text-content/50 bg-content/8";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium ${tone}`}>
      <KindIcon kind={item.kind} state={item.state} draft={item.draft} className="size-3" />
      {STATE_LABEL[item.state] ?? item.state}
    </span>
  );
}

function LabelChips({ item }: { item: WorkItem }) {
  if (item.labels.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {item.labels.slice(0, 3).map((label) => (
        <span
          key={label.name}
          className="inline-flex items-center gap-1 rounded bg-content/8 px-1.5 py-px text-[10px] text-content/60"
        >
          {label.color ? (
            <span className="size-1.5 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
          ) : null}
          {label.name}
        </span>
      ))}
      {item.labels.length > 3 ? (
        <span className="text-[10px] text-content/35">+{item.labels.length - 3}</span>
      ) : null}
    </span>
  );
}

function InboxRow({ item, active, onSelect }: { item: RowItem; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full flex-col gap-1 border-b border-content/5 px-3.5 py-2.5 text-left last:border-b-0 ${
        active ? "bg-selection text-content" : "hover:bg-content/5"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <KindIcon
          kind={item.kind}
          state={item.state}
          draft={item.draft}
          className={`size-3.5 shrink-0 ${item.state === "open" ? "text-emerald-400" : "text-content/50"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{item.title}</span>
        <span className="shrink-0 text-[11px] text-content/40">{formatRelativeTime(item.updatedAt)}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-5.5 text-[11px] text-content/45">
        <span className="min-w-0 truncate">{item.repo}</span>
        <span className="shrink-0">#{item.number}</span>
        {item.attentionReason ? (
          <span className="shrink-0 rounded bg-content/8 px-1.5 py-px text-[10px]">{item.attentionReason}</span>
        ) : null}
        <StatePill item={item} />
        <span className="min-w-0 flex-1" />
        <LabelChips item={item} />
      </span>
    </button>
  );
}

function NotConnected({ source }: { source: Source }) {
  const name = source === "github" ? "GitHub" : "GitLab";
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-content/6">
        <span className="scale-[1.6]"><SourceMark source={source} /></span>
      </span>
      <div>
        <p className="text-[13px] font-medium text-content">尚未连接 {name}</p>
        <p className="mt-1 max-w-64 text-[12px] leading-relaxed text-content/45">
          {source === "github"
            ? "在终端用 gh auth login 登录后即可在此查看 Pull Request 与 Issue。"
            : "在设置里填写实例地址和 Access Token 后即可在此查看合并请求与待办。"}
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

/* ------------------------------------------------------------- diff (ported) */

function toUnifiedLine(line: { kind: string; text: string; oldNumber?: number | null; newNumber?: number | null }): UnifiedLine {
  return {
    kind: line.kind as UnifiedLine["kind"],
    text: line.text,
    oldNumber: line.oldNumber ?? null,
    newNumber: line.newNumber ?? null,
  };
}

function toDiffModel(
  file: ReturnType<typeof mergePrDiff>[number],
  truncated: boolean,
  context?: number,
): UnifiedDiffFileModel {
  const lines = file.lines.map(toUnifiedLine);
  return {
    id: file.path,
    path: file.path,
    label:
      file.status === "renamed" && file.previousPath
        ? `${file.previousPath} → ${file.path}`
        : file.path,
    binary: file.binary,
    emptyMessage:
      !file.binary && file.lines.length === 0
        ? truncated
          ? "变更过大，无法展示补丁"
          : "没有文本差异"
        : undefined,
    additions: file.additions,
    deletions: file.deletions,
    blocks: blocksFromLines(lines, context),
  };
}

function InboxPrDiff({ diff, fullFile = false }: { diff: PrDiff; fullFile?: boolean }) {
  const files = useMemo(() => {
    const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
    const context = fullFile ? Number.POSITIVE_INFINITY : undefined;
    return parsed.map((file) => toDiffModel(file, diff.truncated, context));
  }, [diff, fullFile]);
  return (
    <UnifiedDiffView
      files={files}
      truncated={diff.truncated}
      totals={{ additions: diff.additions, deletions: diff.deletions }}
      fill={false}
      fileLayout="cards"
      initialExpansion="first"
    />
  );
}

/* ------------------------------------------------------------------- detail */

const REVIEW_DECISION_LABEL: Record<string, string> = {
  APPROVED: "已批准",
  CHANGES_REQUESTED: "等待修改",
  REVIEW_REQUIRED: "等待评审",
};

function CommentBody({
  comment,
  onReply,
}: {
  comment: WorkItemComment;
  onReply?: (comment: WorkItemComment) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {comment.path ? (
        <p className="flex items-center gap-1.5 text-[11px] text-content/45">
          <span className="truncate rounded bg-content/8 px-1.5 py-px font-mono">{comment.path}</span>
          {comment.line ? <span className="shrink-0">:{comment.line}</span> : null}
          {comment.resolved ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-400/10 px-1.5 py-px text-emerald-400">
              <Check className="size-3" strokeWidth={2} />
              已解决
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="text-[13px] leading-relaxed text-content/85 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <Markdown content={comment.body || "（无内容）"} />
      </div>
      {onReply && comment.kind === "review_comment" && comment.threadId ? (
        <button
          type="button"
          onClick={() => onReply(comment)}
          className="inline-flex items-center gap-1 self-start text-[11px] text-content/50 hover:text-content"
        >
          <CornerDownRight className="size-3" strokeWidth={1.75} />
          回复此评审串
        </button>
      ) : null}
      {comment.replies.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2.5 border-l border-stroke pl-3">
          {comment.replies.map((reply) => (
            <CommentBody key={reply.id} comment={reply} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiscussionTab({
  provider,
  cwd,
  item,
  thread,
  threadError,
  onRefresh,
}: {
  provider: InboxProvider;
  cwd: string;
  item: WorkItem;
  thread?: WorkItemThread;
  threadError?: string | null;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<WorkItemComment | null>(null);
  const [posting, setPosting] = useState(false);

  const post = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      if (provider === "github") {
        await githubWorkItemComment(cwd, item.repo, item.kind, item.number, body, replyTo?.threadId ?? "");
      } else {
        await gitlabWorkItemComment(item.repo, item.kind, item.number, body);
      }
      setDraft("");
      setReplyTo(null);
      onRefresh();
      toast.success("评论已发送");
    } catch (error) {
      report(error);
      toast.warning("评论发送失败", { description: String(error) });
    } finally {
      setPosting(false);
    }
  };

  if (threadError) {
    return <p className="px-6 py-6 text-[12px] text-red-400">{threadError}</p>;
  }
  if (!thread) {
    return (
      <div className="flex items-center gap-2 px-6 py-6 text-[12px] text-content/45">
        <Loader className="size-3.5 animate-spin" />
        读取讨论…
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      {thread.commits.length > 0 ? (
        <section className="flex flex-col gap-1 rounded-lg border border-stroke px-3.5 py-3">
          <p className="text-[11px] font-medium text-content/50">提交 · {thread.commits.length}</p>
          {thread.commits.map((commit) => (
            <button
              key={commit.oid}
              type="button"
              onClick={() => void openUrl(commit.url).catch(report)}
              className="flex min-w-0 items-center gap-2 text-left text-[12px] text-content/70 hover:text-content"
            >
              <span className="shrink-0 rounded bg-content/8 px-1.5 py-px font-mono text-[10px]">
                {commit.oid.slice(0, 7)}
              </span>
              <span className="min-w-0 flex-1 truncate">{commit.messageHeadline}</span>
              <span className="shrink-0 text-[11px] text-content/40">{commit.author}</span>
            </button>
          ))}
        </section>
      ) : null}
      {thread.comments.length === 0 ? (
        <p className="text-[13px] text-content/45">还没有讨论。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {thread.comments.map((comment) => (
            <article key={comment.id} className="flex flex-col gap-1.5">
              <header className="flex items-center gap-2">
                <Avatar login={comment.author} url={comment.authorAvatarUrl} />
                <span className="text-[12px] font-medium text-content">{comment.author || "未知用户"}</span>
                {comment.kind === "review" && comment.state ? (
                  <span className="rounded bg-content/8 px-1.5 py-px text-[10px] font-medium text-content/60">
                    {REVIEW_DECISION_LABEL[comment.state] ?? comment.state}
                  </span>
                ) : null}
                {comment.kind === "review_comment" ? (
                  <span className="inline-flex items-center gap-1 rounded bg-content/8 px-1.5 py-px text-[10px] text-content/60">
                    <MessageSquare className="size-3" strokeWidth={1.75} />
                    评审意见
                  </span>
                ) : null}
                <span className="text-[11px] text-content/40">{formatRelativeTime(comment.createdAt)}</span>
              </header>
              <CommentBody comment={comment} onReply={setReplyTo} />
            </article>
          ))}
        </div>
      )}
      {thread.truncated ? (
        <p className="text-[11px] text-content/40">讨论较多，仅显示最近部分；完整内容请在浏览器查看。</p>
      ) : null}
      <section className="sticky bottom-0 flex flex-col gap-2 border-t border-stroke bg-background-base/80 py-3 backdrop-blur">
        {replyTo ? (
          <div className="flex items-center gap-2 text-[11px] text-content/50">
            <CornerDownRight className="size-3" strokeWidth={1.75} />
            回复 {replyTo.author} 的评审串
            <button type="button" onClick={() => setReplyTo(null)} className="hover:text-content">
              <X className="size-3" strokeWidth={2} />
            </button>
          </div>
        ) : null}
        <TextArea
          rows={3}
          value={draft}
          placeholder="写下评论，支持 Markdown…"
          aria-label="评论输入"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!draft.trim() || posting}
            onClick={() => void post()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40"
          >
            {posting ? <Loader className="size-3.5 animate-spin" /> : null}
            发送评论
          </button>
        </div>
      </section>
    </div>
  );
}

const CHECK_DOT: Record<string, string> = {
  pass: "bg-emerald-400",
  fail: "bg-red-400",
  pending: "bg-amber-400 animate-pulse",
  skipping: "bg-content/30",
  cancel: "bg-content/40",
  unknown: "bg-content/30",
};

function ChangesTab({
  provider,
  diff,
  diffError,
  fullContext,
  onFullContextChange,
}: {
  provider: InboxProvider;
  diff?: PrDiff;
  diffError?: string | null;
  fullContext: boolean;
  onFullContextChange: (on: boolean) => void;
}) {
  if (diffError) {
    return <p className="px-6 py-6 text-[12px] text-red-400">{diffError}</p>;
  }
  if (!diff) {
    return (
      <div className="flex items-center gap-2 px-6 py-6 text-[12px] text-content/45">
        <Loader className="size-3.5 animate-spin" />
        读取变更…
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 px-6 py-5">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-content/55">
        <span className="font-medium text-emerald-400">+{diff.additions}</span>
        <span className="font-medium text-red-400">−{diff.deletions}</span>
        <span>· {diff.files.length} 个文件</span>
        {diff.truncated ? <span className="text-amber-400">变更过大，仅显示部分补丁</span> : null}
        <span className="min-w-0 flex-1" />
        {provider === "github" ? (
          <button
            type="button"
            onClick={() => onFullContextChange(!fullContext)}
            className={`rounded-md px-2 py-0.5 text-[11px] ${
              fullContext ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
            }`}
          >
            完整上下文
          </button>
        ) : null}
      </div>
      {diff.files.length > 0 ? (
        <ul className="flex flex-col gap-0.5 rounded-lg border border-stroke px-3 py-2">
          {diff.files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate font-mono text-content/75">{file.path}</span>
              <span className="shrink-0 text-emerald-400">+{file.additions}</span>
              <span className="shrink-0 text-red-400">−{file.deletions}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {diff.patch ? (
        <InboxPrDiff diff={diff} />
      ) : (
        <p className="text-[12px] text-content/45">此变更没有可展示的补丁。</p>
      )}
    </div>
  );
}

function ChecksTab({
  checks,
  checksError,
}: {
  checks?: PrChecks;
  checksError?: string | null;
}) {
  if (checksError) {
    return <p className="px-6 py-6 text-[12px] text-red-400">{checksError}</p>;
  }
  if (!checks) {
    return (
      <div className="flex items-center gap-2 px-6 py-6 text-[12px] text-content/45">
        <Loader className="size-3.5 animate-spin" />
        读取检查…
      </div>
    );
  }
  if (checks.checks.length === 0) {
    return <p className="px-6 py-6 text-[13px] text-content/45">这个 Pull Request 没有 CI 检查。</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 px-6 py-5">
      {checks.checks.map((check) => {
        const duration =
          check.startedAt && check.completedAt
            ? Math.max(1, Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000))
            : null;
        return (
          <li key={`${check.workflow}/${check.name}`} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-content/5">
            <span className={`size-2 shrink-0 rounded-full ${CHECK_DOT[check.state] ?? "bg-content/30"}`} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-content/80">{check.name}</span>
            {check.workflow ? <span className="shrink-0 text-[11px] text-content/40">{check.workflow}</span> : null}
            {duration ? <span className="shrink-0 text-[11px] text-content/40">{duration}s</span> : null}
            {check.url ? (
              <button
                type="button"
                onClick={() => void openUrl(check.url!).catch(report)}
                className="shrink-0 text-content/40 hover:text-content"
                aria-label="打开检查详情"
              >
                <ExternalLink className="size-3" strokeWidth={1.75} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const PR_ACTIONS: { id: GithubPrAction; label: string; danger?: boolean }[] = [
  { id: "ready", label: "标记就绪" },
  { id: "draft", label: "转草稿" },
  { id: "merge", label: "合并" },
  { id: "squash", label: "压缩合并" },
  { id: "rebase", label: "Rebase 合并" },
  { id: "close", label: "关闭", danger: true },
  { id: "reopen", label: "重新打开" },
];

function DetailPane({
  provider,
  cwd,
  item,
  onBack,
}: {
  provider: InboxProvider;
  cwd: string;
  item: RowItem;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>("overview");
  const [fullContext, setFullContext] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const detailsQ = useQuery({
    queryKey: ["inbox", "details", provider, item.repo, item.kind, item.number],
    queryFn: () =>
      provider === "github"
        ? githubWorkItemDetails(cwd, item.repo, item.kind, item.number)
        : gitlabWorkItemDetails(item.repo, item.kind, item.number),
  });
  const threadQ = useQuery({
    queryKey: ["inbox", "thread", provider, item.repo, item.kind, item.number],
    queryFn: () =>
      provider === "github"
        ? githubWorkItemThread(cwd, item.repo, item.kind, item.number)
        : gitlabWorkItemThread(item.repo, item.kind, item.number),
  });
  const diffQ = useQuery({
    queryKey: ["inbox", "diff", provider, item.repo, item.number, fullContext],
    queryFn: () =>
      provider === "github"
        ? githubPrDiff(cwd, item.repo, item.number, fullContext)
        : gitlabMrDiff(item.repo, item.number),
    enabled: item.kind === "pr",
  });
  const checksQ = useQuery({
    queryKey: ["inbox", "checks", item.repo, item.number],
    queryFn: () => githubPrChecks(cwd, item.repo, item.number),
    enabled: provider === "github" && item.kind === "pr" && tab === "checks",
  });

  const refreshItem = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbox", "thread", provider, item.repo, item.kind, item.number] });
    void queryClient.invalidateQueries({ queryKey: ["inbox", "list"] });
  };

  const runAction = async (action: GithubPrAction) => {
    if (acting) return;
    setActing(action);
    try {
      await githubPrAction(cwd, item.repo, item.number, action);
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
      toast.success("操作完成", { description: `${item.repo}#${item.number} ${action}` });
    } catch (error) {
      report(error);
      toast.warning("操作失败", { description: String(error) });
    } finally {
      setActing(null);
    }
  };

  const details = detailsQ.data;
  const tabs: { id: TabId; label: string; show: boolean }[] = [
    { id: "overview", label: "概览", show: true },
    { id: "discussion", label: "讨论", show: true },
    { id: "changes", label: "变更", show: item.kind === "pr" },
    { id: "checks", label: "检查", show: provider === "github" && item.kind === "pr" },
  ];
  const visibleTabs = tabs.filter((entry) => entry.show);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-stroke px-6 pb-3 pt-5">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onBack}
            className="mt-0.5 shrink-0 rounded-md px-1 py-0.5 text-content/50 hover:bg-content/10 hover:text-content md:hidden"
            aria-label="返回列表"
          >
            <ChevronDown className="size-4 rotate-90" strokeWidth={1.75} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              <KindIcon
                kind={item.kind}
                state={item.state}
                draft={item.draft}
                className={`mt-0.5 size-4 shrink-0 ${item.state === "open" ? "text-emerald-400" : "text-content/50"}`}
              />
              <h2 className="min-w-0 flex-1 text-[16px] font-semibold leading-snug">{item.title}</h2>
              <StatePill item={item} />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-content/50">
              <span className="inline-flex items-center gap-1.5">
                <SourceMark source={provider} />
                <span className="font-mono">{item.repo}</span>
                <span>#{item.number}</span>
              </span>
              {details?.author ? (
                <span className="inline-flex items-center gap-1.5">
                  <Avatar login={details.author} url={details.authorAvatarUrl} size={14} />
                  {details.author}
                </span>
              ) : null}
              <span>· 更新于 {formatRelativeTime(item.updatedAt)}</span>
              {item.url ? (
                <button
                  type="button"
                  onClick={() => void openUrl(item.url).catch(report)}
                  className="inline-flex items-center gap-1 text-content/50 hover:text-content"
                >
                  <ExternalLink className="size-3" strokeWidth={1.75} />
                  浏览器打开
                </button>
              ) : null}
            </div>
            {item.kind === "pr" && (details?.baseRefName || threadQ.data?.baseRefName) ? (
              <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-content/55">
                <GitMerge className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="rounded bg-content/8 px-1.5 py-px font-mono text-[11px]">
                  {threadQ.data?.baseRefName || details?.baseRefName}
                </span>
                <span className="text-content/35">←</span>
                <span className="rounded bg-content/8 px-1.5 py-px font-mono text-[11px]">
                  {threadQ.data?.headRefName || details?.headRefName}
                </span>
                {(() => {
                  const decision = threadQ.data?.reviewDecision || details?.reviewDecision || "";
                  return decision ? (
                    <span className="rounded bg-content/8 px-1.5 py-px text-[11px] font-medium">
                      {REVIEW_DECISION_LABEL[decision] ?? decision}
                    </span>
                  ) : null;
                })()}
              </p>
            ) : null}
          </div>
        </div>
        {provider === "github" && item.kind === "pr" ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {PR_ACTIONS.map((action) => {
              const hidden =
                (action.id === "reopen" && item.state !== "closed") ||
                (action.id === "close" && item.state === "closed") ||
                ((action.id === "ready" || action.id === "draft") && !item.draft && action.id === "draft") ||
                ((action.id === "ready" || action.id === "draft") && item.draft && action.id === "ready");
              if (hidden) return null;
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={acting !== null}
                  onClick={() => void runAction(action.id)}
                  className={`h-6.5 rounded-md border border-stroke px-2.5 text-[11px] font-medium disabled:opacity-40 ${
                    action.danger ? "text-red-400 hover:bg-red-400/10" : "text-content/70 hover:bg-content/5 hover:text-content"
                  }`}
                >
                  {acting === action.id ? <Loader className="mr-1 inline size-3 animate-spin" /> : null}
                  {action.label}
                </button>
              );
            })}
          </div>
        ) : null}
        <div role="tablist" aria-label="详情分区" className="mt-3 flex items-center gap-1">
          {visibleTabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => setTab(entry.id)}
              className={`h-7 rounded-md px-3 text-[12px] ${
                tab === entry.id ? "bg-selection text-content" : "text-content/50 hover:text-content"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        {tab === "overview" ? (
          <div className="flex flex-col gap-4 px-6 py-5">
            {item.labels.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {item.labels.map((label) => (
                  <span
                    key={label.name}
                    className="inline-flex items-center gap-1.5 rounded-full border border-stroke px-2 py-0.5 text-[11px] text-content/65"
                  >
                    {label.color ? (
                      <span className="size-2 rounded-full" style={{ backgroundColor: `#${label.color}` }} />
                    ) : null}
                    {label.name}
                  </span>
                ))}
              </div>
            ) : null}
            {detailsQ.data ? (
              detailsQ.data.body.trim() ? (
                <div className="text-[13px] leading-relaxed text-content/85 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                  <Markdown content={detailsQ.data.body} />
                </div>
              ) : (
                <p className="text-[13px] text-content/45">没有描述。</p>
              )
            ) : detailsQ.error ? (
              <p className="text-[12px] text-red-400">{String(detailsQ.error)}</p>
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-content/45">
                <Loader className="size-3.5 animate-spin" />
                读取描述…
              </div>
            )}
          </div>
        ) : null}
        {tab === "discussion" ? (
          <DiscussionTab
            provider={provider}
            cwd={cwd}
            item={item}
            thread={threadQ.data}
            threadError={threadQ.error ? String(threadQ.error) : null}
            onRefresh={refreshItem}
          />
        ) : null}
        {tab === "changes" && item.kind === "pr" ? (
          <ChangesTab
            provider={provider}
            diff={diffQ.data}
            diffError={diffQ.error ? String(diffQ.error) : null}
            fullContext={fullContext}
            onFullContextChange={setFullContext}
          />
        ) : null}
        {tab === "checks" && provider === "github" && item.kind === "pr" ? (
          <ChecksTab checks={checksQ.data} checksError={checksQ.error ? String(checksQ.error) : null} />
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- view */

function mergeRows(lists: (WorkItem[] | undefined)[]): RowItem[] {
  const seen = new Set<string>();
  const rows: RowItem[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = rowKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...item, key });
    }
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rows;
}

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

  const rows = useMemo(() => {
    if (source === "github") {
      if (!project) return [];
      return mergeRows([ghIssueQ.data, ghPrQ.data]).filter(
        (item) => kindFilter === "all" || item.kind === kindFilter,
      );
    }
    return mergeRows([glTodoIssueQ.data, glTodoPrQ.data, glMrQ.data, glIssueQ.data]).filter(
      (item) => kindFilter === "all" || item.kind === kindFilter,
    );
  }, [source, project, kindFilter, ghIssueQ.data, ghPrQ.data, glTodoIssueQ.data, glTodoPrQ.data, glMrQ.data, glIssueQ.data]);

  const listError =
    source === "github"
      ? ghRepoQ.error ?? ghIssueQ.error ?? ghPrQ.error
      : glTodoIssueQ.error ?? glTodoPrQ.error ?? glRepoQ.error ?? glMrQ.error ?? glIssueQ.error;
  const fetching =
    source === "github"
      ? ghRepoQ.isFetching || ghIssueQ.isFetching || ghPrQ.isFetching
      : glTodoIssueQ.isFetching || glTodoPrQ.isFetching || glRepoQ.isFetching || glMrQ.isFetching || glIssueQ.isFetching;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["inbox"] });
  };

  const selected = rows.find((item) => item.key === activeKey) ?? null;

  const needProject = source === "github" && connected && !project;

  return (
    <div role="region" aria-label="Inbox" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-3" data-tauri-drag-region>
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

/** Inbox settings: connection cards for GitHub (gh CLI) and GitLab (PAT). */
export function InboxSettings() {
  const github = useGithubStatus();
  const gitlab = useGitlabStatus();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await saveGitlabConfig(url || gitlab.data?.url || "", token);
      setToken("");
      toast.success("已连接 GitLab", { description: status.url });
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await disconnectGitlab(gitlab.data?.url ?? "");
      toast.success("已断开 GitLab", { description: "Token 已从本机删除" });
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8 text-content">
      <PageHeader title="Inbox" description="管理各项项目的收件箱来源与通知。" />

      <Group title={<span className="inline-flex items-center gap-2"><SourceMark source="github" />GitHub</span>} description="通过 GitHub CLI 读取的 Pull Request、评审与 Issue。">
        {github.data?.connected ? (
          <Row
            label="连接"
            description="GitHub CLI 已安装并登录，收件箱用它读取 GitHub 条目。"
          >
            <SecondaryButton onClick={() => void github.refetch()}>重新检查</SecondaryButton>
          </Row>
        ) : (
          <Row
            label="连接"
            description={
              github.data?.installed
                ? "GitHub CLI 已安装但未登录。在终端运行 gh auth login 后点击重新检查。"
                : "需要安装 GitHub CLI（gh）。在终端运行 gh auth login 完成登录。"
            }
          >
            <SecondaryButton onClick={() => void github.refetch()}>重新检查</SecondaryButton>
          </Row>
        )}
      </Group>

      <Group title={<span className="inline-flex items-center gap-2"><SourceMark source="gitlab" />GitLab</span>} description="来自 GitLab.com 或自建实例的合并请求、Issue 与待办。">
        {gitlab.data?.connected ? (
          <Row label="连接" description={`已连接 ${gitlab.data.url}。Token 只保存在本机，断开即删除。`}>
            <SecondaryButton danger onClick={() => void disconnect()}>
              断开
            </SecondaryButton>
          </Row>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3.5">
            <p className="text-[12px] leading-relaxed text-content/55">
              连接 GitLab.com 或自建实例。请使用带 read_api 权限的 Personal Access Token；Token 只保存在本机，断开即删除。
            </p>
            <div className="flex items-center gap-2">
              <TextField wide value={url} placeholder="https://gitlab.com 或自建实例地址" aria-label="GitLab 地址" onChange={(event) => setUrl(event.target.value)} />
              <TextField wide value={token} placeholder="glpat-…" aria-label="GitLab Access Token" onChange={(event) => setToken(event.target.value)} />
              <button
                type="button"
                disabled={busy || !token.trim()}
                onClick={() => void connect()}
                className="h-7 shrink-0 rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40"
              >
                {busy ? <Loader className="size-3.5 animate-spin" /> : "连接"}
              </button>
            </div>
            {error ? <p className="text-[12px] text-red-400">{error}</p> : null}
          </div>
        )}
      </Group>
    </div>
  );
}
