import { useState } from "react";
import { useWorkspace } from "../../../lib/store";
import { formatRelativeTime, githubAvatarUrl, type InboxProvider, type WorkItem, type WorkItemKind } from "../../../lib/inbox";
import { CircleAlert, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "../../../shared/ui/icons";
import { stateLabel, statePillClass, type InboxRowItem } from "../model/inboxView";

export function SourceMark({ source }: { source: InboxProvider }) {
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

export function KindIcon({ kind, state, draft, className }: { kind: WorkItemKind; state: string; draft: boolean; className?: string }) {
  if (kind === "issue") return <CircleAlert className={className ?? "size-3.5"} strokeWidth={1.75} />;
  if (draft) return <GitPullRequestDraft className={className ?? "size-3.5"} strokeWidth={1.75} />;
  if (state !== "open") return <GitPullRequestClosed className={className ?? "size-3.5"} strokeWidth={1.75} />;
  return <GitPullRequest className={className ?? "size-3.5"} strokeWidth={1.75} />;
}

export function Avatar({ login, url, size = 16 }: { login: string; url?: string; size?: number }) {
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

export function StatePill({ item }: { item: WorkItem }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium ${statePillClass(item.state)}`}>
      <KindIcon kind={item.kind} state={item.state} draft={item.draft} className="size-3" />
      {stateLabel(item.state)}
    </span>
  );
}

export function LabelChips({ item }: { item: WorkItem }) {
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

export function InboxRow({ item, active, onSelect }: { item: InboxRowItem; active: boolean; onSelect: () => void }) {
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

export function NotConnected({ source }: { source: InboxProvider }) {
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
