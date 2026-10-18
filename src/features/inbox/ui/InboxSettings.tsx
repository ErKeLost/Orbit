import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "../../../lib/store";
import { toast } from "../../../shared/ui/toast";
import {
  disconnectGitlab,
  saveGitlabConfig,
  useGithubStatus,
  useGitlabStatus,
} from "../../../lib/inbox";
import { Group, Notice, PrimaryButton, Row, SecondaryButton, TextField } from "../../../shared/ui/controls";
import { Loader, RefreshCw } from "../../../shared/ui/icons";
import { describeGithubConnection, type GithubConnectionTone } from "../model/inboxView";
import { SourceMark } from "./InboxList";

/** 设置页小状态胶囊：绿点已连接、琥珀待登录、灰点未配置。 */
function StatusPill({ tone, children }: { tone: GithubConnectionTone; children: ReactNode }) {
  const dot = tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-content/25";
  // 文字保持中性：琥珀字在亮色主题下对比度不够，颜色交给圆点。
  const text = tone === "off" ? "text-content/40" : "text-content/65";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-content/10 bg-content/3 px-2 py-0.5 text-[11px] leading-4 ${text}`}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

/** 行内命令片段，用于 `gh auth login` 这类要用户照抄的字。 */
function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-content/10 bg-content/5 px-1 py-px font-mono text-[11px] text-content/70">{children}</code>
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

  useEffect(() => {
    if (gitlab.data?.url && !url) setUrl(gitlab.data.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitlab.data?.url]);

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

  const mobileRuntime = useWorkspace((state) => state.runtimeTarget === "mobile");
  const githubConnected = Boolean(github.data?.authenticated);
  const githubConnection = describeGithubConnection({
    pending: github.isPending,
    authenticated: githubConnected,
    installed: Boolean(github.data?.installed),
  });
  const githubDescription = githubConnected ? (
    "GitHub CLI 已安装并登录，收件箱用它读取 GitHub 条目。"
  ) : github.data?.installed ? (
    <>
      GitHub CLI 已安装但未登录。先在终端执行 <InlineCode>gh auth login</InlineCode>，再重新检查。
    </>
  ) : (
    <>
      未检测到 GitHub CLI。安装后执行 <InlineCode>gh auth login</InlineCode>，再重新检查。
    </>
  );

  // 手机端只是远程客户端，gh 登录态与 GitLab Token 都在电脑上，这里只做说明。
  const githubAction = mobileRuntime ? <StatusPill tone="off">电脑端</StatusPill> : <StatusPill tone={githubConnection.tone}>{githubConnection.label}</StatusPill>;

  return (
    <div className="flex flex-col">
      <Group
        title={
          <span className="inline-flex items-center gap-2">
            <SourceMark source="github" />
            GitHub
          </span>
        }
        description="通过 GitHub CLI 读取的 Pull Request、评审与 Issue。"
        action={githubAction}
      >
        {mobileRuntime ? (
          <Notice>GitHub 通过电脑端的 gh CLI 读取，请在电脑端设置里连接。</Notice>
        ) : (
          <Row label="gh CLI" description={githubDescription}>
            <SecondaryButton disabled={github.isFetching} onClick={() => void github.refetch()}>
              {github.isFetching ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" strokeWidth={1.75} />
              )}
              重新检查
            </SecondaryButton>
          </Row>
        )}
      </Group>

      <Group
        title={
          <span className="inline-flex items-center gap-2">
            <SourceMark source="gitlab" />
            GitLab
          </span>
        }
        description="来自 GitLab.com 或自建实例的合并请求、Issue 与待办。"
        action={<StatusPill tone={mobileRuntime ? "off" : gitlab.data?.connected ? "ok" : "off"}>{mobileRuntime ? "电脑端" : gitlab.data?.connected ? "已连接" : "未连接"}</StatusPill>}
      >
        {mobileRuntime ? (
          <Notice>GitLab Token 保存在电脑上，请在电脑端设置里连接或断开。</Notice>
        ) : gitlab.data?.connected ? (
          <Row label="实例" description="Token 只保存在本机，点「断开」即从本机删除。">
            <span className="min-w-0 max-w-full truncate rounded-md border border-content/10 bg-content/5 px-2 py-1 font-mono text-[11px] text-content/70">
              {gitlab.data.url}
            </span>
            <SecondaryButton danger disabled={busy} onClick={() => void disconnect()}>
              {busy ? <Loader className="size-3.5 animate-spin" /> : null}
              断开
            </SecondaryButton>
          </Row>
        ) : (
          <>
            <Row label="实例地址" description="GitLab.com 或自建实例地址；省略协议时按 https 补全。">
              <TextField
                wide
                value={url}
                placeholder="https://gitlab.com"
                aria-label="GitLab 地址"
                autoComplete="url"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Row>
            <Row
              label="Personal Access Token"
              description={
                <>
                  需要 <InlineCode>read_api</InlineCode> 权限（Legacy token）；Token 只保存在本机，断开即删除。
                </>
              }
            >
              <TextField
                type="password"
                value={token}
                placeholder="glpat-…"
                aria-label="GitLab Access Token"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
              />
              <PrimaryButton disabled={busy || !token.trim()} onClick={() => void connect()}>
                {busy ? <Loader className="size-3.5 animate-spin" /> : null}
                连接
              </PrimaryButton>
            </Row>
            {error ? <p className="border-t border-content/5 px-4 py-2.5 text-[12px] leading-relaxed text-red-400">{error}</p> : null}
          </>
        )}
      </Group>
    </div>
  );
}
