import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspace, useWorkspaceStore } from "../../lib/store";
import { changeSession, getSessionTurnDurations, persistedSessionFile, report } from "../../lib/rpc";
import type { AgentNode } from "../../lib/agents";
import { groupDisplayMessages, reuseGroups, type Transcript } from "../../lib/protocol";
import { readTurnDurations, saveTurnDurations, turnDurationId } from "../../lib/turn-duration";
import { useProjects } from "../../lib/projects";
import { useConversationScroll } from "../../hooks/use-conversation-scroll";
import { useSelectionHighlight } from "../../hooks/use-selection-highlight";
import { useTranscriptSelection } from "./useTranscriptSelection";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { ChevronDown } from "../../shared/ui/icons";
import { AgentActivityFeed } from "../../components/agents/AgentActivityFeed";
import { GalaxyDotBackground } from "../background/GalaxyDotBackground";
import { TerminalDock } from "../terminal/TerminalDock";
import { useShell } from "../shell/shellStore";
import { useAppearance } from "../../lib/appearance";
import { ErrorRow, InitialWorking, TranscriptGroupView, TranscriptSkeleton, type TranscriptGroup } from "./Transcript";
import { Composer } from "./Composer";
import { PromptOutline } from "./PromptOutline";

const groupCache = new WeakMap<object, ReturnType<typeof groupDisplayMessages>>();

/**
 * Commits the streaming transcript to React once per animation frame while a
 * turn runs (Orbit's foreground cadence), and synchronously when idle.
 */
function useFrameStream() {
  // Per-frame streaming: read the store this pane is scoped to, so a background
  // session pane keeps streaming its own transcript.
  const store = useWorkspaceStore();
  const [view, setView] = useState<Transcript>(() => store.getState().transcript);
  useEffect(() => {
    const read = () => store.getState().transcript;
    let frame = 0;
    const commit = () => {
      frame = 0;
      const next = read();
      setView((current) => (current === next ? current : next));
    };
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.transcript === previous.transcript) return;
      if (!state.transcript.running) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        commit();
        return;
      }
      if (!frame) frame = requestAnimationFrame(() => startTransition(commit));
    });
    commit();
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [store]);
  return view;
}

/** Orbit's `EmptySession`: the galaxy backdrop with the composer centered on it. */
function EmptySession({ cwd, onSubmitted }: { cwd: string; onSubmitted: () => void }) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const projects = useProjects((state) => state.projects);
  const homeDir = useWorkspace((state) => state.homeDir);
  const project = cwd && cwd !== homeDir ? (projects.find((item) => item.path === cwd)?.name ?? cwd.split(/[\\/]/).filter(Boolean).at(-1)) : null;
  const title = project ? `What should we work on in ${project}?` : "What should we work on?";
  return (
    <div ref={lockOverscroll} className="relative flex h-full min-h-0 overflow-y-auto overscroll-none">
      <GalaxyDotBackground />
      <div className="pointer-events-none relative z-10 mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-1.5 py-12">
        <div className="pointer-events-auto mb-4 px-2.5">
          <h1 className="truncate text-lg text-content" title={project ? cwd : undefined}>{title}</h1>
        </div>
        <div className="pointer-events-auto w-full">
          <Composer onSubmitted={onSubmitted} centered />
        </div>
      </div>
    </div>
  );
}

/** Orbit's chat background: a fixed image behind the transcript and composer. */
function ChatBackground() {
  const path = useAppearance((state) => state.chatBackground);
  if (!path) return null;
  return (
    <div aria-hidden className="chat-pane-background pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <img src={convertFileSrc(path)} alt="" className="h-full w-full object-cover opacity-[0.22]" />
    </div>
  );
}

export function ChatPane() {
  const project = useWorkspace((state) => state.cwd);
  const runtimeTarget = useWorkspace((state) => state.runtimeTarget);
  const agents = useWorkspace((state) => state.agents);
  const statuses = useWorkspace((state) => state.statuses);
  const transcript = useFrameStream();
  const holdStickRef = useRef(false);
  // 发送那一刻置位（onSubmitted 在乐观追加渲染前同步调用），锚定接管后由
  // rAF 与 settle 清除；窗口期内贴底逻辑整体挂起，避免先拽到底再拉回来。
  const beginAnchoredSend = useCallback(() => {
    holdStickRef.current = true;
  }, []);
  const { ref, atBottom, userUnpinned, scrollToBottom, pauseFollow } = useConversationScroll({ holdStickRef });
  // WKWebView 会把原生选区的间隙涂满选区色；挂载后聊天区改用 Custom
  // Highlight API 只重绘文字（样式见 orbit.css 的 custom-selection-highlight）。
  useSelectionHighlight(ref);
  // 选中回答文字后弹出浮动复制条（Orbit 同款交互）。
  const { selection: textSelection, dismissSelection: dismissTextSelection } = useTranscriptSelection(ref.current, true);
  const sessionFile = useWorkspace((state) => state.state?.sessionFile) ?? persistedSessionFile(project);
  const dockPosition = useShell((state) => state.terminalPosition);
  const dockOpen = useShell((state) => state.terminalOpen);
  // The dock needs the PTY's output, which travels as a desktop event
  // (`pty-data`) that has no remote counterpart yet. On a phone the dock would
  // take keystrokes and show nothing, so it stays closed until that stream is
  // mirrored; `open_pi_terminal` already opens a real terminal on the desktop.
  const terminalAvailable = useWorkspace((state) => state.runtimeTarget) !== "mobile";
  const historical = useQuery({
    queryKey: ["pi", "turn-durations", sessionFile],
    queryFn: () => getSessionTurnDurations(sessionFile),
    enabled: (runtimeTarget === "desktop" || runtimeTarget === "mobile") && Boolean(sessionFile),
    staleTime: Infinity,
  });
  const savedDurations = useMemo(() => ({ ...(historical.data ?? {}), ...readTurnDurations(sessionFile) }), [historical.data, sessionFile]);
  const [owner] = useState(() => ({}));

  const groups = useMemo<(TranscriptGroup & { indexes: number[] })[]>(() => {
    const raw = reuseGroups(groupCache.get(owner) ?? [], groupDisplayMessages(transcript.messages));
    groupCache.set(owner, raw);
    const claimed = new Set<number>();
    return raw.map((group) => {
      const startedAt = group.items.find((item) => item.startedAt !== undefined)?.startedAt;
      let elapsedMs = ([...group.items].reverse().find((item) => item.elapsedMs !== undefined)?.elapsedMs ?? savedDurations[turnDurationId(group.items) ?? ""]) as number | undefined;
      if (elapsedMs !== undefined) {
        if (claimed.has(elapsedMs)) elapsedMs = undefined;
        else claimed.add(elapsedMs);
      }
      return {
        id: group.id,
        items: group.items,
        indexes: group.indexes,
        startedAt: startedAt ?? (transcript.running && group.indexes.includes(transcript.active) ? transcript.turnStartedAt ?? undefined : undefined),
        elapsedMs,
      };
    });
  }, [owner, transcript.messages, transcript.running, transcript.active, transcript.turnStartedAt, savedDurations]);

  useEffect(() => {
    if (!sessionFile || transcript.running) return;
    const completed = Object.fromEntries(
      groups.flatMap((group) => {
        const id = turnDurationId(group.items);
        return id && group.elapsedMs !== undefined ? [[id, group.elapsedMs]] : [];
      }),
    );
    saveTurnDurations(sessionFile, completed);
  }, [groups, sessionFile, transcript.running]);

  // Orbit's `syncTranscriptViewport`: publish the usable pane height, which
  // `.transcript-turn-anchor` consumes as its minimum height.
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const sync = () => {
      const inner = scroller.querySelector<HTMLElement>("[data-transcript-content]");
      const pad = inner ? Number.parseFloat(getComputedStyle(inner).paddingBottom) || 0 : 0;
      scroller.style.setProperty("--transcript-viewport", `${Math.max(0, scroller.clientHeight - pad)}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ref]);

  const openAgent = useCallback((agent: AgentNode) => {
    if (agent.sessionPath) void changeSession({ type: "switch_session", sessionPath: agent.sessionPath }).catch(report);
  }, []);
  const activity = agents && (agents.active.length > 0 || agents.recent.length > 0) ? <AgentActivityFeed snapshot={agents} onOpenAgent={openAgent} /> : undefined;

  const activeGroup = groups.findIndex((group) => group.indexes.includes(transcript.active));
  const lastAssistant = [...groups].reverse().find((group) => group.items[0]?.message.role !== "user");
  // 最后一条 assistant 消息自带的错误已由轮内（AssistantTurn）渲染；底部横幅
  // 只展示不属于任何轮的错误（如 extension_error），避免同一个错误出现两次。
  const lastMessageError = useMemo(() => {
    for (let index = transcript.messages.length - 1; index >= 0; index--) {
      const message = transcript.messages[index].message;
      if (message.role === "assistant" && message.errorMessage) return message.errorMessage;
    }
    return undefined;
  }, [transcript.messages]);
  const activeHasOutput = transcript.running && activeGroup >= 0 && groups[activeGroup]?.items[0]?.message.role !== "user";
  const waiting = transcript.submitted || (transcript.running && !activeHasOutput) || transcript.compacting;
  // While a turn runs, the prompt owning the newest user block anchors the pane.
  const anchorFrom = transcript.running
    ? groups.reduce((found, group, index) => (group.items[0]?.message.role === "user" ? index : found), -1)
    : -1;
  // Orbit's `useTurnScrollAnchor` equivalent: when the anchored turn stops
  // stretching, its height collapses — put the difference back into scrollTop
  // so the reader's view does not jump.
  const lastUserMessage = [...transcript.messages].reverse().find((item) => item.message.role === "user");
  const lastUserMessageId = lastUserMessage?.id ?? null;
  const promptOffset = useRef<number | null>(null);
  const wasRunning = useRef(transcript.running);
  useLayoutEffect(() => {
    const scroller = ref.current;
    const row = scroller && lastUserMessage
      ? scroller.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(lastUserMessage.id)}"]`)
      : null;
    if (transcript.running) {
      // Track where the prompt sits while the turn is stretched.
      if (scroller && row) promptOffset.current = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      wasRunning.current = true;
      return;
    }
    const settled = wasRunning.current;
    wasRunning.current = false;
    if (!settled || !scroller || !row || promptOffset.current == null) return;
    const now = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += now - promptOffset.current;
    promptOffset.current = null;
    holdStickRef.current = false;
  });

  // A sent prompt aligns to the top of the pane and following stops: the answer
  // grows into the pane-tall anchored turn below it, and the view stays put.
  useEffect(() => {
    if (!transcript.running || anchorFrom < 0) return;
    const scroller = ref.current;
    if (!scroller) return;
    const frame = requestAnimationFrame(() => {
      const box = scroller.querySelector<HTMLElement>("[data-transcript-anchor]");
      if (!box) return;
      pauseFollow();
      const delta = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta - 8);
      holdStickRef.current = false;
      // 这一次滚动就是锚定本身，不是漂移：立刻把 prompt 锚定后的位置写回
      // promptOffset。否则一个没有任何中间流提交的短轮（1s 的空回复就够）
      // 结束时，settle 回写用的还是锚定前贴底的旧偏移，会把刚发出去的
      // 消息又滚回底部去。
      const row = lastUserMessageId
        ? scroller.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(lastUserMessageId)}"]`)
        : null;
      if (row) promptOffset.current = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorFrom, lastUserMessageId, pauseFollow, ref, transcript.running]);

  const runningLabel = transcript.compacting ? "正在压缩上下文" : transcript.phase && transcript.phase !== "就绪" ? transcript.phase : "Working…";
  const dockVertical = dockPosition === "top" || dockPosition === "bottom";
  const dock = dockOpen && terminalAvailable ? <TerminalDock cwd={project} open /> : null;

  // 会话还没到：骨架屏占位，不要停在旧会话的内容上再突然换掉。
  if (transcript.loading) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatBackground />
        <div className="relative z-10 min-h-0 flex-1 overflow-hidden">
          <TranscriptSkeleton />
        </div>
      </div>
    );
  }

  if (groups.length === 0 && !waiting) {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <EmptySession cwd={project} onSubmitted={beginAnchoredSend} />
      </div>
    );
  }

  const renderGroup = (group: (typeof groups)[number], index: number) => (
    <TranscriptGroupView
      key={group.id}
      group={group}
      tools={transcript.tools}
      streaming={transcript.running && index === activeGroup}
      activity={group === lastAssistant ? activity : undefined}
    />
  );

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-1 ${dockVertical ? "flex-col" : "flex-row"}`}>
      {dockPosition === "top" || dockPosition === "left" ? dock : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <ChatBackground />
      <div className="@container relative min-h-0 flex-1 transcript-composer-fade">
        <div ref={ref} className="agent-transcript h-full overflow-y-auto overscroll-none font-mono text-[13px] leading-5 [overflow-anchor:none]">
          {/* Orbit's chat transcript: top-aligned content whose newest turn
              reserves a pane of height (`transcript-turn-anchor`), so a prompt
              sent with the transcript pinned to the bottom sits at the top. */}
          <div data-transcript-content className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-1 pb-8">
            {anchorFrom < 0 ? (
              <>
                {groups.map(renderGroup)}
                {waiting ? <InitialWorking label={runningLabel} startedAt={transcript.turnStartedAt} /> : null}
              </>
            ) : (
              <>
                {groups.slice(0, anchorFrom).map(renderGroup)}
                {/* The running turn holds its prompt, answer and status line, and
                    is stretched to a pane (`.transcript-turn-anchor`). Pinned to
                    the bottom, that pane-tall turn shows the prompt at its top
                    with the rest of the pane free — Orbit's stretched turn. */}
                <div data-transcript-anchor className="transcript-turn transcript-turn-anchor flex min-w-0 flex-col">
                  {groups.slice(anchorFrom).map((group, offset) => renderGroup(group, anchorFrom + offset))}
                  {waiting ? <InitialWorking label={runningLabel} startedAt={transcript.turnStartedAt} /> : null}
                </div>
              </>
            )}
            {transcript.error && !transcript.running && transcript.error !== lastMessageError ? <ErrorRow error={transcript.error} /> : null}
          </div>
        </div>
        <PromptOutline messages={transcript.messages} scope={ref} />
        {/* 只在用户自己滚离底部时出现；发送后锚定到顶部的程序化定位不算。 */}
        {!atBottom && userUnpinned ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-30 flex justify-center">
            <button
              type="button"
              title="跳到最新"
              aria-label="跳到最新"
              onClick={() => { holdStickRef.current = false; scrollToBottom(); }}
              className="pointer-events-auto grid size-6 place-items-center rounded-full bg-accent text-white shadow-lg hover:bg-accent/85"
            >
              <ChevronDown className="size-4" strokeWidth={2} />
            </button>
          </div>
        ) : null}
        <TranscriptSelectionMenu selection={textSelection} onDismiss={dismissTextSelection} />
      </div>
      {Object.entries(statuses).flatMap(([key, value]) => (!key.startsWith("gui-") && value ? [<div key={key} className="extension-status">{key}: {value}</div>] : []))}
      {/* Sending anchors the turn to the top instead of pinning to the bottom. */}
      <Composer onSubmitted={beginAnchoredSend} />
      </div>
      {dockPosition === "bottom" || dockPosition === "right" ? dock : null}
    </div>
  );
}
