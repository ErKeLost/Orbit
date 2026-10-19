import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspace, useWorkspaceStore } from "../../lib/store";
import { getSessionTurnDurations, persistedSessionFile, report } from "../../lib/rpc";
import { useWorkspaceTabs } from "../shell/use-workspace-tabs";
import type { AgentNode } from "../../lib/agents";
import { groupDisplayMessages, reuseGroups, type Transcript } from "../../lib/protocol";
import { readTurnDurations, saveTurnDurations, turnDurationId, turnElapsedMs } from "../../lib/turn-duration";
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
import { CHAT_PANE_ID, useShell } from "../shell/shellStore";
import { useAppearance } from "../../lib/appearance";
import { ErrorRow, InitialWorking, TranscriptGroupView, TranscriptSkeleton, type TranscriptGroup } from "./Transcript";
import { Composer } from "./Composer";
import { PromptOutline } from "./PromptOutline";

/**
 * 分组缓存按「连接」（SessionScope 的 facade store）缓存，而不是按这次挂载：
 * 切标签页/切项目会重挂 ChatPane，但同一个连接的 facade 是稳定的，重挂时直接
 * 命中上一次的分组结果（`reuseGroups` 还保证流式 tick 之间只重算最后一组），
 * 长会话回来时不再从头分组一遍。
 */
const groupCache = new WeakMap<object, ReturnType<typeof groupDisplayMessages>>();

/**
 * 渲染层的分组对象也按原始分组缓存：`memo(TranscriptGroupView)` 比的是 props
 * 引用，如果每帧都给所有分组新建一个 `{id, items, indexes, ...}` 包装对象，
 * 那 memo 就等于没写——一条 300 组的长会话会跟着每个流式帧整屏重渲染。
 * 值没变就交回同一个对象，只有真正在变的那一组（正在流式的那一组）换引用。
 */
const groupViewCache = new WeakMap<object, TranscriptGroup & { indexes: number[] }>();

/**
 * 一组的「基础时间」（提示段开始时间、从历史里读到的耗时）只跟这一组和
 * `savedDurations` 有关。流式时每帧都会重算整张表，但它们没变：按组对象缓存，
 * 每个流式帧就只剩正在变的那一组需要真算。
 */
type GroupBaseTimes = { durations: Readonly<Record<string, number>>; startedAt?: number; elapsedMs?: number };
const groupTimeCache = new WeakMap<object, GroupBaseTimes>();

function groupBaseTimes(group: { items: TranscriptGroup["items"] }, durations: Readonly<Record<string, number>>): GroupBaseTimes {
  const cached = groupTimeCache.get(group);
  if (cached && cached.durations === durations) return cached;
  // 整组从第一次运行开始计时（和 reducer 写在首条 assistant 上的墙钟时长同一个
  // 口径），实时计时才不会在 worker 结果迟到、又起了一轮之后突然重新从 0 数。
  const startedAt = group.items.find((item) => item.startedAt !== undefined)?.startedAt;
  const elapsedMs = turnElapsedMs(group.items, durations);
  const next = { durations, startedAt, elapsedMs };
  groupTimeCache.set(group, next);
  return next;
}

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
    // `orbit-galaxy-surface` pins the whole home page to the dark theme: the
    // plate is printed on dark paper with light ink, so it reads the same in
    // light and dark mode instead of turning into white-edged squares.
    <div ref={lockOverscroll} className="orbit-galaxy-surface relative flex h-full min-h-0 overflow-y-auto overscroll-none">
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
  const opacity = useAppearance((state) => state.chatBackgroundOpacity);
  if (!path) return null;
  return (
    <div aria-hidden className="chat-pane-background pointer-events-none absolute inset-0 z-0 overflow-hidden">
      <img src={convertFileSrc(path)} alt="" className="h-full w-full object-cover" style={{ opacity }} />
    </div>
  );
}

/** 发送后的定位由 lastUserId 变化驱动（Orbit 同款），输入框不需要通知。 */
const noop = () => undefined;

/**
 * `onSubmitted` 由壳层传入：首页工作区在发出第一条消息后要升格成真正的标签页。
 * 会话内的 ChatPane 不传，落到 `noop`。
 */
export function ChatPane({
  onSubmitted,
  paneId = CHAT_PANE_ID,
  withTerminal = false,
}: { onSubmitted?: () => void; paneId?: string; withTerminal?: boolean } = {}) {
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
  // 桌面端的终端挂在 `WorkArea`（工作区）而不是会话面板上：关掉会话面板不该带走
  // 正在跑的 shell。手机端没有工作区网格，一屏就是聊天 + 终端，所以由这里挂。
  // 这条路径在两端都是真 PTY：`pty_spawn`/`pty_write`/`pty_resize` 是镜像命令，
  // 输出通过 socket 以 `pty.event` 回播（`src/lib/remote-pty.ts`），dock 不知道
  // 自己画的是哪台机器。
  const terminalAvailable = withTerminal;
  const historical = useQuery({
    queryKey: ["pi", "turn-durations", sessionFile],
    queryFn: () => getSessionTurnDurations(sessionFile),
    enabled: (runtimeTarget === "desktop" || runtimeTarget === "mobile") && Boolean(sessionFile),
    staleTime: Infinity,
  });
  const savedDurations = useMemo(() => ({ ...(historical.data ?? {}), ...readTurnDurations(sessionFile) }), [historical.data, sessionFile]);
  // 和 useFrameStream 读的是同一个 facade：用它作分组缓存的键，跨重挂命中。
  const store = useWorkspaceStore();
  // 上一张分组表：整表没变时沿用它，下游（包括 effect）不会被无意义的引用变化叫醒。
  const groupsRef = useRef<(TranscriptGroup & { indexes: number[] })[] | null>(null);

  const groups = useMemo<(TranscriptGroup & { indexes: number[] })[]>(() => {
    const raw = reuseGroups(groupCache.get(store) ?? [], groupDisplayMessages(transcript.messages));
    groupCache.set(store, raw);
    const claimed = new Set<number>();
    const mapped = raw.map((group) => {
      const base = groupBaseTimes(group, savedDurations);
      let elapsedMs = base.elapsedMs;
      if (elapsedMs !== undefined) {
        if (claimed.has(elapsedMs)) elapsedMs = undefined;
        else claimed.add(elapsedMs);
      }
      const startedAt = base.startedAt ?? (transcript.running && group.indexes.includes(transcript.active) ? transcript.turnStartedAt ?? undefined : undefined);
      // 值没变就交回上一次的对象，否则 `memo(TranscriptGroupView)` 每帧都会失效。
      const previous = groupViewCache.get(group);
      if (previous && previous.startedAt === startedAt && previous.elapsedMs === elapsedMs) return previous;
      const next = { id: group.id, items: group.items, indexes: group.indexes, startedAt, elapsedMs } as TranscriptGroup & { indexes: number[] };
      groupViewCache.set(group, next);
      return next;
    });
    // 整张表都没变就交回同一个数组：下游的 effect 与 map 不必再跑一遍。
    const last = groupsRef.current;
    if (last && last.length === mapped.length && mapped.every((group, index) => group === last[index])) return last;
    groupsRef.current = mapped;
    return mapped;
  }, [store, transcript.messages, transcript.running, transcript.active, transcript.turnStartedAt, savedDurations]);

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

  const tabs = useWorkspaceTabs();
  const openAgent = useCallback((agent: AgentNode) => {
    // 子 agent 会话开成独立标签页：当前会话（可能正在跑）不受影响。
    if (agent.sessionPath) void tabs.openSession({ path: agent.sessionPath }).catch(report);
  }, [tabs]);
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
  // 手机端（`MobileShell`）没有 pane 网格，一屏就是聊天 + 终端，所以 `withTerminal`
  // 由它打开；桌面端的 dock 挂在工作区（`App.tsx` 的 `WorkArea`）上，这里拿不到。
  const dockVertical = dockPosition === "top" || dockPosition === "bottom";
  const dock = terminalAvailable ? <TerminalDock cwd={project} open={dockOpen} /> : null;
  // 统一外框：空首页、骨架屏、正文共用同一个位置，这样「首页 → 第一条消息」时
  // xterm 不会被卸载重挂，PTY 不重启、不闪。
  const sheet = (content: ReactNode) => (
    <div className={`relative flex min-h-0 min-w-0 flex-1 ${dockVertical ? "flex-col" : "flex-row"}`}>
      {dockPosition === "top" || dockPosition === "left" ? dock : null}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{content}</div>
      {dockPosition === "bottom" || dockPosition === "right" ? dock : null}
    </div>
  );

  // 会话还没到：骨架屏占位，不要停在旧会话的内容上再突然换掉。
  if (transcript.loading) {
    return sheet(
      <>
        <ChatBackground />
        <div className="relative z-10 min-h-0 flex-1 overflow-hidden">
          <TranscriptSkeleton />
        </div>
      </>,
    );
  }

  if (groups.length === 0 && !waiting) {
    return sheet(<EmptySession cwd={project} onSubmitted={onSubmitted ?? noop} />);
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

  return sheet(
    <>
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
        <PromptOutline scope={ref} />
        <TranscriptJumpToBottom visibility={jumpVisibility} onJump={jumpToBottom} />
        <TranscriptSelectionMenu selection={textSelection} onDismiss={dismissTextSelection} />
      </div>
      {Object.entries(statuses).flatMap(([key, value]) => (!key.startsWith("gui-") && value ? [<div key={key} className="extension-status">{key}: {value}</div>] : []))}
      {/* Sending anchors the turn to the top instead of pinning to the bottom. */}
      <Composer onSubmitted={onSubmitted ?? noop} paneId={paneId} />
    </>,
  );
}
