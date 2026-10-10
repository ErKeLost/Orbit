import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspace, useWorkspaceStore } from "../../lib/store";
import { changeSession, getSessionTurnDurations, persistedSessionFile, report } from "../../lib/rpc";
import type { AgentNode } from "../../lib/agents";
import { groupDisplayMessages, reuseGroups, type Transcript } from "../../lib/protocol";
import { readTurnDurations, saveTurnDurations, turnDurationId } from "../../lib/turn-duration";
import { useProjects } from "../../lib/projects";
import { riseIntoAnchor, useConversationScroll } from "../../hooks/use-conversation-scroll";
import { TranscriptJumpToBottom, useTranscriptJumpVisibility } from "./TranscriptJumpToBottom";
import { useSelectionHighlight } from "../../hooks/use-selection-highlight";
import { useTranscriptSelection } from "./useTranscriptSelection";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
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

/** 发送后的定位由 lastUserId 变化驱动（Orbit 同款），输入框不需要通知。 */
const noop = () => undefined;

export function ChatPane() {
  const project = useWorkspace((state) => state.cwd);
  const runtimeTarget = useWorkspace((state) => state.runtimeTarget);
  const agents = useWorkspace((state) => state.agents);
  const statuses = useWorkspace((state) => state.statuses);
  const connection = useWorkspace((state) => state.connection);
  const transcript = useFrameStream();
  const busy = transcript.running || transcript.submitted;
  // Orbit 的 `lastUserBlockId`：换了一条新提示就重新跟随、贴底。用户消息条数
  // 作键——乐观预览被真正投递的消息替换时 id 会变，但那还是同一条提示。
  const userTurns = useMemo(() => transcript.messages.reduce((count, item) => (item.message.role === "user" ? count + 1 : count), 0), [transcript.messages]);
  const lastUserId = userTurns > 0 ? String(userTurns) : null;
  const jumpVisibility = useTranscriptJumpVisibility();
  const { scroller: ref, scrollerEl, setScroller, jumpToBottom } = useConversationScroll({
    lastUserId,
    content: transcript.messages,
    busy,
    onJumpChange: jumpVisibility.setVisible,
  });
  // Stretch the last turn after a send while this pane stays mounted. A remount
  // is a new visit: it uses the true transcript height so the latest reply sits
  // near the composer instead of a hole of empty space (Orbit `anchorTurn`).
  const [anchorTurn, setAnchorTurn] = useState(busy);
  const seenUserTurns = useRef(userTurns);
  if (userTurns !== seenUserTurns.current) {
    // 只有「多了一条提示」才是发送；切会话/重连 hydrate 一次换进整段历史不算。
    const sent = !transcript.loading && userTurns === seenUserTurns.current + 1;
    seenUserTurns.current = userTurns;
    if (sent && !anchorTurn) setAnchorTurn(true);
  }
  // WKWebView 会把原生选区的间隙涂满选区色；挂载后聊天区改用 Custom
  // Highlight API 只重绘文字（样式见 orbit.css 的 custom-selection-highlight）。
  useSelectionHighlight(ref);
  // 选中回答文字后弹出浮动复制条（Orbit 同款交互）。
  const { selection: textSelection, dismissSelection: dismissTextSelection } = useTranscriptSelection(scrollerEl, true);
  const sessionFile = useWorkspace((state) => state.state?.sessionFile) ?? persistedSessionFile(project);
  const dockPosition = useShell((state) => state.terminalPosition);
  const dockOpen = useShell((state) => state.terminalOpen);
  // The dock is a real PTY on the desktop and an xterm.js view here; what makes
  // that work on a phone is that `pty_spawn`/`pty_write`/`pty_resize` are
  // mirrored commands and the output is republished over the socket as
  // `pty.event` (`src/lib/remote-pty.ts`). Nothing in the dock knows which
  // machine it is drawing.
  const terminalAvailable = true;
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
  // After a send, the turn owning the newest prompt is stretched to a pane.
  const anchorFrom = anchorTurn
    ? groups.reduce((found, group, index) => (group.items[0]?.message.role === "user" ? index : found), -1)
    : -1;

  // A sent prompt rises from the upper screen into its anchored spot at the
  // top. On mount this only plays for a session's first send.
  const introducePrompt = useRef({ anchor: false });
  introducePrompt.current = { anchor: anchorTurn };
  const introducedPromptMount = useRef(false);
  useLayoutEffect(() => {
    const mounting = !introducedPromptMount.current;
    introducedPromptMount.current = true;
    if (!lastUserId || !introducePrompt.current.anchor) return;
    if (mounting && !(busy && userTurns === 1)) return;
    const row = [...transcript.messages].reverse().find((item) => item.message.role === "user");
    if (!row) return;
    return riseIntoAnchor(ref.current, row.id);
    // Only a new prompt starts the motion; later renders must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUserId]);
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
        <EmptySession cwd={project} onSubmitted={noop} />
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
      {/* Kept content during a reconnect: the screen is still the session the
          user left, and saying so is the difference between "it is thinking"
          and "it is lying to me". */}
      {connection === "connecting" && transcript.messages.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center">
          <span className="mt-2 rounded-full border border-stroke/60 bg-background-base/85 px-2.5 py-1 text-[11px] text-content/60 backdrop-blur">正在重连电脑…</span>
        </div>
      ) : null}
      <div className="@container relative min-h-0 flex-1 transcript-composer-fade">
        <div ref={setScroller} className="agent-transcript h-full overflow-y-auto overscroll-none font-mono text-[13px] leading-5 [overflow-anchor:none]">
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
        <TranscriptJumpToBottom visibility={jumpVisibility} onJump={jumpToBottom} />
        <TranscriptSelectionMenu selection={textSelection} onDismiss={dismissTextSelection} />
      </div>
      {Object.entries(statuses).flatMap(([key, value]) => (!key.startsWith("gui-") && value ? [<div key={key} className="extension-status">{key}: {value}</div>] : []))}
      {/* Sending anchors the turn to the top instead of pinning to the bottom. */}
      <Composer onSubmitted={noop} />
      </div>
      {dockPosition === "bottom" || dockPosition === "right" ? dock : null}
    </div>
  );
}
