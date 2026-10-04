import { Wifi } from "lucide-react";
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type RefObject } from "react";
import { m } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../lib/store";
import { changeSession, getSessionTurnDurations, persistedSessionFile, report } from "../lib/rpc";
import type { AgentNode } from "../lib/agents";
import { assignTurnClocks, formatTranscriptError, groupDisplayMessages, reuseGroups, type Transcript } from "../lib/protocol";
import type { Telemetry } from "../lib/telemetry";
import { readTurnDurations, saveTurnDurations, turnDurationId } from "../lib/turn-duration";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import { useConversationScroll } from "../hooks/use-conversation-scroll";
import { useSelectionHighlight } from "../hooks/use-selection-highlight";
import LoadingState from "./ai-elements/loading-state";
import ProximitySidebar, { type ProximitySection } from "./ui/proximity-sidebar";
import { ChatComposer } from "./chat/ChatComposer";
import { ErrorOutput, TranscriptMessage } from "./chat/TranscriptMessage";
import { hasSectionMedia, messageKind, sectionPreview, sectionPreviewAfterHeading, sectionText } from "../lib/conversation-sections";
import { AgentActivityFeed } from "./agents/AgentActivityFeed";
import { normalizeSelectionText } from "../lib/clipboard";
import { isLowPerf } from "../lib/perf-tier";

const groupCache = new WeakMap<object, ReturnType<typeof groupDisplayMessages>>();

// 流式期间提交到 React 的间隔：低配机器拉长，换取主线程余量。
const STREAM_COMMIT_MS = isLowPerf ? 200 : 100;

function copyConversationSelection(event: ReactClipboardEvent<HTMLDivElement>) {
  const text = normalizeSelectionText(window.getSelection()?.toString() ?? "");
  if (!text) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
}

/**
 * 流式期间把 transcript / telemetry 的提交节流到 ~intervalMs 一次。
 *
 * 旧实现是 `useWorkspace(整个对象)` + effect + setState：每次 store 更新 Chat 都先用旧值
 * 渲染一轮（拿到的还是节流前的值），effect 再 setState 触发第二轮。这里改成在 React 之外
 * 订阅 store：中间的更新直接丢弃，不产生任何渲染；到点才 setState 一次，并用 transition
 * 标成低优先级，让输入和点击始终排在前面。非流式时同步直通，落定/工具结果立即生效。
 */
function useThrottledStream(intervalMs: number) {
  const read = () => {
    const { transcript, telemetry } = useWorkspace.getState();
    return { transcript, telemetry };
  };
  const [view, setView] = useState(read);
  useEffect(() => {
    let timer = 0;
    let lastCommit = 0;
    const commit = () => {
      timer = 0;
      lastCommit = performance.now();
      const next = read();
      setView(current => current.transcript === next.transcript && current.telemetry === next.telemetry ? current : next);
    };
    const unsubscribe = useWorkspace.subscribe((state, previous) => {
      if (state.transcript === previous.transcript && state.telemetry === previous.telemetry) return;
      if (!state.transcript.running) {
        // 空闲：立即同步提交（含刚结束的那一次），并撤销待提交的定时器。
        if (timer) { window.clearTimeout(timer); timer = 0; }
        commit();
        return;
      }
      if (timer) return;
      timer = window.setTimeout(() => startTransition(commit), Math.max(0, intervalMs - (performance.now() - lastCommit)));
    });
    commit();
    return () => { unsubscribe(); if (timer) window.clearTimeout(timer); };
  }, [intervalMs]);
  return view;
}

function useConversationSections(
  conversationRef: RefObject<HTMLDivElement | null>,
  proximityId: string,
  paused: boolean,
) {
  const [sections, setSections] = useState<ProximitySection[]>([]);
  useEffect(() => {
    const conversation = conversationRef.current;
    // 流式输出时每个字符都会触发 MutationObserver；目录不需要实时，
    // 冻结扫描，流结束后重扫一次，避免每帧全量 DOM 遍历。
    if (paused || !conversation) return;
    let frame = 0;
    const scan = () => {
      frame = 0;
      const blocks = Array.from(conversation.querySelectorAll<HTMLElement>(".transcript-message")).flatMap(message => {
        if (message.classList.contains("user")) return [message.querySelector<HTMLElement>(".ai-message-content") ?? message];
        const children = Array.from(message.querySelectorAll<HTMLElement>(
          ".turn-activity, .message-image, .transcript-error, .transcript-compaction, .bash-execution-card, .ai-message-response.markdown-static .streamdown-animated > *",
        )).filter(element => !element.matches("style, script") && Boolean(sectionText(element) || hasSectionMedia(element)));
        return children.length > 0 ? children : [message];
      });
      const contentBlocks = blocks.filter(block => {
        const text = sectionText(block);
        return Boolean(text || hasSectionMedia(block));
      });
      const next = contentBlocks.map<ProximitySection>((block, index) => {
        const id = `${proximityId}-section-${index + 1}`;
        const heading = block.matches("h1, h2, h3") ? block : block.querySelector<HTMLElement>("h1, h2, h3");
        const level = heading?.tagName === "H1" ? 1 : heading?.tagName === "H2" ? 2 : heading?.tagName === "H3" ? 3 : undefined;
        // 写入 id 会自触发 observer（rAF 已合并），仅在变化时写避免每帧白跑
        if (block.id !== id) block.id = id;
        const text = sectionText(block);
        const kind = messageKind(block);
        const fallbackTitle = block.matches("img") || block.querySelector("img") ? "图片" : block.matches("pre") || block.querySelector("pre") ? "代码" : block.matches("table") || block.querySelector("table") ? "表格" : block.closest(".transcript-message.user") ? "你的消息" : ({ title: "标题", section: "运行记录", body: "助手回复" }[kind] ?? "助手回复");
        const title = heading?.textContent?.replace(/\s+/g, " ").trim().slice(0, 48) || fallbackTitle;
        return {
          id,
          label: title,
          preview: heading ? sectionPreviewAfterHeading(heading) : text && text !== title ? sectionPreview(block) : undefined,
          // 纯文本签名（textContent 已在 sectionText 读取），替代 innerHTML 全量序列化
          previewVersion: text,
          ...(level ? { level: level as 1 | 2 | 3 } : { kind: messageKind(block) }),
        };
      }).filter(section => section.level === 1 || section.level === 2);
      setSections(current => current.length === next.length && current.every((section, index) => section.id === next[index]?.id && section.label === next[index]?.label && section.previewVersion === next[index]?.previewVersion) ? current : next);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(scan);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(conversation, { childList: true, characterData: true, subtree: true });
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [conversationRef, proximityId, paused]);
  return sections;
}

function deriveRunStatus(transcript: Transcript, telemetry: Telemetry) {
  const retry = telemetry.retry;
  const retrying = retry?.status === "waiting" || retry?.status === "running";
  const retryDetail = retrying && retry
    ? `第 ${Number.isFinite(retry.attempt) ? retry.attempt : "?"}${retry.maxAttempts && Number.isFinite(retry.maxAttempts) ? ` / ${retry.maxAttempts}` : ""} 次${retry.delayMs && Number.isFinite(retry.delayMs) ? ` · 等待 ${retry.delayMs} ms` : ""} · ${retry.error ? formatTranscriptError(retry.error) : "原因未提供"}`
    : undefined;
  const compacting = transcript.compacting || telemetry.compaction?.status === "running";
  const compactionReason = telemetry.compaction?.reason;
  const compactionDetail = compacting
    ? ({ manual: "手动", threshold: "达到阈值", overflow: "上下文溢出" }[compactionReason ?? ""] ?? compactionReason)
    : undefined;
  const activeMessage = transcript.messages[transcript.active]?.message;
  const activeHasOutput = Boolean(
    Array.isArray(activeMessage?.content)
      ? activeMessage.content.some(part => part.type === "toolCall" || part.type === "image" || Boolean(part.text?.trim()) || Boolean(part.thinking?.trim()) || (transcript.running && part.type === "thinking"))
      : typeof activeMessage?.content === "string" && activeMessage.content.trim(),
  ) || Object.values(transcript.tools).some(tool => tool.running);
  return { retrying, retryDetail, compacting, compactionDetail, activeHasOutput };
}

export function Chat() {
  const project = useWorkspace(state => state.cwd);
  const runtimeTarget = useWorkspace(state => state.runtimeTarget);
  // 流式期间的高频更新在 React 之外节流（~10Hz，低配 5Hz），并以 transition 提交。
  const { transcript, telemetry } = useThrottledStream(STREAM_COMMIT_MS);
  const agents = useWorkspace(state => state.agents);
  const { ref, atBottom, scrollToBottom } = useConversationScroll();
  const proximityId = useId().replace(/[^a-zA-Z0-9_-]/g, "") || "conversation";
  const proximitySections = useConversationSections(ref, proximityId, transcript.running);
  const sessionFile = useWorkspace(state => state.state?.sessionFile) ?? persistedSessionFile(project);
  const historicalDurations = useQuery({
    queryKey: ["pi", "turn-durations", sessionFile],
    queryFn: () => getSessionTurnDurations(sessionFile),
    enabled: (runtimeTarget === "desktop" || runtimeTarget === "mobile") && Boolean(sessionFile),
    staleTime: Infinity,
  });
  const savedDurations = useMemo(() => ({
    ...(historicalDurations.data ?? {}),
    ...readTurnDurations(sessionFile),
  }), [historicalDurations.data, sessionFile]);
  // Steer/follow-up splits one turn into several assistant groups sharing the
  // same turnStartedAt; resolve each group's duration (runtime or saved) and
  // keep one claim per identical value so the turn duration shows once.
  // 上一次的分组放在组件实例私有的 WeakMap 里（key 是每个实例一个的空对象），渲染中不碰 ref。
  const [groupOwner] = useState(() => ({}));
  const messageGroups = useMemo(() => {
    // 历史组复用上一次的对象（含 items 数组引用），TranscriptMessage 的 memo 一步命中。
    const groups = reuseGroups(groupCache.get(groupOwner) ?? [], groupDisplayMessages(transcript.messages)).map(group => ({
      ...group,
      startedAt: group.items.find(item => item.startedAt !== undefined)?.startedAt,
      elapsedMs: ([...group.items].reverse().find(item => item.elapsedMs !== undefined)?.elapsedMs
        ?? savedDurations[turnDurationId(group.items) ?? ""]) as number | undefined,
    }));
    groupCache.set(groupOwner, groups.map(({ id, items, indexes }) => ({ id, items, indexes })));
    const claimed = new Set<number>();
    for (const group of groups) {
      if (group.elapsedMs === undefined || claimed.has(group.elapsedMs)) group.elapsedMs = undefined;
      else claimed.add(group.elapsedMs);
    }
    // 一次 turn 只在最上面那段显示「正在处理 Xs / 用时 Xs」；被 steer 拆出来的
    // 后续段一律 hidden，只显示「处理过程」，不再在下面重复一个正在处理。
    const clocks = assignTurnClocks(groups, { running: transcript.running, turnStartedAt: transcript.turnStartedAt });
    return groups.map((group, index) => ({ ...group, clock: clocks[index] }));
  }, [groupOwner, transcript.messages, transcript.running, transcript.turnStartedAt, savedDurations]);
  const { retrying, retryDetail, compacting, compactionDetail, activeHasOutput } = deriveRunStatus(transcript, telemetry);
  const openAgent = useCallback((agent: AgentNode) => {
    if (!agent.sessionPath) return;
    void changeSession({ type: "switch_session", sessionPath: agent.sessionPath }).catch(report);
  }, []);
  const agentStartedAt = useMemo(() => {
    if (!agents) return undefined;
    const times = [...agents.active, ...agents.recent].map(agent => agent.startedAt).filter((time): time is number => typeof time === "number" && Number.isFinite(time));
    return times.length ? Math.min(...times) : undefined;
  }, [agents]);

  useEffect(() => {
    if (!sessionFile || transcript.running) return;
    const completed = Object.fromEntries(messageGroups.flatMap(group => {
      const id = turnDurationId(group.items);
      return id && group.elapsedMs !== undefined ? [[id, group.elapsedMs]] : [];
    }));
    saveTurnDurations(sessionFile, completed);
  }, [messageGroups, sessionFile, transcript.running]);

  const chatRootRef = useRef<HTMLDivElement | null>(null);
  useSelectionHighlight(chatRootRef);

  // 将消息列的实际渲染宽度镜像给 composer：两者宽度逐像素一致，
  // 滚动条占位、WebView 差异都无法再造成错位。
  // 性能关键点：流式输出时消息列高度每帧都在涨，ResizeObserver 每帧都会
  // 进来，但宽度几乎从不变。变量必须做「值变化才写入」，否则每帧 3 次
  // setProperty 会让整棵 chat 子树重新计算样式；且变量写在 dock 上而非
  // 根节点，把样式失效范围限制在 composer 内（宽度对 composer 本来就
  // 恒定，写入量趋近于零）。
  useEffect(() => {
    const root = chatRootRef.current;
    const content = root?.querySelector<HTMLElement>(".tessera-conversation > .ai-conversation-content");
    const scroller = root?.querySelector<HTMLElement>(".tessera-conversation");
    const dock = root?.querySelector<HTMLElement>(".composer-container.tessera-composer-dock");
    if (!root || !content || !scroller || !dock) return;
    const applied = new Map<string, string>();
    const setVar = (name: string, value: string) => {
      if (applied.get(name) === value) return;
      applied.set(name, value);
      dock.style.setProperty(name, value);
    };
    const apply = () => {
      const contentRect = content.getBoundingClientRect();
      const dockRect = dock.getBoundingClientRect();
      setVar("--chat-content-inline-size", `${contentRect.width}px`);
      setVar("--chat-content-offset", `${contentRect.left - dockRect.left}px`);
      setVar("--chat-scrollbar-space", `${scroller.offsetWidth - scroller.clientWidth}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(content);
    observer.observe(scroller);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
      for (const name of applied.keys()) dock.style.removeProperty(name);
    };
  }, []);

  return <div className="chat-root tessera-thread-root" ref={chatRootRef}>
    {proximitySections.length > 0 && <ProximitySidebar
      sections={proximitySections}
      side="left"
      className="conversation-proximity-sidebar"
      onSelectSection={id => {
        const target = document.getElementById(id);
        const activity = target?.closest<HTMLElement>(".turn-activity");
        if (activity?.dataset.open === "false") activity.querySelector<HTMLButtonElement>(".turn-activity-header")?.click();
        const disclosure = target?.closest<HTMLElement>(".message-response-disclosure");
        if (disclosure?.dataset.collapsible === "true" && disclosure.dataset.open === "false") disclosure.querySelector<HTMLButtonElement>(".message-response-toggle")?.click();
      }}
    />}
    <Conversation ref={ref} className="chat-conversation tessera-conversation" onCopy={copyConversationSelection}>
      <ConversationContent className="tessera-conversation-content">
        {messageGroups.map(group => {
          const active = group.indexes.includes(transcript.active);
          return <TranscriptMessage
            key={group.id}
            items={group.items}
            tools={transcript.tools}
            streaming={transcript.running && active}
            thinking={transcript.running && active && !group.items.at(-1)?.message.stopReason}
            elapsedMs={group.elapsedMs}
            clock={group.clock}
            activity={active && agents && (agents.active.length > 0 || agents.recent.length > 0) ? <AgentActivityFeed snapshot={agents} onOpenAgent={openAgent} /> : undefined}
            activityTime={active ? agentStartedAt : undefined}
          />;
        })}
        {transcript.error && !transcript.running && <m.div className="transcript-message assistant" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}><ErrorOutput error={transcript.error} /></m.div>}
        {(compacting || retrying || transcript.submitted || (transcript.running && !activeHasOutput)) && <LoadingState icon={retrying && !compacting ? <Wifi size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" /> : undefined} className="chat-loading-state" label={compacting ? "正在压缩上下文" : (transcript.phase || "正在处理")} detail={compacting ? compactionDetail : retryDetail} />}
      </ConversationContent>
      {!atBottom && <ConversationScrollButton onClick={scrollToBottom} />}
    </Conversation>
    <ChatComposer onSubmitted={scrollToBottom} />
  </div>;
}
