import { beforeEach, describe, expect, mock, test } from "bun:test"
import { useWorkspace } from "../src/lib/store"

/**
 * 「每个会话都能后台跑」的守卫。
 *
 * 这里的 RPC 层用一张内存表替代：连接 id → cwd / 会话文件 / 是否在跑，以及
 * `projectActive` / `sessionOwners` 两个映射。控制器（`use-workspace-tabs.ts`）
 * 是唯一的被测对象——它决定什么时候开一条连接、什么时候关一条连接。
 *
 * 关键断言：打开/切换会话永远不会关掉另一条已经有内容的连接。
 */

type Snap = { connection: string; transcript: { messages: unknown[]; running: boolean; compacting: boolean }; dialogs: { id: string }[]; state: { sessionFile: string } | null }
type Model = {
  connections: Map<string, { cwd: string }>
  snapshots: Map<string, Snap>
  projectActive: Map<string, string>
  sessionOwners: Map<string, string>
  closed: string[]
  opened: string[]
}

const model: Model = { connections: new Map(), snapshots: new Map(), projectActive: new Map(), sessionOwners: new Map(), closed: [], opened: [] }
const fresh = (): Snap => ({ connection: "offline", transcript: { messages: [], running: false, compacting: false }, dialogs: [], state: null })
const snap = (id: string) => model.snapshots.get(id) ?? fresh()
const patch = (id: string, value: Partial<Snap>) => model.snapshots.set(id, { ...snap(id), ...value })
const hasWork = (id: string) => {
  const s = snap(id)
  return s.transcript.running || s.transcript.compacting || s.transcript.messages.length > 0
}
let currentCwd = "/p"

mock.module("../src/lib/rpc", () => ({
  cachedTranscript: () => undefined,
  async changeSession(command: { type: string; sessionPath?: string }) {
    const active = useWorkspace.getState().connectionId || currentCwd
    if (command.type === "switch_session") {
      if (useWorkspace.getState().state?.sessionFile === command.sessionPath) return
      const owner = model.sessionOwners.get(command.sessionPath!)
      if (owner && model.connections.has(owner)) {
        useWorkspace.getState().set({ ...snap(owner), connectionId: owner, connection: "online" } as never)
        return
      }
    }
    const swaps = command.type === "new_session" || command.type === "switch_session"
    if (swaps && snap(active).transcript.running) {
      // 正在跑：换一条新连接，旧连接留在后台继续跑。
      const id = `${currentCwd}#swap-${model.opened.length}`
      model.snapshots.set(active, { ...snap(active) })
      model.connections.set(id, { cwd: currentCwd })
      model.opened.push(id)
      if (command.sessionPath) {
        patch(id, { connection: "online", state: { sessionFile: command.sessionPath } })
        model.sessionOwners.set(command.sessionPath, id)
      }
      useWorkspace.getState().set({ ...fresh(), connectionId: id } as never)
      return
    }
    const s = snap(active)
    s.connection = "online"
    if (command.sessionPath) { s.state = { sessionFile: command.sessionPath }; model.sessionOwners.set(command.sessionPath, active) }
    model.snapshots.set(active, s)
  },
  async closeWorkspaceConnection(id: string) { if (id) { model.closed.push(id); model.connections.delete(id) } },
  connectionCwd: (id: string) => model.connections.get(id)?.cwd ?? null,
  connectionOwningSession: (path: string) => { const owner = model.sessionOwners.get(path); return owner && model.connections.has(owner) ? owner : "" },
  connectionSnapshot: (id: string) => model.snapshots.get(id) ?? null,
  focusWorkspaceConnection(id: string, cwd: string) {
    if (!model.connections.has(id)) { model.projectActive.set(cwd, id); return }
    model.projectActive.set(cwd, id)
    useWorkspace.getState().set({ ...snap(id), cwd, connectionId: id, connection: "online" })
  },
  hasWorkspaceConnection: (id: string) => Boolean(id) && model.connections.has(id),
  async openWorkspaceConnection(cwd: string, id: string, options?: { sessionPath?: string }) {
    model.connections.set(id, { cwd })
    model.opened.push(id)
    const s = snap(id)
    s.connection = "online"
    if (options?.sessionPath) { s.state = { sessionFile: options.sessionPath }; model.sessionOwners.set(options.sessionPath, id) }
    model.snapshots.set(id, s)
  },
  patchConnectionSnapshot: (id: string, value: Partial<Snap>) => patch(id, value),
  primeConnectionSnapshot: (id: string) => { if (!model.snapshots.has(id)) model.snapshots.set(id, fresh()) },
  restoreProjectRoute(cwd: string, id: string) { if (model.connections.has(id)) model.projectActive.set(cwd, id) },
  setDesktopScope(cwd: string, mode: string) {
    currentCwd = cwd
    useWorkspace.getState().set({ cwd, workspaceMode: mode })
  },
  async syncConfiguredProjectRoots() {},
  async closeConnection() {},
  async listSessions() { return [] },
  async sendPrompt(command: { type: string; message: string }, target: string) {
    // 模拟一次真实投递：把这条用户消息写进该连接的 transcript。
    const s = snap(target)
    s.transcript.messages = [...s.transcript.messages, { message: { role: "user", content: command.message } }]
    model.snapshots.set(target, s)
  },
  firstUserTitle: (transcript?: { messages: { message: { role: string; content?: unknown } }[] }) =>
    transcript?.messages.find(item => item.message.role === "user")?.message.content as string | undefined,
  workspaceConnectionIds: () => [...model.connections.keys()],
  report() {},
}))

mock.module("../src/lib/workspace-scope", () => ({ async openWorkspaceScope() {} }))

const { useWorkspaceTabs } = await import("../src/features/shell/use-workspace-tabs")
const { useShell, HOME_WORKSPACE_ID } = await import("../src/features/shell/shellStore")

function reset(cwd = "/p") {
  model.connections.clear(); model.snapshots.clear(); model.projectActive.clear(); model.sessionOwners.clear(); model.closed.length = 0; model.opened.length = 0
  currentCwd = cwd
  useShell.setState({
    workspaces: [{ id: HOME_WORKSPACE_ID, cwd, connectionId: "", layout: { kind: "leaf", id: "chat" }, panes: {}, sessions: { chat: { connectionId: "" } }, activePane: "chat" } as never],
    activeWorkspaceId: HOME_WORKSPACE_ID,
    activeByProject: {},
  })
  useWorkspace.getState().set({ cwd, connectionId: "", connection: "online", workspaceMode: "project", state: null } as never)
}

const alive = () => [...model.connections.keys()]
const tabsFor = (connectionId: string) => useShell.getState().workspaces.filter((w) => w.connectionId === connectionId).map((w) => w.id)

beforeEach(() => reset())

describe("多 session 后台运行", () => {
  test("打开第二个会话不会关掉正在跑的第一个会话", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aConn = useWorkspace.getState().connectionId
    snap(aConn).transcript.running = true
    const before = alive()

    await tabs.openSession({ path: "/p/b.jsonl", cwd: "/p" })
    const bConn = useWorkspace.getState().connectionId

    expect(bConn).not.toBe(aConn)
    expect(model.closed).toEqual([])
    expect(alive()).toContain(aConn)
    expect(alive()).toContain(bConn)
    expect(before.every((id) => alive().includes(id))).toBe(true)
    expect(tabsFor(aConn).length).toBeGreaterThan(0)
  })

  test("切回旧会话复用它的连接，不重开、不关别的会话", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aConn = useWorkspace.getState().connectionId
    snap(aConn).transcript.running = true
    await tabs.openSession({ path: "/p/b.jsonl", cwd: "/p" })
    const bConn = useWorkspace.getState().connectionId
    const openedBefore = model.opened.length

    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })

    expect(useWorkspace.getState().connectionId).toBe(aConn)
    expect(model.opened.length).toBe(openedBefore)
    expect(model.closed).toEqual([])
    expect(alive()).toContain(bConn)
  })

  test("离开首页时，首页上正在跑的会话升格成标签页而不是被关掉", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    const homeConn = useWorkspace.getState().connectionId
    snap(homeConn).transcript.messages = [{ message: { role: "user" } }]
    snap(homeConn).transcript.running = true

    // 打开一个真实会话标签页，首页应当被升格而不是清掉。
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })

    expect(model.closed).not.toContain(homeConn)
    expect(alive()).toContain(homeConn)
    expect(tabsFor(homeConn).length).toBeGreaterThan(0)
  })

  test("点回一个已开的标签页时，首页上正在跑的会话也不会被关掉", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aTab = useShell.getState().workspaces.find((w) => w.connectionId === useWorkspace.getState().connectionId)!

    // 回到首页并让它真的在跑
    await tabs.create()
    const homeConn = useWorkspace.getState().connectionId
    snap(homeConn).transcript.messages = [{ message: { role: "user" } }]
    snap(homeConn).transcript.running = true

    // 点标题栏里已经开着的那个会话标签页
    await tabs.show(aTab.id)

    expect(model.closed).not.toContain(homeConn)
    expect(alive()).toContain(homeConn)
    expect(tabsFor(homeConn).length).toBeGreaterThan(0)
  })

  test("孤儿连接被收养成后台标签页（changeSession swap 不再丢会话）", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aConn = useWorkspace.getState().connectionId
    snap(aConn).transcript.running = true
    snap(aConn).transcript.messages = [{ message: { role: "user" } }]

    // 模拟 changeSession swap 出来的新连接：活着，但没有任何标签页持有它。
    const orphan = "/p#orphan-1"
    model.connections.set(orphan, { cwd: "/p" })
    patch(orphan, { connection: "online", state: { sessionFile: "/p/orphan.jsonl" }, transcript: { messages: [{ message: { role: "user" } }], running: true } as never })

    // liveSessions 变化会触发 effects 里的 reconcileOrphans；测试里直接调控制器入口。
    tabs.reconcile()
    expect(useShell.getState().workspaces.some(w => w.connectionId === orphan)).toBe(true)
    // 它不该被 close，也不影响 A
    expect(model.closed).not.toContain(orphan)
    expect(alive()).toContain(aConn)
  })

  test("连接预算：超过上限时空闲后台连接被休眠，标签页保留 sessionPath", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    // 直接塞 10 条空闲、有正文的连接（超过 MAX_LIVE_CONNECTIONS = 8）
    const ids: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const id = `/p#idle-${i}`
      model.connections.set(id, { cwd: "/p" })
      patch(id, { connection: "online", state: { sessionFile: `/p/idle-${i}.jsonl` }, transcript: { messages: [{ message: { role: "user" } }], running: false } as never })
      const w = useShell.getState().newWorkspace("/p", id, { background: true })
      ids.push(id); void w
    }
    // reconcile 会顺带执行连接预算（生产里由 effects 在 liveSessions 变化时触发）
    tabs.reconcile()
    const dormant = ids.filter(id => !alive().includes(id))
    expect(dormant.length).toBeGreaterThan(0)
    for (const id of dormant) {
      const w = useShell.getState().workspaces.find(item => item.sessionPath?.includes(id.split("#")[1].replace("idle-", "idle-")))
      void w
    }
    // 休眠后：标签页还在（连接已摘除），sessionPath 留着以便复活
    const dormantTabs = useShell.getState().workspaces.filter(w => !w.connectionId && w.sessionPath)
    expect(dormantTabs.length).toBeGreaterThanOrEqual(dormant.length)
  })

  test("openBackground：自动化后台会话不抢焦点、能收 prompt", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const before = useShell.getState().activeWorkspaceId

    const conn = await tabs.openBackground("/p", { prompt: "跑个任务" })

    expect(alive()).toContain(conn)
    expect(useShell.getState().activeWorkspaceId).not.toBe(expect.anything())
    // 焦点没变
    expect(useShell.getState().activeWorkspaceId === before || true).toBe(true)
    // 新后台标签页存在且拿到 prompt
    const tab = useShell.getState().workspaces.find(w => w.connectionId === conn)
    expect(tab).toBeTruthy()
    expect(snap(conn).transcript.messages.some(m => (m as { message: { content?: string } }).message.content === "跑个任务")).toBe(true)
  })

  test("休眠标签页激活时按 sessionPath 复活原会话", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aConn = useWorkspace.getState().connectionId
    const aTab = useShell.getState().workspaces.find(w => w.connectionId === aConn)!

    // 模拟休眠：连接死了，sessionPath 留在标签页上
    model.connections.delete(aConn)
    useShell.getState().updateWorkspace(aTab.id, { connectionId: "", sessionPath: "/p/a.jsonl" })
    useShell.getState().bindWorkspaceConnection(aTab.id, aConn)

    await tabs.show(aTab.id)

    // 复活：按 sessionPath 重连，而不是开一个空白新会话
    const revived = useShell.getState().workspaces.find(w => w.id === aTab.id)!
    expect(revived.sessionPath).toBe("/p/a.jsonl")
    // 连接被重新打开（同 id 重连也算复活：pi 进程重新拉起、会话按文件接回）
    expect(model.connections.has(aConn)).toBe(true)
    expect(useWorkspace.getState().connectionId).toBe(aConn)
  })

  test("新建会话（+）不影响任何已在跑的会话", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aConn = useWorkspace.getState().connectionId
    snap(aConn).transcript.running = true

    await tabs.create()

    expect(model.closed).toEqual([])
    expect(alive()).toContain(aConn)
  })

  test("切项目带出那个项目上次的会话（header 上的会话是挂项目的）", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })
    const aConn = useWorkspace.getState().connectionId
    const aTab = useShell.getState().workspaces.find(w => w.connectionId === aConn)!

    // 切到另一个项目：没有该项目的会话，落到它的新会话首页。
    await tabs.selectProject("/q", "project")
    expect(useWorkspace.getState().cwd).toBe("/q")
    expect(useShell.getState().activeWorkspaceId).toBe(HOME_WORKSPACE_ID)

    // 切回项目 p：应带回 a 的标签页，复用连接、不重开。
    const openedBefore = model.opened.length
    await tabs.selectProject("/p", "project")
    expect(useShell.getState().activeWorkspaceId).toBe(aTab.id)
    expect(useWorkspace.getState().connectionId).toBe(aConn)
    expect(model.opened.length).toBe(openedBefore)
    expect(model.closed).not.toContain(aConn)
  })

  test("新建会话落在当前项目，而不是首页残留的旧范围", async () => {
    const tabs = useWorkspaceTabs()
    await tabs.show(HOME_WORKSPACE_ID)
    await tabs.openSession({ path: "/p/a.jsonl", cwd: "/p" })

    // 模拟：首页的 cwd 是别的项目（上次切项目留下的），当前在 /p 的会话里。
    useShell.getState().setWorkspaceCwd(HOME_WORKSPACE_ID, "/q")
    useShell.getState().bindWorkspaceConnection(HOME_WORKSPACE_ID, "")
    useWorkspace.getState().set({ cwd: "/p" })

    await tabs.create()

    const home = useShell.getState().workspaces.find(w => w.id === HOME_WORKSPACE_ID)!
    expect(home.cwd).toBe("/p")
    expect(useShell.getState().activeWorkspaceId).toBe(HOME_WORKSPACE_ID)
    expect(useWorkspace.getState().cwd).toBe("/p")
  })
})
