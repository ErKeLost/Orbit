import { useEffect, useState, type CSSProperties } from "react";
import { elapsedMs, formatAgentElapsed, hasRunningAgents, type AgentNode, type AgentSnapshot } from "../../lib/agents";
import { Icon } from "../Icon";
import { agentIcon, STATUS_LABELS } from "./agent-icon";
import "./agent-activity.css";

type AgentActivityFeedProps = {
  snapshot: AgentSnapshot;
  onOpenAgent?: (agent: AgentNode) => void;
};

function AgentAvatar({ agent }: { agent: AgentNode }) {
  const title = [agent.name, STATUS_LABELS[agent.status], agent.model].filter(Boolean).join(" · ");
  return (
    <span className={`agent-feed-avatar is-${agent.status}`} data-logo={agent.logo ?? undefined} title={title} aria-hidden="true">
      <Icon name={agentIcon(agent)} />
      <i className="agent-feed-badge" />
    </span>
  );
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

/**
 * Why a row is or is not clickable. A worker's session file exists from its first
 * entry on, so a running worker opens too — the tab is how a user follows what a
 * sub-agent is doing instead of waiting for its FINAL_ANSWER. A worker that died
 * before writing anything (bad model, no API key) has nothing to open, and saying
 * so is better than a row that silently ignores the click.
 */
function openHint(agent: AgentNode): string {
  if (agent.sessionPath) return "打开子会话";
  if (agent.status === "queued") return "子会话尚未启动";
  return "子会话没有落盘（启动即失败），失败原因见上方";
}

function AgentLine({ agent, depth, now, onOpenAgent }: { agent: AgentNode; depth: number; now: number; onOpenAgent?: (agent: AgentNode) => void }) {
  const hint = openHint(agent);
  const content = <>
    <AgentAvatar agent={agent} />
    <span className="agent-feed-copy"><strong>{agent.name}</strong><span className={agent.status === "running" ? "agent-feed-shimmer" : undefined}>{statusText(agent)}</span></span>
    <time>{formatAgentElapsed(elapsedMs(agent, now))}</time>
  </>;
  const style = { "--agent-depth": depth } as CSSProperties;
  return <>
    {agent.sessionPath
      ? <button type="button" className={`agent-feed-line is-${agent.status}`} data-nested={depth > 0 || undefined} style={style} title={hint} onClick={() => onOpenAgent?.(agent)}>{content}</button>
      : <div className={`agent-feed-line is-${agent.status}`} data-nested={depth > 0 || undefined} style={style} title={hint}>{content}</div>}
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
