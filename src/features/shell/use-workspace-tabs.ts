import { useEffect } from "react";
import type { Session } from "../../lib/protocol";
import { useWorkspace, type WorkspaceMode } from "../../lib/store";
import { normalizeProjectPath } from "../../lib/projects";
import {
  cachedTranscript,
  changeSession,
  closeWorkspaceConnection,
  connectionCwd,
  connectionOwningSession,
  connectionSnapshot,
  focusWorkspaceConnection,
  hasWorkspaceConnection,
  openWorkspaceConnection,
  patchConnectionSnapshot,
  primeConnectionSnapshot,
  restoreProjectRoute,
  setDesktopScope,
  sendPrompt,
  syncConfiguredProjectRoots,
  firstUserTitle,
  workspaceConnectionIds,
} from "../../lib/rpc";
import { CHAT_PANE_ID, HOME_WORKSPACE_ID, isHomeWorkspace, projectWorkspaceTabs, useShell, type WorkspaceTab } from "./shellStore";

/** 正在启动的连接，避免同一个槽位被并发 `show` 拉起两次。 */
const starting = new Map<string, Promise<void>>();

/**
 * 正在显示的面，按 `工作区:范围` 去重。首页的 effect 与控制器可能在同一帧里都要
 * 显示首页；不去重的话两边各算一个随机连接 id，会白起一条 pi 进程并闪一下。
 */
const showing = new Map<string, Promise<void>>();

/**
 * 这条连接上是否已经有一个真实会话：有正文，或者正在跑/压缩。
 *
 * 切面（换标签、换范围）时用它来区分「空首页」和「用户真的在用的一条会话」——
 * 后者绝不能被静默收掉。
 */
function connectionHasWork(id: string): boolean {
  const snapshot = connectionSnapshot(id);
  if (!snapshot) return false;
  return snapshot.transcript.running || snapshot.transcript.compacting || snapshot.transcript.messages.length > 0;
}

/**
 * 除了 `exceptWorkspaceId` 之外，还有没有别的标签页 / 会话面板引用这条连接。
 * 被引用就说明它仍是某个在屏幕上（或后台标签里）的会话，不能关。
 */
function connectionInUseElsewhere(id: string, exceptWorkspaceId: string): boolean {
  if (!id) return false;
  return useShell.getState().workspaces.some((workspace) =>
    workspace.id !== exceptWorkspaceId
    && (workspace.connectionId === id
      || Object.values(workspace.sessions).some((session) => session.connectionId === id)));
}

/**
 * 正在被放弃的连接（用户关了标签页、面板，或范围切换把它换掉了）。
 *
 * `closeConnection` 只有在会话空闲时才同步从 `connections` 里消失；会话还在跑/
 * 压缩时它先 `clear_queue` + `abort`（最长 60s），这期间连接仍然是「活着的孤儿」。
 * 对账（`reconcileOrphans`）救的是真正的孤儿，但它分不清「没人要了」和「正在关」——
 * 于是每次关标签页都会再把同一条连接收养回一个新标签页，表现就是标签页关不完。
 */
const closing = new Set<string>();

/** 关掉一条已经没有任何面在用的连接；对账立刻知道它已经被放弃，不会再收养。 */
function retireConnection(id: string, message: string): Promise<void> {
  if (!id) return Promise.resolve();
  closing.add(id);
  return closeWorkspaceConnection(id, message)
    .catch(() => undefined)
    .finally(() => closing.delete(id));
}

/**
 * The shell's one way to put a surface on screen.
 *
 * A *surface* is either the 首页 (a fresh, tab-less session on the current
 * scope) or a workspace tab. Everything that used to special-case “open the
 * home page” — the `+` button, closing the last tab, the project picker —
 * funnels through `show`, so there is a single place that decides which
 * connection a surface runs on.
 */
async function show(id: string) {
  const shell = useShell.getState();
  const workspace = shell.workspaces.find((item) => item.id === id);
  // 范围还没确定（bootstrap 之前）时不启动进程，否则会拿空 cwd 去连。
  if (!workspace || !workspace.cwd) return;
  const key = `${id}:${workspace.cwd}`;
  const inflight = showing.get(key);
  if (inflight) return inflight;
  let task: Promise<void>;
  task = runShow(id, workspace.cwd).finally(() => {
    if (showing.get(key) === task) showing.delete(key);
  });
  showing.set(key, task);
  return task;
}

async function runShow(id: string, cwd: string) {
  const shell = useShell.getState();
  const workspace = shell.workspaces.find((item) => item.id === id);
  // 等连接起来时这个面可能已经被切到别的范围了；旧的那次直接作废，别回写。
  if (!workspace || workspace.cwd !== cwd || !workspace.cwd) return;
  const home = isHomeWorkspace(workspace);
  const previousId = shell.activeWorkspaceId;
  const previous = useWorkspace.getState().connectionId;

  // 离开首页前先把首页处理掉：它已经是某个真实会话（有正文或正在工作）就把它
  // 升格成标签页，让那个会话继续留在后台；只有完全空着的首页才收掉连接。
  // 绝不能因为「切到别的会话」就掐掉一个正在工作的会话——每个会话都要能后台跑。
  if (previousId === HOME_WORKSPACE_ID && !home) {
    const previousHome = shell.workspaces.find((item) => item.id === HOME_WORKSPACE_ID);
    const previousHomeConnection = previousHome?.connectionId ?? "";
    if (previousHomeConnection && connectionHasWork(previousHomeConnection)) {
      shell.promoteHomeWorkspace();
    } else if (previousHomeConnection) {
      shell.bindWorkspaceConnection(HOME_WORKSPACE_ID, "");
      void retireConnection(previousHomeConnection, "首页已关闭");
    }
  }
  shell.activateWorkspace(id);

  if (Object.keys(workspace.sessions).length === 0) {
    setDesktopScope(workspace.cwd, workspace.cwd === useWorkspace.getState().homeDir ? "home" : "project");
    useWorkspace.getState().set({ connectionId: "" });
    return;
  }

  const bound = workspace.connectionId;
  const live = Boolean(bound) && hasWorkspaceConnection(bound);
  if (live && connectionCwd(bound) === workspace.cwd) {
    focusWorkspaceConnection(bound, workspace.cwd);
    return;
  }
  // 休眠标签页复活：连接已经被预算回收，但有 sessionPath，按它接回原会话。
  const revivePath = workspace.sessionPath;
  const stale = live ? bound : "";
  const cached = revivePath ? cachedTranscript(revivePath) : undefined;
  // 首页和标签页用同一套规则：能复用就复用，否则开一条新的。用随机 id 而不是
  // 固定 `<cwd>#home`，避免首页被升格成标签页后，新首页和它抢同一个连接。
  const target = bound || `${workspace.cwd}#${crypto.randomUUID()}`;

  const pending = starting.get(target);
  if (pending) {
    focusWorkspaceConnection(target, workspace.cwd);
    await pending;
    return;
  }
  shell.bindWorkspaceConnection(id, target);
  primeConnectionSnapshot(target);
  if (cached) patchConnectionSnapshot(target, { transcript: cached });
  // 新建/首页的空快照不需要骨架屏；复活的旧标签页才走骨架屏，避免先闪旧内容。
  const empty = (connectionSnapshot(target)?.transcript.messages.length ?? 0) === 0;
  const task = openWorkspaceConnection(
    workspace.cwd,
    target,
    revivePath
      // 复活的旧标签页只有拿到正文缓存才 keepTranscript；否则该走骨架屏，
      // 不能让空 transcript 先渲染成首页。
      ? { sessionPath: revivePath, ...(cached ? { keepTranscript: true } : {}) }
      : empty ? { keepTranscript: true } : undefined,
  );
  starting.set(target, task);
  focusWorkspaceConnection(target, workspace.cwd);
  try {
    await task;
  } finally {
    starting.delete(target);
  }
  // 连接起来时范围可能已经变了（用户又点了别的项目）：这次结果作废。
  if (useShell.getState().workspaces.find((item) => item.id === id)?.cwd !== workspace.cwd) return;// bootstrap 不再预先建项目连接，附加 roots 跟着面上层后台同步，不挡首次渲染。
    if (useWorkspace.getState().workspaceMode === "project") {
      void syncConfiguredProjectRoots(workspace.cwd, target).catch(() => undefined);
    }
  // 旧连接只有在没被别的标签页引用、也没有会话内容时才收掉；否则它就是一条要
  // 留在后台继续跑的会话。
  if (stale && stale !== target && !connectionHasWork(stale) && !connectionInUseElsewhere(stale, id)) {
    void retireConnection(stale, "已切换范围");
  }
  // 启动进程不能抢走原来那个工作区的路由。
  if (previous && previous !== target) restoreProjectRoute(workspace.cwd, previous);
  focusWorkspaceConnection(target, workspace.cwd);
  enforceConnectionBudget();
}

/**
 * 把一个范围落在首页（也就是这个范围的新会话面）。首页上正在跑的会话先升格成
 * 标签页留在后台；旧连接没跑东西就收掉。连接由 `show` 开，这里不再单独 `connect`，
 * 否则同一范围会白起两条 pi 进程。
 */
async function showHomeScope(path: string, mode: WorkspaceMode) {
  const shell = useShell.getState();
  const home = shell.workspaces.find(isHomeWorkspace);
  if (!home) return;
  // 范围真的变了才动连接：同一个范围重复「新建会话」直接复用首页那条空连接，
  // 不再先关再开（那是白等一次 pi 进程）。
  const changed = normalizeProjectPath(home.cwd) !== normalizeProjectPath(path);
  const bound = home.connectionId;
  if (bound) {
    if (connectionHasWork(bound)) {
      // 首页其实已经是一个会话了：先升格成标签页留在后台，再开一个干净的新首页。
      shell.promoteHomeWorkspace();
    } else if (changed && !connectionInUseElsewhere(bound, HOME_WORKSPACE_ID)) {
      useShell.getState().bindWorkspaceConnection(HOME_WORKSPACE_ID, "");
      void retireConnection(bound, "已切换范围");
    }
  }
  const nextHome = useShell.getState().workspaces.find(isHomeWorkspace);
  if (!nextHome) return;
  if (changed) {
    useShell.getState().setWorkspaceCwd(nextHome.id, path);
    useShell.getState().bindWorkspaceConnection(nextHome.id, "");
  }
  setDesktopScope(path, mode);
  await show(HOME_WORKSPACE_ID);
}

/**
 * 选中一个项目：header 上的会话是挂项目的，所以优先把这个项目上次的会话标签页
 * 原样带回来（复用它的连接与正文，零骨架屏、零新进程）；没有就在这个范围开一个
 * 干净的新会话首页。绝不去改别的项目正在跑的标签页。
 */
async function selectProject(path: string, mode: WorkspaceMode = "project") {
  const shell = useShell.getState();
  const key = normalizeProjectPath(path);
  // 这个项目的标签页（header 是挂项目的）：优先上次用的那个，没有就回到最后一个
  // 已经开着的会话，而不是把用户丢到一个空首页。
  const projectTabs = projectWorkspaceTabs(shell.workspaces, path);
  const remembered = shell.activeByProject[key] ?? shell.activeByProject[path];
  const existing = projectTabs.find((item) => item.id === remembered) ?? projectTabs.at(-1);
  if (existing) {
    await show(existing.id);
    // `show` 只把 cwd 跟着连接切过去；模式（project/home）也要落下来。
    setDesktopScope(path, mode);
    return;
  }
  await showHomeScope(path, mode);
}

/** 切换工作范围（项目 / 主目录）：一律落在那个范围的新会话首页，范围写进全局投影。 */
async function openScope(path: string, mode: WorkspaceMode) {
  await showHomeScope(path, mode);
}

/** 「新建会话」：在**当前项目**开一个全新的空会话，不再克隆当前会话。 */
async function create(projectCwd?: string) {
  const shell = useShell.getState();
  shell.restoreHomeSessionPane();
  const active = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  const workspace = useWorkspace.getState();
  // 没显式给项目时用当前范围。首页的 cwd 可能是上次切项目留下的旧值，
  // 直接 `show(首页)` 会跳到那个旧项目里去。
  const target = projectCwd ?? workspace.cwd ?? active?.cwd ?? "";
  if (!target) {
    await show(HOME_WORKSPACE_ID);
    return;
  }
  await showHomeScope(target, workspace.homeDir && target === workspace.homeDir ? "home" : "project");
}

/** 关闭会话面板后保留编辑器；显式新建时才重新打开默认会话。 */
async function closeSessionPane(paneId: string) {
  const shell = useShell.getState();
  const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  const session = workspace?.sessions[paneId];
  if (!workspace || !session) return;
  shell.closePane(paneId);
  const next = useShell.getState().workspaces.find((item) => item.id === workspace.id);
  if (!next || next.sessions[paneId]) return;
  const id = session.connectionId || workspace.connectionId;
  if (id && !connectionInUseElsewhere(id, workspace.id) && !Object.values(next.sessions).some((item) => item.connectionId === id)) {
    // 在异步关闭进程之前摘掉投影，避免 effects 把已关闭的连接重新绑回工作区。
    if (useWorkspace.getState().connectionId === id) useWorkspace.getState().set({ connectionId: "" });
    await retireConnection(id, "会话面板已关闭");
  }
  if (next.connectionId) focusWorkspaceConnection(next.connectionId, next.cwd);
}

/** 关闭标签页；关掉的是当前页时就切到相邻页，没有邻居就回首页。 */
async function close(id: string) {
  const shell = useShell.getState();
  const workspace = shell.workspaces.find((item) => item.id === id);
  if (!workspace || isHomeWorkspace(workspace)) return;
  const wasActive = shell.activeWorkspaceId === id;
  // 先标记再切面：`show` 会改全局投影并触发一次对账，那一次对账必须已经知道这条
  // 连接被放弃了，否则它会被当成孤儿再收养回一个新标签页。
  const connection = workspace.connectionId;
  if (connection) closing.add(connection);
  shell.closeWorkspace(id);
  try {
    if (wasActive) await show(useShell.getState().activeWorkspaceId);
  } finally {
    // 切面失败也不能把连接留在「正在关」里：那样它既关不掉、也不会再被收养。
    await retireConnection(connection, "工作区已关闭");
  }
}

/** 首页发出第一条消息：把它升格成一个正常的会话标签页。 */
function promoteHome() {
  useShell.getState().promoteHomeWorkspace();
}

/**
 * 打开一个已存在的会话：它是一条真实会话，所以出现在 header 的标签页里。
 * 已经开着的会话切到原标签页，不开第二个。
 */
async function openSession(session: Pick<Session, "path"> & { cwd?: string }) {
  const shell = useShell.getState();
  const owner = connectionOwningSession(session.path);
  const existing = shell.workspaces.find((item) =>
    !isHomeWorkspace(item)
    && (
      (Boolean(owner) && item.connectionId === owner)
      || connectionSnapshot(item.connectionId)?.state?.sessionFile === session.path
      // 休眠标签页（连接已回收，只剩 sessionPath）也算已打开：`show` 会按它复活，
      // 而不是再开一个重复标签页。
      || item.sessionPath === session.path
    ));
  if (existing) {
    await show(existing.id);
    return;
  }
  const cwd = session.cwd ?? useWorkspace.getState().cwd;
  const homeDir = useWorkspace.getState().homeDir;
  const mode: WorkspaceMode = homeDir && cwd === homeDir ? "home" : "project";

  // 快速路径：首页正开着同一个范围。复用它已经跑着的连接切过去（一次
  // `switch_session`，不新起 pi 进程），再把它升格成标签页。
  const active = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  const projection = useWorkspace.getState();
  if (
    isHomeWorkspace(active)
    && projection.connection === "online"
    && projection.connectionId
    && connectionCwd(projection.connectionId) === cwd
  ) {
    await changeSession({ type: "switch_session", sessionPath: session.path });
    promoteHome();
    return;
  }

  // 慢路径：为这个会话新起一条连接。

  // 侧栏、范围选择器都读全局 cwd，所以切会话时范围要跟着走。
  setDesktopScope(cwd, mode);

  const target = owner || `${cwd}#${crypto.randomUUID()}`;
  // 连接 id 在创建时就绑好，标签页一出现就是这条连接，不会先渲染成首页。
  shell.newWorkspace(cwd, target);
  primeConnectionSnapshot(target);
  // 之前开过这个会话：先把缓存正文画上去，连 pi 进程的时间也不用看骨架屏。
  const cached = cachedTranscript(session.path);
  if (cached) patchConnectionSnapshot(target, { transcript: cached });
  if (hasWorkspaceConnection(target)) {
    focusWorkspaceConnection(target, cwd);
    return;
  }
  const task = openWorkspaceConnection(cwd, target, { sessionPath: session.path, ...(cached ? { keepTranscript: true } : {}) });
  starting.set(target, task);
  focusWorkspaceConnection(target, cwd);
  try {
    await task;
  } finally {
    starting.delete(target);
  }
  if (mode === "project") void syncConfiguredProjectRoots(cwd, target).catch(() => undefined);
  focusWorkspaceConnection(target, cwd);
  const openedSession = connectionSnapshot(target)?.state?.sessionFile;
  if (openedSession) useShell.getState().updateWorkspace(useShell.getState().activeWorkspaceId, { sessionPath: openedSession });
  enforceConnectionBudget();
}

/** ⌘D / ⌘⇧D: split a session pane and open a new session in it. */
async function splitSession(paneId: string, dir: "right" | "down") {
  const shell = useShell.getState();
  const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  if (!workspace || isHomeWorkspace(workspace)) return;
  const newPaneId = shell.splitSessionPane(paneId, dir);
  if (!newPaneId) return;
  const target = `${workspace.cwd}#${crypto.randomUUID()}`;
  shell.bindSessionConnection(newPaneId, target);
  await openWorkspaceConnection(workspace.cwd, target);
  focusWorkspaceConnection(target, workspace.cwd);
}

/* ------------------------------------------------------------------ *
 * 会话运行时治理：孤儿收养、连接预算。
 *
 * 不变量：每条活着的 pi 连接都必须被一个标签页持有；持有不下的按 LRU
 * 休眠（记住 sessionPath，激活时复活）。这样「多会话同时跑」才有边界：
 * 后台会话既不会丢，也不会把进程数拖到无上限。
 * ------------------------------------------------------------------ */

/** 同时活着的 pi 进程上限。超出的空闲后台连接休眠（标签页保留，可复活）。 */
const MAX_LIVE_CONNECTIONS = 8;

/** 收养一条无人持有的连接：给它一个后台标签页，会话继续跑且可见。 */
function adoptConnection(id: string, cwd: string) {
  const shell = useShell.getState();
  const sessionPath = connectionSnapshot(id)?.state?.sessionFile ?? undefined;
  const transcript = connectionSnapshot(id)?.transcript;
  const title = transcript ? firstUserTitle(transcript) || undefined : undefined;
  const workspace = shell.newWorkspace(cwd, id, { background: true });
  if (sessionPath || title) {
    useShell.getState().updateWorkspace(workspace.id, { sessionPath, title });
  }
}

/**
 * 对账：任何不在任何标签页（含分屏面板）上的活连接都被收养。幂等，可频繁调。
 * 典型来源：changeSession 在跑时 swap 出来的新连接、自动化开的连接。
 */
function reconcileOrphans() {
  if (useWorkspace.getState().runtimeTarget === "mobile") return;
  const shell = useShell.getState();
  const held = new Set<string>();
  for (const workspace of shell.workspaces) {
    if (workspace.connectionId) held.add(workspace.connectionId);
    for (const session of Object.values(workspace.sessions)) if (session.connectionId) held.add(session.connectionId);
  }
  const active = useWorkspace.getState().connectionId;
  if (active) held.add(active);
  for (const id of workspaceConnectionIds()) {
    // 正在关的连接不是孤儿：它有主，只是主人刚走。
    if (held.has(id) || closing.has(id)) continue;
    const cwd = connectionCwd(id);
    if (!cwd) continue;
    adoptConnection(id, cwd);
  }
  enforceConnectionBudget();
}

/** 活跃度：被聚焦/正在跑的连接不算「可休眠」。 */
function lastActiveAt(id: string): number {
  const snapshot = connectionSnapshot(id);
  // 快照还没建的（刚收养/正在启动）按「忙」处理：绝不休眠看不清状态的东西。
  if (!snapshot) return Number.MAX_SAFE_INTEGER;
  if (snapshot.transcript.running || snapshot.transcript.compacting) return Number.MAX_SAFE_INTEGER;
  if (snapshot.dialogs.length > 0) return Number.MAX_SAFE_INTEGER;
  return 0;
}

/**
 * 连接预算：活进程超过上限时，把最久没有产出的后台连接休眠（关进程，标签页
 * 保留 sessionPath，激活时用同一条会话文件复活）。正在跑/等审批的绝不休眠。
 */
function enforceConnectionBudget() {
  const shell = useShell.getState();
  // 正在关的连接不占预算，也不能被休眠逻辑再算一遍。
  const live = workspaceConnectionIds().filter((id) => !closing.has(id));
  if (live.length <= MAX_LIVE_CONNECTIONS) return;
  const active = useWorkspace.getState().connectionId;
  const scored = live
    .map((id) => ({ id, pinned: lastActiveAt(id) === Number.MAX_SAFE_INTEGER || id === active }))
    .filter((item) => !item.pinned)
    .map((item) => ({ ...item, messages: connectionSnapshot(item.id)?.transcript.messages.length ?? 0 }));
  const excess = live.length - MAX_LIVE_CONNECTIONS;
  const byConnection = new Map(shell.workspaces.map((workspace) => [workspace.connectionId, workspace]));
  for (const item of scored.slice(0, excess)) {
    const workspace = byConnection.get(item.id);
    if (workspace) {
      const sessionPath = connectionSnapshot(item.id)?.state?.sessionFile;
      useShell.getState().updateWorkspace(workspace.id, {
        sessionPath: sessionPath ?? workspace.sessionPath,
        connectionId: "",
      });
    }
    void retireConnection(item.id, "连接预算：后台会话已休眠");
  }
}

/**
 * 「后台新会话」：自动化、批量任务的入口。开一个独立连接 + 后台标签页，
 * 不抢当前焦点，跑完留在侧栏（Working.../完成），可随时点开看。
 */
async function openBackground(cwd: string, options?: { prompt?: string }): Promise<string> {
  const shell = useShell.getState();
  const target = `${cwd}#${crypto.randomUUID()}`;
  const workspace = shell.newWorkspace(cwd, target, { background: true });
  primeConnectionSnapshot(target);
  try {
    await openWorkspaceConnection(cwd, target, { keepTranscript: true });
  } catch (error) {
    useShell.getState().closeWorkspace(workspace.id);
    throw error;
  }
  const started = useWorkspace.getState().connectionId;
  if (started && started !== target) restoreProjectRoute(cwd, started);
  enforceConnectionBudget();
  if (options?.prompt) await sendPrompt({ type: "prompt", message: options.prompt }, target, false);
  return target;
}

/** 一个共享的控制器：组件只拿它的动作，不各自起一份副作用。 */
const controller = { show, create, close, closeSessionPane, promoteHome, openScope, selectProject, openSession, splitSession, openBackground, reconcile: reconcileOrphans };

/** 供非组件作用域（调度器、事件处理）使用的同一份控制器：它不是 hook，只是纯对象。 */
export const workspaceTabs = controller;

export function useWorkspaceTabs() {
  return controller;
}

/**
 * 壳层的副作用只挂一次（App 里）：把当前面的 scope 跟全局投影对齐，
 * 并保证首页永远有一条可用的新会话连接。
 */
export function useWorkspaceTabsEffects() {
  const connectionId = useWorkspace((state) => state.connectionId);
  const cwd = useWorkspace((state) => state.cwd);
  const activeWorkspaceId = useShell((state) => state.activeWorkspaceId);
  const liveConnections = useWorkspace((state) => state.liveSessions.length);
  // 首页是否还有会话面板。关掉/恢复它时要重跑首页那条 effect。
  const homeHasSession = useShell((state) => Boolean(state.workspaces.find((item) => item.id === HOME_WORKSPACE_ID)?.sessions[CHAT_PANE_ID]));

  // 对账：任何一条活连接都必须有标签页持有（changeSession swap、后台任务开的
  // 连接都会落在这里被收养成后台标签页）。挂在 liveSessions 上，跑起来/结束都会触发。
  useEffect(() => {
    reconcileOrphans();
  }, [liveConnections, connectionId]);

  // 活动标签页的 scope 跟随全局投影（切范围、切会话时会变）；首页自己管连接。
  useEffect(() => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    if (!workspace || isHomeWorkspace(workspace) || Object.keys(workspace.sessions).length === 0) return;
    if (connectionId && workspace.connectionId !== connectionId) shell.bindWorkspaceConnection(workspace.id, connectionId);
    if (cwd && workspace.cwd !== cwd) shell.setWorkspaceCwd(workspace.id, cwd);
  }, [connectionId, cwd, activeWorkspaceId]);

  // 首页是默认面，也是当前范围的新会话面：范围变了就换一条干净的连接。
  // 首页的会话面板被关掉后（可能只剩一个悬挂的文件叶子），先把它恢复成新会话面，
  // 否则 `WorkArea` 没有可画的内容——就是那块黑。
  useEffect(() => {
    if (activeWorkspaceId !== HOME_WORKSPACE_ID) return;
    const shell = useShell.getState();
    const home = shell.workspaces.find((item) => item.id === HOME_WORKSPACE_ID);
    if (!home) return;
    // 首页的会话面板只有在「一个 tab 都不剩」时才自动补回来。还有文件面板时，
    // 关掉就是关掉（文件面板可以独占工作区），不能又被 effect 顶回来。
    if (Object.keys(home.sessions).length === 0 && Object.values(home.panes).every((pane) => pane.files.length === 0)) {
      shell.restoreHomeSessionPane();
    }
    const next = useShell.getState().workspaces.find((item) => item.id === HOME_WORKSPACE_ID);
    if (!next) return;
    if (cwd && next.cwd !== cwd) {
      if (next.connectionId) void retireConnection(next.connectionId, "已切换范围");
      useShell.getState().setWorkspaceCwd(HOME_WORKSPACE_ID, cwd);
      useShell.getState().bindWorkspaceConnection(HOME_WORKSPACE_ID, "");
    }
    if (!cwd) return;
    if (next.connectionId && hasWorkspaceConnection(next.connectionId) && connectionCwd(next.connectionId) === next.cwd) return;
    void show(HOME_WORKSPACE_ID);
  }, [activeWorkspaceId, cwd, homeHasSession]);
}

export type { WorkspaceTab };
