import { useEffect, useState, type CSSProperties } from "react";
import { elapsedMs, formatAgentElapsed, hasRunningAgents, type AgentNode, type AgentSnapshot } from "../../lib/agents";
import { Icon } from "../Icon";
import "./agent-activity.css";

type AgentActivityFeedProps = {
  snapshot: AgentSnapshot;
  onOpenAgent?: (agent: AgentNode) => void;
};

function agentIcon(agent: AgentNode) {
  const text = `${agent.name} ${agent.task}`.toLowerCase();
  if (/search|find|explore|inspect|分析|搜索|检查|查找/.test(text)) return "fluent-color:search-sparkle-24";
  if (/read|repo|structure|file|folder|目录|文件|仓库|文档/.test(text)) return "fluent-color:document-folder-24";
  if (/code|implement|edit|fix|代码|实现|修复|开发/.test(text)) return "fluent-color:code-block-24";
  if (/test|verify|check|测试|验证/.test(text)) return "fluent-color:checkmark-circle-24";
  if (/run|bash|command|执行|运行|命令/.test(text)) return "fluent-color:wrench-screwdriver-24";
  if (/plan|coordinate|orchestrat|规划|协调/.test(text)) return "fluent-color:people-community-24";
  if (agent.status === "failed") return "fluent-color:error-circle-24";
  if (agent.status === "aborted") return "fluent-color:warning-24";
  if (agent.status === "queued") return "fluent-color:clock-24";
  if (agent.status === "completed") return "fluent-color:checkmark-circle-24";
  return "fluent-color:lightbulb-24";
}

function AgentAvatar({ agent }: { agent: AgentNode }) {
  return <span className="agent-feed-avatar" aria-hidden="true"><Icon name={agentIcon(agent)} /></span>;
}

function statusText(agent: AgentNode) {
  if (agent.status === "running") return agent.summary || "正在处理";
  if (agent.status === "queued") return "等待启动";
  // Codex shows a short preview of the worker's answer on the status line rather
  // than its full output, which stays in the supervisor's context.
  if (agent.status === "completed") return agent.summary ? `已完成 — ${agent.summary}` : "已完成";
  if (agent.status === "aborted") return "已中止";
  if (agent.status === "failed") return agent.error || "执行失败";
  return agent.summary || "状态更新";
}

function AgentLine({ agent, depth, now, onOpenAgent }: { agent: AgentNode; depth: number; now: number; onOpenAgent?: (agent: AgentNode) => void }) {
  const canOpen = Boolean(agent.sessionPath) && ["completed", "failed", "aborted"].includes(agent.status);
  const content = <>
    <AgentAvatar agent={agent} />
    <span className="agent-feed-copy"><strong>{agent.name}</strong><span className={agent.status === "running" ? "agent-feed-shimmer" : undefined}>{statusText(agent)}</span></span>
    <time>{formatAgentElapsed(elapsedMs(agent, now))}</time>
  </>;
  const style = { "--agent-depth": depth } as CSSProperties;
  return <>
    {canOpen
      ? <button type="button" className={`agent-feed-line is-${agent.status}`} data-nested={depth > 0 || undefined} style={style} title="打开子会话" onClick={() => onOpenAgent?.(agent)}>{content}</button>
      : <div className={`agent-feed-line is-${agent.status}`} data-nested={depth > 0 || undefined} style={style}>{content}</div>}
    {agent.children.map(child => <AgentLine key={child.id} agent={child} depth={depth + 1} now={now} onOpenAgent={onOpenAgent} />)}
  </>;
}

export function AgentActivityFeed({ snapshot, onOpenAgent }: AgentActivityFeedProps) {
  const running = hasRunningAgents(snapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const roots = [...snapshot.active, ...snapshot.recent];
  if (roots.length === 0) return null;
  return <div className="agent-feed" aria-label="子 agent 活动">
    {roots.map(agent => <AgentLine key={agent.id} agent={agent} depth={0} now={now} onOpenAgent={onOpenAgent} />)}
  </div>;
}
