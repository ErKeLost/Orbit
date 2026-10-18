import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Markdown } from "../../../components/Markdown";
import { report } from "../../../lib/rpc";
import { toast } from "../../../shared/ui/toast";
import {
  formatRelativeTime,
  githubPrAction,
  githubPrChecks,
  githubPrDiff,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  gitlabMrDiff,
  gitlabWorkItemComment,
  gitlabWorkItemDetails,
  gitlabWorkItemThread,
  type GithubPrAction,
  type InboxProvider,
  type PrChecks,
  type PrDiff,
  type WorkItem,
  type WorkItemComment,
  type WorkItemThread,
} from "../../../lib/inbox";
import { UnifiedDiffView } from "../../source-control/ui/UnifiedDiffView";
import { TextArea } from "../../../shared/ui/controls";
import {
  Check,
  ChevronDown,
  CornerDownRight,
  ExternalLink,
  GitMerge,
  Loader,
  MessageSquare,
  X,
} from "../../../shared/ui/icons";
import {
  PR_ACTIONS,
  buildInboxDiffFiles,
  canPostComment,
  checkDotClass,
  checkDurationSeconds,
  commentBody,
  isPrActionVisible,
  reviewDecisionLabel,
  visibleDetailTabs,
  type InboxRowItem,
} from "../model/inboxView";
import { Avatar, KindIcon, SourceMark, StatePill } from "./InboxList";

/* ------------------------------------------------------------------- diff */

function InboxPrDiff({ diff, fullFile = false }: { diff: PrDiff; fullFile?: boolean }) {
  const files = useMemo(() => buildInboxDiffFiles(diff, fullFile), [diff, fullFile]);
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
    const body = commentBody(draft);
    if (!canPostComment(draft, posting)) return;
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
                    {reviewDecisionLabel(comment.state)}
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
            disabled={!canPostComment(draft, posting)}
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
        const duration = checkDurationSeconds(check);
        return (
          <li key={`${check.workflow}/${check.name}`} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-content/5">
            <span className={`size-2 shrink-0 rounded-full ${checkDotClass(check.state)}`} />
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

export function DetailPane({
  provider,
  cwd,
  item,
  onBack,
}: {
  provider: InboxProvider;
  cwd: string;
  item: InboxRowItem;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"overview" | "discussion" | "changes" | "checks">("overview");
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
  const visibleTabs = visibleDetailTabs(provider, item.kind);

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
                      {reviewDecisionLabel(decision)}
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
              if (!isPrActionVisible(action.id, item)) return null;
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
