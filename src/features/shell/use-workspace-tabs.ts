import { useEffect } from "react";
import type { Session } from "../../lib/protocol";
import { useWorkspace, type WorkspaceMode } from "../../lib/store";
import { openWorkspaceScope } from "../../lib/workspace-scope";
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
import { HOME_WORKSPACE_ID, isHomeWorkspace, useShell, type WorkspaceTab } from "./shellStore";

/** 正在启动的连接，避免同一个槽位被并发 `show` 拉起两次。 */
const starting = new Map<string, Promise<void>>();

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
      void closeWorkspaceConnection(previousHomeConnection, "首页已关闭").catch(() => undefined);
    }
  }
  shell.activateWorkspace(id);

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
      ? { sessionPath: revivePath, keepTranscript: true }
      : empty ? { keepTranscript: true } : undefined,
  );
  starting.set(target, task);
  focusWorkspaceConnection(target, workspace.cwd);
  try {
    await task;
  } finally {
    starting.delete(target);
  }// bootstrap 不再预先建项目连接，附加 roots 跟着面上层后台同步，不挡首次渲染。
    if (useWorkspace.getState().workspaceMode === "project") {
      void syncConfiguredProjectRoots(workspace.cwd, target).catch(() => undefined);
    }
  // 旧连接只有在没被别的标签页引用、也没有会话内容时才收掉；否则它就是一条要
  // 留在后台继续跑的会话。
  if (stale && stale !== target && !connectionHasWork(stale) && !connectionInUseElsewhere(stale, id)) {
    void closeWorkspaceConnection(stale, "已切换范围").catch(() => undefined);
  }
  // 启动进程不能抢走原来那个工作区的路由。
  if (previous && previous !== target) restoreProjectRoute(workspace.cwd, previous);
  focusWorkspaceConnection(target, workspace.cwd);
  enforceConnectionBudget();
}

/** 切换工作范围（项目 / 主目录）：当前面留在原处，只是换一条该范围的连接。 */
async function openScope(path: string, mode: WorkspaceMode) {
  const shell = useShell.getState();
  const active = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  const home = isHomeWorkspace(active);
  const previousConnection = active?.connectionId;
  if (home && active) {
    if (previousConnection && connectionHasWork(previousConnection)) {
      // 首页其实已经是一个会话：先升格成标签页留在后台，再给新的空首页换范围。
      shell.promoteHomeWorkspace();
      const nextHome = useShell.getState().workspaces.find(isHomeWorkspace);
      if (nextHome) {
        shell.setWorkspaceCwd(nextHome.id, path);
        shell.bindWorkspaceConnection(nextHome.id, "");
      }
    } else {
      if (previousConnection) void closeWorkspaceConnection(previousConnection, "已切换范围").catch(() => undefined);
      shell.setWorkspaceCwd(active.id, path);
      shell.bindWorkspaceConnection(active.id, "");
    }
  }
  await openWorkspaceScope(path, mode);
  if (home) {
    await show(HOME_WORKSPACE_ID);
    return;
  }
  const current = useWorkspace.getState().connectionId;
  // 活动标签页在换范围后仍开着，它的旧连接要留在后台继续跑（每个会话都能后台跑），
  // 只有已经被彻底舍弃、没有任何会话内容的连接才收掉。
  if (previousConnection && previousConnection !== current) {
    const activeId = useShell.getState().activeWorkspaceId;
    if (!connectionHasWork(previousConnection) && !connectionInUseElsewhere(previousConnection, activeId)) {
      void closeWorkspaceConnection(previousConnection, "已切换范围").catch(() => undefined);
    }
  }
}

/** 「新建会话」：回到首页（也就是一个全新的空会话），不再克隆当前会话。 */
async function create(projectCwd?: string) {
  const shell = useShell.getState();
  const active = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  if (projectCwd && projectCwd !== active?.cwd) {
    const homeDir = useWorkspace.getState().homeDir;
    await openScope(projectCwd, homeDir && projectCwd === homeDir ? "home" : "project");
    return;
  }
  await show(HOME_WORKSPACE_ID);
}

/** 关闭标签页；关掉的是当前页时就切到相邻页，没有邻居就回首页。 */
async function close(id: string) {
  const shell = useShell.getState();
  const workspace = shell.workspaces.find((item) => item.id === id);
  if (!workspace || isHomeWorkspace(workspace)) return;
  const wasActive = shell.activeWorkspaceId === id;
  shell.closeWorkspace(id);
  if (wasActive) await show(useShell.getState().activeWorkspaceId);
  await closeWorkspaceConnection(workspace.connectionId, "工作区已关闭");
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
    && (item.connectionId === owner || connectionSnapshot(item.connectionId)?.state?.sessionFile === session.path));
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
    if (held.has(id)) continue;
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
  const live = workspaceConnectionIds();
  if (live.length <= MAX_LIVE_CONNECTIONS) return;
  const active = useWorkspace.getState().connectionId;
  const scored = live
    .map((id) => ({ id, pinned: lastActiveAt(id) === Number.MAX_SAFE_INTEGER || id === active }))
    .filter((item) => !item.pinned)
    .map((item) => ({ ...item, messages: connectionSnapshot(item.id)?.transcript.messages.length ?? 0 }));
  const excess = live.length - MAX_LIVE_CONNECTIONS;
  for (const item of scored.slice(0, excess)) {
    const workspace = shell.workspaces.find((candidate) => candidate.connectionId === item.id);
    if (workspace) {
      const sessionPath = connectionSnapshot(item.id)?.state?.sessionFile;
      useShell.getState().updateWorkspace(workspace.id, {
        sessionPath: sessionPath ?? workspace.sessionPath,
        connectionId: "",
      });
    }
    void closeWorkspaceConnection(item.id, "连接预算：后台会话已休眠").catch(() => undefined);
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
const controller = { show, create, close, promoteHome, openScope, openSession, splitSession, openBackground, reconcile: reconcileOrphans };

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

  // 对账：任何一条活连接都必须有标签页持有（changeSession swap、后台任务开的
  // 连接都会落在这里被收养成后台标签页）。挂在 liveSessions 上，跑起来/结束都会触发。
  useEffect(() => {
    reconcileOrphans();
  }, [liveConnections, connectionId]);

  // 活动标签页的 scope 跟随全局投影（切范围、切会话时会变）；首页自己管连接。
  useEffect(() => {
    const shell = useShell.getState();
    const workspace = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
    if (!workspace || isHomeWorkspace(workspace)) return;
    if (connectionId && workspace.connectionId !== connectionId) shell.bindWorkspaceConnection(workspace.id, connectionId);
    if (cwd && workspace.cwd !== cwd) shell.setWorkspaceCwd(workspace.id, cwd);
  }, [connectionId, cwd, activeWorkspaceId]);

  // 首页是默认面，也是当前范围的新会话面：范围变了就换一条干净的连接。
  useEffect(() => {
    if (activeWorkspaceId !== HOME_WORKSPACE_ID) return;
    const shell = useShell.getState();
    const home = shell.workspaces.find((item) => item.id === HOME_WORKSPACE_ID);
    if (!home) return;
    if (cwd && home.cwd !== cwd) {
      if (home.connectionId) void closeWorkspaceConnection(home.connectionId, "已切换范围").catch(() => undefined);
      shell.setWorkspaceCwd(HOME_WORKSPACE_ID, cwd);
      shell.bindWorkspaceConnection(HOME_WORKSPACE_ID, "");
    }
    if (!cwd) return;
    if (home.connectionId && hasWorkspaceConnection(home.connectionId) && connectionCwd(home.connectionId) === home.cwd) return;
    void show(HOME_WORKSPACE_ID);
  }, [activeWorkspaceId, cwd]);
}

export type { WorkspaceTab };
