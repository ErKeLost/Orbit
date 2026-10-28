import { persistState } from "./persistent"
import {
  OrbitRemoteClient,
  remoteReconnectDelay,
  type RemoteClientHandlers,
  type RemoteClientState,
  type RemoteForegroundReason,
} from "./remote-client"
import {
  findRemoteConnection,
  parsePairingEndpoints,
  type RemoteConnection,
  type RemoteEndpoint,
  type RemoteHostOperation,
  type RemoteHostSnapshot,
  type RemoteJson,
  type RemoteRequest,
  type RemoteScreenInput,
} from "./remote-protocol"
import { isBetterRoute, rankRemoteEndpoints, remoteRouteKey, remoteRouteKind, type RemoteRouteKind } from "./remote-route"
import { probeRemoteHostIdentity } from "./remote-identity"

const PAIRING_KEY = "orbit.remote.pairing.v1"
let client: StableRemoteRuntime | null = null

export function storedPairingUri(): string {
  return localStorage.getItem(PAIRING_KEY)?.trim() ?? ""
}

export function forgetPairing(): void {
  localStorage.removeItem(PAIRING_KEY)
  persistState(PAIRING_KEY, null)
  client?.close()
  client = null
}

/** How often a connected client asks whether a better route has come back. */
const ROUTE_PREFLIGHT_MS = 60_000
/** How long to wait after a drop before trying the other routes. */
const ROUTE_FAILOVER_MS = 1_500

const ROUTE_LABEL: Record<RemoteRouteKind, string> = {
  loopback: "本机",
  lan: "局域网",
  tailnet: "Tailscale",
  vpn: "VPN",
  public: "公网",
  relay: "中转",
}

/** One route, named the way the user thinks about it. */
function remoteRouteLabel(endpoint: RemoteEndpoint): string {
  const kind = ROUTE_LABEL[remoteRouteKind(endpoint)]
  if (endpoint.mode === "relay") {
    try {
      return `${kind} ${new URL(endpoint.relayUrl).host}`
    } catch {
      return kind
    }
  }
  return `${kind} ${endpoint.host}:${endpoint.port}`
}

function errorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim()
  return message.replace(/^Orbit (Host|Relay) /, "") || "未知错误"
}

/**
 * The failure in the few characters a phone has room for.
 *
 * The full text reads like "Orbit Host 认证握手超时", which is accurate and
 * unreadable twice over next to a route name in a 10px line. The order of the
 * checks is the order of specificity: a handshake timeout is a handshake
 * problem, not merely a timeout.
 */
function shortReason(message: string): string {
  if (/握手/.test(message)) return "握手失败"
  if (/身份|协议|另一台/.test(message)) return "不是这台电脑"
  if (/令牌|认证/.test(message)) return "认证失败"
  if (/超时/.test(message)) return "超时"
  if (/关闭|断开/.test(message)) return "连接被关闭"
  // "无法连接 Orbit Host" is the socket failing to open. After a route name
  // it must not repeat the sentence's own verb.
  if (/无法连接|连不上/.test(message)) return "没响应"
  return message.length > 14 ? `${message.slice(0, 14)}…` : message
}

/**
 * What to tell the user when every route refused.
 *
 * "All promises were rejected" is the message of the AggregateError itself, not
 * of any attempt, so it says nothing about whether the phone is on the wrong
 * Wi-Fi, the Host is off, or the relay never registered. Naming each route and
 * its own failure is the whole point of trying them in parallel.
 *
 * The hint after ` · ` is the second line on the pairing screen, so it stays a
 * complete sentence: the screen splits on that separator to style it apart.
 */
export function remoteFailureMessage(subject: string, targets: readonly RemoteEndpoint[], reasons: ReadonlyMap<RemoteEndpoint, string>): string {
  const parts = targets.map(endpoint => `${remoteRouteLabel(endpoint)}（${shortReason(reasons.get(endpoint) ?? "未响应")}）`)
  const relayFailed = targets.some(endpoint => endpoint.mode === "relay" && reasons.has(endpoint))
  const hint = relayFailed ? " · 电脑端「移动访问」是否已开启、中转服务器是否在线？" : ""
  return `${subject}：${parts.join("；")}${hint}`
}

/** Fired when the connection moved to a different route (LAN ⇄ relay). */
const routeListeners = new Set<(endpoint: RemoteEndpoint) => void>()

/**
 * Let the other sockets follow the control connection's route.
 *
 * The screen channel is its own WebSocket with its own endpoint, so a route
 * change on the control connection would otherwise leave the picture streaming
 * over the relay while the control traffic is on the LAN — the exact split that
 * makes a preview feel slow for no visible reason.
 */
export function addRemoteRouteChangeListener(listener: (endpoint: RemoteEndpoint) => void): () => void {
  routeListeners.add(listener)
  return () => {
    routeListeners.delete(listener)
  }
}

class StableRemoteRuntime {
  private active: OrbitRemoteClient | null = null
  /** Which route the live client is on. `null` before the first connection. */
  private activeEndpoint: RemoteEndpoint | null = null
  /** In-flight candidates, each with the route it is trying. */
  private readonly candidates = new Map<OrbitRemoteClient, RemoteEndpoint>()
  private closed = false
  /** Ranked once: a stable sort keeps the pairing URI's own order within a rank. */
  private readonly endpoints: RemoteEndpoint[]
  private readonly handlers: RemoteClientHandlers
  private preflightTimer: ReturnType<typeof setTimeout> | null = null
  private failoverTimer: ReturnType<typeof setTimeout> | null = null
  private failoverAttempt = 0

  constructor(endpoints: RemoteEndpoint[], handlers: RemoteClientHandlers) {
    this.endpoints = rankRemoteEndpoints(endpoints)
    this.handlers = handlers
  }

  async connect(): Promise<void> {
    // A pairing attempt is not allowed to be single-shot. A relay that has not
    // registered its host yet, a Wi-Fi handover, or a wake from sleep all make
    // the first round fail for reasons that fix themselves a second later; the
    // old code closed every candidate and sat on an error until the user tapped
    // again, which is exactly the "连接特别慢" the pairing screen showed.
    let lastError: Error = new Error("Orbit Host 没有可用连接地址")
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.closed) break
      try {
        await this.race("initial")
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, remoteReconnectDelay(attempt, 600, 4000)))
      }
    }
    throw lastError
  }

  private makeCandidate(): OrbitRemoteClient {
    let candidate: OrbitRemoteClient
    candidate = new OrbitRemoteClient({
      onHandshake: (serverTime) => {
        if (this.active === candidate) this.handlers.onHandshake?.(serverTime)
      },
      onState: (state) => {
        if (this.active !== candidate) return
        this.handlers.onState?.(state)
        // The client retries the endpoint it was given, forever and always with
        // the same jittered backoff. That is right for a blip and wrong for a
        // phone that has left the house: the LAN address it keeps retrying is
        // not going to answer. Walking the other routes is this layer's job.
        if (state === "offline") this.scheduleFailover()
      },
      onReconnected: () => {
        if (this.active === candidate) this.handlers.onReconnected?.()
      },
      onEvent: (event) => {
        if (this.active === candidate) this.handlers.onEvent?.(event)
      },
      onPiEvent: (project, payload) => {
        if (this.active === candidate) this.handlers.onPiEvent?.(project, payload)
      },
      onError: (error) => {
        if (this.active === candidate) this.handlers.onError?.(error)
      },
    })
    return candidate
  }

  /**
   * One attempt at one route.
   *
   * A direct address is asked who it is first. The token never travels in the
   * clear — it is inside the first encrypted frame — so a stranger at a reused
   * LAN address gets ciphertext, not a credential; what the probe buys is the
   * difference between a 2-second "this is not my computer" and a full connect
   * timeout followed by "无法连接 Orbit Host". The relay path needs no probe:
   * the host is named in the URL and the host id is checked at handshake.
   */
  private async connectCandidate(endpoint: RemoteEndpoint): Promise<OrbitRemoteClient> {
    if (endpoint.mode === "direct") await probeRemoteHostIdentity(endpoint)
    const candidate = this.makeCandidate()
    this.candidates.set(candidate, endpoint)
    try {
      await candidate.connect(endpoint)
      return candidate
    } catch (error) {
      this.candidates.delete(candidate)
      candidate.close()
      throw error
    }
  }

  private closeCandidates(): void {
    for (const candidate of [...this.candidates.keys()]) {
      candidate.close()
      this.candidates.delete(candidate)
    }
  }

  /** Whether some route ranks strictly better than the one carrying traffic. */
  private hasBetterRoute(): boolean {
    const current = this.activeEndpoint
    return current !== null && this.endpoints.some(endpoint => isBetterRoute(endpoint, current))
  }

  /**
   * Try the given routes in parallel and return the first that answers.
   *
   * Parallel on purpose: a LAN handshake that never completes must not delay the
   * relay behind it, and the losers are closed as soon as there is a winner.
   * Throws when every route fails, having closed all of them.
   */
  private async attempt(targets: readonly RemoteEndpoint[]): Promise<{ client: OrbitRemoteClient; endpoint: RemoteEndpoint }> {
    // Every route's own reason is kept: `Promise.any` rejects with an
    // AggregateError whose message is the useless "All promises were rejected",
    // and that string used to be what the pairing screen showed. Which route
    // failed and why is the only thing the user can act on.
    const reasons = new Map<RemoteEndpoint, string>()
    let winner: OrbitRemoteClient
    try {
      winner = await Promise.any(targets.map(endpoint => this.connectCandidate(endpoint).catch((error: unknown) => {
        reasons.set(endpoint, errorMessage(error))
        throw error
      })))
    } catch {
      this.closeCandidates()
      throw new Error(remoteFailureMessage("连不上电脑", targets, reasons))
    }
    // Losing the route would mean acting on a connection nobody can name, which
    // is a bug here rather than a page condition.
    const endpoint = this.candidates.get(winner)
    if (!endpoint) throw new Error("连接候选丢失了它的地址（内部错误）")
    return { client: winner, endpoint }
  }

  /** Make a won attempt the live connection, and tell everyone it moved. */
  private adopt(client: OrbitRemoteClient, endpoint: RemoteEndpoint): void {
    const previous = this.active
    const previousEndpoint = this.activeEndpoint
    this.active = client
    this.activeEndpoint = endpoint
    this.candidates.delete(client)
    this.closeCandidates()
    previous?.close()
    this.failoverAttempt = 0
    this.clearFailover()
    this.handlers.onState?.("online")
    if (previous) this.handlers.onReconnected?.()
    const moved = previousEndpoint === null || remoteRouteKey(previousEndpoint) !== remoteRouteKey(endpoint)
    if (previous !== null && moved) this.notifyRouteChange(endpoint)
    this.startPreflight()
  }

  private async race(mode: "initial" | "replace" | "upgrade"): Promise<void> {
    if (this.closed || this.endpoints.length === 0) throw new Error("Orbit Host 没有可用连接地址")
    if (this.candidates.size > 0) return
    // An upgrade only ever considers *better* routes: re-racing everything would
    // let a relay that answers marginally faster replace a working LAN session,
    // which costs the user bandwidth and latency to gain nothing.
    const current = this.activeEndpoint
    const targets = mode !== "upgrade"
      ? this.endpoints
      : current === null
        ? []
        : this.endpoints.filter(endpoint => isBetterRoute(endpoint, current))
    if (targets.length === 0) return
    let won: { client: OrbitRemoteClient; endpoint: RemoteEndpoint }
    try {
      won = await this.attempt(targets)
    } catch (error) {
      if (mode === "initial") this.handlers.onState?.("offline")
      throw error
    }
    if (this.closed) {
      won.client.close()
      this.closeCandidates()
      throw new Error("Orbit Host 连接已关闭")
    }
    // A network-change event fires on every Wi-Fi hiccup. Re-adopting a worse
    // route than the one already carrying traffic is not a recovery.
    if (mode !== "initial" && current !== null && isBetterRoute(current, won.endpoint)) {
      won.client.close()
      this.closeCandidates()
      return
    }
    this.adopt(won.client, won.endpoint)
  }

  private notifyRouteChange(endpoint: RemoteEndpoint): void {
    for (const listener of routeListeners) {
      try {
        listener(endpoint)
      } catch {
        // A listener that throws is not allowed to undo a route change.
      }
    }
  }

  /**
   * Try another route after a drop, backing off if the whole list fails.
   *
   * Bounded by `remoteReconnectDelay`'s cap rather than by a counter: a phone
   * that is out of range should keep trying forever, just not every second.
   */
  private scheduleFailover(): void {
    if (this.failoverTimer || this.closed || this.endpoints.length < 2) return
    const delay = remoteReconnectDelay(this.failoverAttempt, ROUTE_FAILOVER_MS, 30_000)
    this.failoverAttempt += 1
    this.failoverTimer = setTimeout(() => {
      this.failoverTimer = null
      if (this.closed) return
      void this.race("replace").catch(() => this.scheduleFailover())
    }, delay)
  }

  private clearFailover(): void {
    if (this.failoverTimer) clearTimeout(this.failoverTimer)
    this.failoverTimer = null
  }

  /**
   * While connected, keep asking whether a better route has come back.
   *
   * Leaving the house moves the phone from LAN to relay; coming home does not
   * produce an event that says so on every platform, so the connection would
   * stay on the relay — correct, but hundreds of kilobytes per second through a
   * server on another continent. A minute is short enough to notice and long
   * enough that a flapping Wi-Fi cannot turn it into a reconnect loop; the
   * attempt itself is a probe that only replaces the live session when it wins.
   */
  private startPreflight(): void {
    this.stopPreflight()
    if (this.closed || this.endpoints.length < 2) return
    this.preflightTimer = setTimeout(() => {
      this.preflightTimer = null
      if (this.closed) return
      if (!this.hasBetterRoute() || this.active?.connectionState !== "online") {
        this.startPreflight()
        return
      }
      void this.race("upgrade").catch(() => undefined).finally(() => this.startPreflight())
    }, ROUTE_PREFLIGHT_MS)
  }

  private stopPreflight(): void {
    if (this.preflightTimer) clearTimeout(this.preflightTimer)
    this.preflightTimer = null
  }

  notifyForeground(reason: RemoteForegroundReason): void {
    if (this.closed) return
    if (reason === "network-change") {
      void this.race("replace").catch(() => this.scheduleFailover())
      return
    }
    if (!this.active) {
      void this.race("initial").catch(() => this.scheduleFailover())
      return
    }
    // Coming back to the app is the other moment a better route is likely to be
    // there: the user just unlocked the phone, possibly on a different network.
    // Cheap to check, because an upgrade only tests better-ranked routes.
    if (this.hasBetterRoute()) void this.race("upgrade").catch(() => undefined)
    this.active.notifyForeground(reason)
  }

  get connectionState(): RemoteClientState {
    return this.active?.connectionState ?? "offline"
  }

  close(): void {
    this.closed = true
    this.stopPreflight()
    this.clearFailover()
    this.active?.close()
    for (const candidate of this.candidates.keys()) candidate.close()
    this.candidates.clear()
    this.active = null
    this.activeEndpoint = null
  }

  attach(connectionId: string, timeoutMs?: number) {
    return this.requireActive().attach(connectionId, timeoutMs)
  }

  sendPiCommand(project: string, command: Record<string, RemoteJson>, timeoutMs?: number) {
    return this.requireActive().sendPiCommand(project, command, timeoutMs)
  }

  runHostOperation<T = RemoteJson>(operation: RemoteHostOperation, timeoutMs?: number) {
    return this.requireActive().runHostOperation<T>(operation, timeoutMs)
  }

  runHostInvoke<T = RemoteJson>(command: string, args: Record<string, RemoteJson> | undefined) {
    return this.requireActive().runHostInvoke<T>(command, args)
  }

  getSnapshot(timeoutMs?: number) {
    return this.requireActive().getSnapshot(timeoutMs)
  }

  request(request: RemoteRequest, timeoutMs?: number) {
    return this.requireActive().request(request, timeoutMs)
  }

  notify(request: RemoteRequest) {
    this.requireActive().notify(request)
  }

  private requireActive(): OrbitRemoteClient {
    if (!this.active || this.active.connectionState !== "online") throw new Error("Orbit Host 未连接")
    return this.active
  }
}

export async function openRemoteRuntime(pairingUri: string, handlers: RemoteClientHandlers): Promise<RemoteHostSnapshot> {
  const endpoints = parsePairingEndpoints(pairingUri.trim())
  client?.close()
  const next = new StableRemoteRuntime(endpoints, handlers)
  client = next
  try {
    await next.connect()
    const snapshot = await next.getSnapshot()
    localStorage.setItem(PAIRING_KEY, pairingUri.trim())
    // The pairing URI is the one value whose loss sends the user back to the
    // computer, so it is mirrored durably.
    persistState(PAIRING_KEY, pairingUri.trim())
    return snapshot
  } catch (error) {
    if (client === next) client = null
    next.close()
    throw error
  }
}

function connectedClient(): StableRemoteRuntime {
  if (!client || client.connectionState !== "online") throw new Error("Orbit Host 未连接")
  return client
}

export function attachRemoteConnection(connectionId: string) {
  return connectedClient().attach(connectionId)
}

export function sendRemotePiCommand(project: string, command: Record<string, RemoteJson>, timeoutMs?: number) {
  return connectedClient().sendPiCommand(project, command, timeoutMs)
}

export function runRemoteHostOperation<T = RemoteJson>(operation: RemoteHostOperation, timeoutMs?: number) {
  return connectedClient().runHostOperation<T>(operation, timeoutMs)
}

/**
 * Run one of the desktop's commands on the desktop.
 *
 * The arguments are the ones the local call site already passes, so the same
 * component works on both sides of the pairing; see `native.ts` for the routing
 * rule and `src-tauri/src/remote_ops.rs` for what the Host will answer.
 */
export function runRemoteInvoke<T = RemoteJson>(command: string, args?: Record<string, unknown>) {
  return connectedClient().runHostInvoke<T>(command, args as Record<string, RemoteJson> | undefined)
}

export function remoteHostSnapshot() {
  return connectedClient().getSnapshot()
}

function connectionValue(value: RemoteJson | undefined): RemoteConnection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { id, cwd } = value as { id?: unknown; cwd?: unknown }
  return typeof id === "string" && id && typeof cwd === "string" && cwd ? { id, cwd } : undefined
}

/** Whether an error means this Host predates `connection.resolve`. */
function unknownOperationError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error)
  return message.includes("host.operation") || message.includes("不支持的远程消息")
}

/**
 * Ask the desktop which live connection serves a project.
 *
 * The desktop resolves a path the way its own bridge does — an exact
 * connection id first, then the canonical directory — so a phone never has to
 * reproduce the desktop's path rules. That is the difference between "the
 * desktop has this project open" and "the phone can attach to it" for a path
 * that reaches the desktop through a symlink or with a trailing slash.
 *
 * `undefined` means "no connection, or a Host too old to answer". A transport
 * failure still throws: treating it as "no connection" would hide why the
 * phone cannot reach the computer at all.
 */
export async function resolveRemoteConnection(project: string, timeoutMs = 10_000): Promise<RemoteConnection | undefined> {
  try {
    return connectionValue(await runRemoteHostOperation({ name: "connection.resolve", path: project }, timeoutMs))
  } catch (error) {
    if (unknownOperationError(error)) return undefined
    throw error
  }
}

/**
 * Wait for the desktop to expose a live connection for a project.
 *
 * `project.open` is asynchronous by design — the desktop window owns the Pi
 * connection, so the Host asks it rather than creating one — which means the
 * phone has to wait for the connection to appear instead of assuming it is
 * instant. Bounded so a desktop that never answers fails the tap rather than
 * hanging the rail. Every round asks the Host to resolve and only then falls
 * back to the connections in the snapshot, so the answer is the desktop's
 * rather than a path guess the phone made alone.
 */
export async function waitForRemoteConnection(cwd: string, timeoutMs = 20_000): Promise<RemoteConnection | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const resolved = await resolveRemoteConnection(cwd)
    if (resolved) return resolved
    const snapshot = await remoteHostSnapshot()
    const connection = findRemoteConnection(snapshot.connections, cwd)
    if (connection) return connection
    if (Date.now() >= deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

/**
 * Extra listeners that own their own socket (the screen channel) and want the
 * same foreground/network-change signal the control connection gets.
 */
const foregroundListeners = new Set<(reason: RemoteForegroundReason) => void>()

export function addRemoteForegroundListener(listener: (reason: RemoteForegroundReason) => void): () => void {
  foregroundListeners.add(listener)
  return () => {
    foregroundListeners.delete(listener)
  }
}

export function notifyRemoteForeground(reason: RemoteForegroundReason = "app-resume"): void {
  client?.notifyForeground(reason)
  for (const listener of foregroundListeners) listener(reason)
}

/**
 * Open a *second* authenticated connection for the screen channel.
 *
 * Same pairing credentials and the same application-layer key as the control
 * connection, but its own WebSocket: preview frames are hundreds of kilobytes
 * and must never queue ahead of a thinking token or an input reply. The host
 * sees this as just another client that happens to have subscribed to
 * `screen.start`.
 */
export async function screenRemoteChannel(handlers: RemoteClientHandlers): Promise<OrbitRemoteClient> {
  const uri = storedPairingUri()
  if (!uri) throw new Error("尚未配对 Orbit Host")
  // Ranked so the better route is not the one that loses a tie on a slow
  // socket: `Promise.any` takes the first to *finish*, and an unfinished LAN
  // handshake is still a better outcome than a relay that answered in 30 ms.
  // The probe makes a wrong address fail in ~2 s instead of at the connect
  // timeout, which is what lets the ranking matter at all.
  const endpoints = rankRemoteEndpoints(parsePairingEndpoints(uri.trim()))
  const reasons = new Map<RemoteEndpoint, string>()
  const attempts = endpoints.map(async endpoint => {
    try {
      if (endpoint.mode === "direct") await probeRemoteHostIdentity(endpoint)
      const candidate = new OrbitRemoteClient(handlers)
      try {
        await candidate.connect(endpoint)
        return candidate
      } catch (error) {
        candidate.close()
        throw error
      }
    } catch (error) {
      reasons.set(endpoint, errorMessage(error))
      throw error
    }
  })
  let winner: OrbitRemoteClient | null = null
  try {
    winner = await Promise.any(attempts)
    return winner
  } catch {
    throw new Error(remoteFailureMessage("屏幕通道连不上电脑", endpoints, reasons))
  } finally {
    for (const attempt of attempts) {
      void attempt.then(candidate => {
        if (candidate !== winner) candidate.close()
      }).catch(() => undefined)
    }
  }
}

/**
 * Screen input rides the control connection so it never waits behind a frame,
 * and is fire-and-forget: the host deliberately does not answer an input
 * event, so a drag costs one small send per sample.
 */
export function sendRemoteScreenInput(event: RemoteScreenInput): void {
  connectedClient().notify({ type: "screen.input", event })
}

/** Report the queueing delay this device sees. Fire and forget, like input. */
export function sendRemoteScreenAck(seq: number, queueDelayMs: number): void {
  try {
    connectedClient().notify({ type: "screen.ack", seq, queueDelayMs: Math.round(queueDelayMs) })
  } catch {
    // The control connection is down; the preview reports its own state.
  }
}
