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
  syncConfiguredProjectRoots,
} from "../../lib/rpc";
import { HOME_WORKSPACE_ID, isHomeWorkspace, useShell, type WorkspaceTab } from "./shellStore";

/** 正在启动的连接，避免同一个槽位被并发 `show` 拉起两次。 */
const starting = new Map<string, Promise<void>>();

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
  shell.activateWorkspace(id);

  // 首页是一次性的新会话：离开它就把那条连接收掉，下次回来是干净的。
  if (previousId === HOME_WORKSPACE_ID && !home) {
    const previousHome = shell.workspaces.find((item) => item.id === HOME_WORKSPACE_ID);
    if (previousHome?.connectionId) {
      shell.bindWorkspaceConnection(HOME_WORKSPACE_ID, "");
      void closeWorkspaceConnection(previousHome.connectionId, "首页已关闭").catch(() => undefined);
    }
  }

  const bound = workspace.connectionId;
  const live = Boolean(bound) && hasWorkspaceConnection(bound);
  if (live && connectionCwd(bound) === workspace.cwd) {
    focusWorkspaceConnection(bound, workspace.cwd);
    return;
  }
  const stale = live ? bound : "";
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
  // 新建/首页的空快照不需要骨架屏；复活的旧标签页才走骨架屏，避免先闪旧内容。
  const empty = (connectionSnapshot(target)?.transcript.messages.length ?? 0) === 0;
  const task = openWorkspaceConnection(workspace.cwd, target, empty ? { keepTranscript: true } : undefined);
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
  if (stale && stale !== target) void closeWorkspaceConnection(stale, "已切换范围").catch(() => undefined);
  // 启动进程不能抢走原来那个工作区的路由。
  if (previous && previous !== target) restoreProjectRoute(workspace.cwd, previous);
  focusWorkspaceConnection(target, workspace.cwd);
}

/** 切换工作范围（项目 / 主目录）：当前面留在原处，只是换一条该范围的连接。 */
async function openScope(path: string, mode: WorkspaceMode) {
  const shell = useShell.getState();
  const active = shell.workspaces.find((item) => item.id === shell.activeWorkspaceId);
  const home = isHomeWorkspace(active);
  const previousConnection = active?.connectionId;
  if (home && active) {
    if (active.connectionId) void closeWorkspaceConnection(active.connectionId, "已切换范围").catch(() => undefined);
    shell.setWorkspaceCwd(active.id, path);
    shell.bindWorkspaceConnection(active.id, "");
  }
  await openWorkspaceScope(path, mode);
  if (home) {
    await show(HOME_WORKSPACE_ID);
    return;
  }
  const current = useWorkspace.getState().connectionId;
  if (previousConnection && previousConnection !== current) {
    void closeWorkspaceConnection(previousConnection, "已切换范围").catch(() => undefined);
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

/** 一个共享的控制器：组件只拿它的动作，不各自起一份副作用。 */
const controller = { show, create, close, promoteHome, openScope, openSession, splitSession };

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
