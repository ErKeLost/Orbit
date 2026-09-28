import { useWorkspace } from "../../lib/store";
import { branchFromMessage, report } from "../../lib/rpc";
import { Fragment, memo, useState, type ReactNode } from "react";
import { m } from "motion/react";
import type { DisplayMessage, Part, PiMessage, Tool } from "../../lib/protocol";
import { formatTranscriptError, toolResultText } from "../../lib/protocol";
import { ProcessingPanel, Thinking } from "../RichMessage";
import { ToolActivityGroup, ToolCall } from "../ai-elements/tool-call";
import { Message, MessageContent, MessageResponse } from "../ai-elements/message";
import { MessageActions } from "../assistant-ui/elements/message-actions";
import { Icon } from "../Icon";
import { withoutRuntimeImageNotes } from "../../lib/image-note";

const turnTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

type PartViewProps = {
  part: Part;
  tools: Record<string, Tool>;
  running: boolean;
  thinking: boolean;
  collapse?: boolean;
};

function TextPart({ part, running, collapse }: PartViewProps) {
  if (!part.text) return null;
  return <MessageResponse animated={running} collapse={collapse}>{part.text}</MessageResponse>;
}

function ThinkingPart({ part, thinking }: PartViewProps) {
  const active = thinking && !part.thinkingComplete;
  if (!part.thinking?.trim() && !active) return null;
  return <Thinking text={part.thinking ?? ""} running={active} />;
}

function ToolPart({ part, tools }: PartViewProps) {
  const tool = tools[part.id ?? ""];
  const result = tool?.result;
  return <ToolCall
    toolName={part.name ?? tool?.name ?? "工具"}
    request={part.argsText ?? JSON.stringify(part.arguments ?? {})}
    result={toolResultText(result)}
    details={tool?.details}
    usage={tool?.usage}
    running={tool?.running ?? false}
  />;
}

function PartView(props: PartViewProps) {
  if (props.part.type === "text") return <TextPart {...props} />;
  if (props.part.type === "thinking") return <ThinkingPart {...props} />;
  if (props.part.type === "image") return <img className="message-image" src={`data:${props.part.mimeType};base64,${props.part.data}`} alt="会话附件" decoding="async" />;
  if (props.part.type === "toolCall") return <ToolPart {...props} />;
  return null;
}

function BashExecution({ message }: { message: PiMessage }) {
  const status = message.cancelled ? "已取消" : message.exitCode === 0 ? "完成" : message.exitCode == null ? "运行中" : `退出 ${message.exitCode}`;
  return <div className="bash-execution-card"><div className="bash-execution-heading"><span>Bash</span><code>{message.command ?? ""}</code><small>{status}</small></div><pre>{message.output ?? ""}</pre>{message.truncated && message.fullOutputPath && <small className="metric-note">完整输出：{message.fullOutputPath}</small>}</div>;
}

export function ErrorOutput({ error }: { error: string }) {
  return <div className="transcript-error" role="alert"><Icon name="warning-circle" /><p>{formatTranscriptError(error)}</p></div>;
}

function turnTime(items: DisplayMessage[]) {
  const timestamp = [...items].reverse().find(entry => typeof entry.message.timestamp === "number")?.message.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return { dateTime: date.toISOString(), label: turnTimeFormatter.format(date) };
}

function MessageCopyFooter({ text, time, role, message, copied, onCopied }: {
  message: PiMessage;
  role: "user" | "assistant";
  text: string;
  time: { dateTime: string; label: string } | null;
  copied: boolean;
  onCopied: () => void;
}) {
  const [branching, setBranching] = useState(false);
  const branchDisabled = useWorkspace(state => state.connection !== "online" || state.transcript.running || state.transcript.compacting);
  const branch = async () => {
    if (branching || branchDisabled) return;
    setBranching(true);
    try { await branchFromMessage(message); }
    catch (error) { report(error); }
    finally { setBranching(false); }
  };
  return <footer className={`message-response-footer is-${role}`}>
    {time && <time dateTime={time.dateTime}>{time.label}</time>}
    <MessageActions onBranch={role === "assistant" ? () => void branch() : undefined} branching={branching} branchDisabled={branchDisabled} copied={copied} onCopy={() => { void navigator.clipboard.writeText(text).then(onCopied).catch(() => undefined); }} />
  </footer>;
}

type TranscriptMessageProps = {
  items: DisplayMessage[];
  tools: Record<string, Tool>;
  streaming: boolean;
  thinking: boolean;
  elapsedMs?: number;
  activity?: ReactNode;
  activityTime?: number;
};

type ProjectedPart = { part: Part; key: string; active: boolean; messageIndex: number };

function projectParts(items: DisplayMessage[], streaming: boolean): ProjectedPart[] {
  return items.flatMap((entry, itemIndex) => {
    const parts = Array.isArray(entry.message.content) ? entry.message.content : [{ type: "text", text: entry.message.content ?? "" }];
    return parts.map((part, partIndex) => {
      const projected = part as Part;
      // Runtime image metadata stays in the transcript data and still reaches
      // the model; only the desktop view and its copy action omit it.
      const visible = projected.type === "text" && projected.text ? { ...projected, text: withoutRuntimeImageNotes(projected.text) } : projected;
      return { part: visible, key: `${entry.id}-${partIndex}`, messageIndex: itemIndex, active: streaming && itemIndex === items.length - 1 };
    });
  });
}

function specialMessage(item: DisplayMessage) {
  if (item.message.role === "bashExecution") return <m.div className="transcript-message assistant"><BashExecution message={item.message} /></m.div>;
  if (item.message.role !== "compactionSummary") return null;
  const summary = item.message.summary || (typeof item.message.content === "string" ? item.message.content : "");
  return <m.div className="transcript-message assistant" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}><div className="transcript-compaction"><div className="transcript-compaction-heading"><Icon name="arrows-clockwise" /><span>上下文已压缩</span></div>{summary.trim() ? <pre>{summary.trim()}</pre> : null}</div></m.div>;
}

function messageTime(items: DisplayMessage[], messageIndex: number): number | undefined {
  const raw = items[messageIndex]?.message.timestamp;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
}

function buildNodes(content: ProjectedPart[], items: DisplayMessage[], tools: Record<string, Tool>, streaming: boolean, thinking: boolean, role: "user" | "assistant", activity?: ReactNode, activityTime?: number) {
  const progress: { node: ReactNode; time?: number }[] = [];
  const media: ReactNode[] = [];
  const body: ReactNode[] = [];
  const lastMessage = items.at(-1)?.message;
  const hasFinalResponse = role === "assistant" && !streaming
    && !lastMessage?.errorMessage
    && (!lastMessage?.stopReason || lastMessage.stopReason === "stop")
    && !content.some(({ part, messageIndex }) => messageIndex === items.length - 1 && part.type === "toolCall")
    && content.some(({ part, messageIndex }) => messageIndex === items.length - 1 && part.type === "text" && part.text?.trim());

  if (role === "user") {
    for (const { part, key, active } of content) {
      if (part.type === "text" && !part.text?.trim()) continue;
      if (part.type === "thinking" && !part.thinking?.trim()) continue;
      const node = <PartView key={key} part={part} tools={tools} running={active} thinking={false} collapse />;
      if (part.type === "image") media.push(node);
      else body.push(node);
    }
    return { progress: [], media, body, defaultExpanded: false, activityIndex: undefined, activityConsumed: false };
  }

  let processParts: ProjectedPart[] = [];
  let processIndex = 0;
  let activityConsumed = false;
  const turnKey = items[0]?.id ?? "turn";
  const flushProcess = (live: boolean) => {
    if (!processParts.length) return;
    const group = processParts;
    processParts = [];
    const groupKey = `${turnKey}-process-${processIndex++}`;
    const time = Math.min(...group.map(({ messageIndex }) => messageTime(items, messageIndex) ?? Infinity));
    const stamp = Number.isFinite(time) ? time : undefined;
    const thoughts = group.filter(({ part, active }) => part.type === "thinking" && (Boolean(part.thinking?.trim()) || (active && thinking)));
    const toolParts = group.filter(({ part }) => part.type === "toolCall");
    const latestThought = thoughts.at(-1);
    if (latestThought) {
      progress.push({ node: <Thinking key={`${groupKey}-thinking`} text={latestThought.part.thinking ?? ""} running={live && streaming} />, time: stamp });
    }
    if (toolParts.length > 0) {
      const toolRows = toolParts.map(({ part, key, active }) => <PartView key={key} part={part} tools={tools} running={active} thinking={false} />);
      progress.push({
        node: <ToolActivityGroup
          key={`${groupKey}-tools`}
          toolNames={toolParts.map(({ part }) => part.name ?? tools[part.id ?? ""]?.name ?? "工具")}
          running={toolParts.some(({ part }) => tools[part.id ?? ""]?.running)}
          hasError={toolParts.some(({ part }) => tools[part.id ?? ""]?.isError)}
        >
          {toolRows}
        </ToolActivityGroup>,
        time: stamp,
      });
    }
  };

  for (const { part, key, active, messageIndex } of content) {
    if (part.type === "toolCall" || part.type === "thinking") {
      processParts.push({ part, key, active, messageIndex });
      continue;
    }
    if (part.type === "text" && !part.text?.trim()) continue;
    flushProcess(false);
    const node = <PartView key={key} part={part} tools={tools} running={active} thinking={active && thinking} />;
    if (hasFinalResponse && messageIndex === items.length - 1 && (part.type === "text" || part.type === "image")) {
      body.push(node);
    } else {
      progress.push({ node, time: messageTime(items, messageIndex) });
    }
  }
  flushProcess(true);
  if (activity && !activityConsumed) {
    const node = <Fragment key={`${turnKey}-agent-activity`}>{activity}</Fragment>;
    if (activityTime !== undefined && Number.isFinite(activityTime)) {
      // Insert after the last block that happened before the agents spawned.
      let index = 0;
      while (index < progress.length && (progress[index].time ?? Infinity) <= activityTime) index += 1;
      progress.splice(index, 0, { node, time: activityTime });
    } else {
      progress.push({ node });
    }
    activityConsumed = true;
  }
  return { progress: progress.map(entry => entry.node), media, body, defaultExpanded: !hasFinalResponse, activityIndex: undefined, activityConsumed };
}

function responseText(content: ProjectedPart[]) {
  return content.flatMap(({ part }) => part.type === "text" && part.text?.trim() ? [part.text] : []).join("\n\n");
}

type MessageNodes = ReturnType<typeof buildNodes>;

function TranscriptBody({ item, items, nodes, role, streaming, startedAt, elapsedMs, text, copied, onCopied, activity }: {
  item: DisplayMessage;
  items: DisplayMessage[];
  nodes: MessageNodes;
  role: "user" | "assistant";
  streaming: boolean;
  startedAt?: number;
  elapsedMs?: number;
  text: string;
  copied: boolean;
  onCopied: () => void;
  activity?: ReactNode;
}) {
  const renderedActivity = nodes.activityConsumed ? undefined : activity;
  const hasProgress = nodes.progress.length > 0 || Boolean(renderedActivity);
  const hasContent = hasProgress || nodes.body.length > 0;
  const activityIndex = nodes.activityIndex ?? nodes.progress.length;
  return <Message from={role}>
    {nodes.media.length > 0 && <div className="user-message-media">{nodes.media}</div>}
    {hasContent && <MessageContent>
      {hasProgress && <ProcessingPanel key={`${item.id}-${streaming ? "running" : "complete"}`} running={streaming} defaultExpanded={nodes.defaultExpanded} startedAt={startedAt} durationMs={elapsedMs}>{nodes.progress.slice(0, activityIndex)}{renderedActivity}{nodes.progress.slice(activityIndex)}</ProcessingPanel>}
      {nodes.body}
    </MessageContent>}
    {text && (role === "user" || !streaming) && <MessageCopyFooter message={items.at(-1)!.message} role={role} text={text} time={role === "user" ? turnTime(items) : null} copied={copied} onCopied={onCopied} />}
  </Message>;
}


function TranscriptMessageComponent({ items, tools, streaming, thinking, elapsedMs, activity, activityTime }: TranscriptMessageProps) {
  const item = items[0];
  const role = item.message.role === "user" ? "user" : "assistant";
  const [copied, setCopied] = useState(false);
  const special = specialMessage(item);
  if (special) return special;
  const content = projectParts(items, streaming);
  const nodes = buildNodes(content, items, tools, streaming, thinking, role, activity, activityTime);
  const finalOnly = role === "assistant" && !nodes.defaultExpanded;
  const text = responseText(finalOnly ? content.filter(part => part.messageIndex === items.length - 1) : content);
  if (nodes.progress.length === 0 && nodes.body.length === 0 && nodes.media.length === 0 && !activity) return null;
  const startedAt = items.find(entry => entry.startedAt !== undefined)?.startedAt;
  const markCopied = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); };
  return <m.div className={`transcript-message ${role}`} initial={streaming ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
    <TranscriptBody item={item} items={items} nodes={nodes} role={role} streaming={streaming} startedAt={startedAt} elapsedMs={elapsedMs} text={text} copied={copied} onCopied={markCopied} activity={activity} />
  </m.div>;
}

export const TranscriptMessage = memo(TranscriptMessageComponent, (previous, next) => {
  if (previous.streaming !== next.streaming || previous.thinking !== next.thinking || previous.elapsedMs !== next.elapsedMs || previous.activity !== next.activity || previous.items.length !== next.items.length || previous.items.some((item, index) => item !== next.items[index])) return false;
  const content = previous.items.flatMap(item => Array.isArray(item.message.content) ? item.message.content : []);
  return content.every(part => part.type !== "toolCall" || previous.tools[part.id ?? ""] === next.tools[part.id ?? ""]);
});
