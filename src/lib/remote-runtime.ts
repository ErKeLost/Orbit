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

class StableRemoteRuntime {
  private active: OrbitRemoteClient | null = null
  private readonly candidates = new Set<OrbitRemoteClient>()
  private closed = false
  private readonly endpoints: RemoteEndpoint[]
  private readonly handlers: RemoteClientHandlers

  constructor(endpoints: RemoteEndpoint[], handlers: RemoteClientHandlers) {
    this.endpoints = endpoints
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
        await this.race(false)
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
        if (this.active === candidate) this.handlers.onState?.(state)
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
    this.candidates.add(candidate)
    return candidate
  }

  private async race(replacement: boolean): Promise<void> {
    if (this.closed || this.endpoints.length === 0) throw new Error("Orbit Host 没有可用连接地址")
    if (!replacement && this.active) return
    if (this.candidates.size > 0) return
    const attempts = this.endpoints.map((endpoint) => {
      const candidate = this.makeCandidate()
      return candidate.connect(endpoint).then(() => candidate)
    })
    try {
      const winner = await Promise.any(attempts)
      if (this.closed) {
        winner.close()
        throw new Error("Orbit Host 连接已关闭")
      }
      const previous = this.active
      this.active = winner
      for (const candidate of [...this.candidates]) {
        if (candidate !== winner) candidate.close()
        this.candidates.delete(candidate)
      }
      previous?.close()
      this.handlers.onState?.("online")
      if (previous) this.handlers.onReconnected?.()
    } catch (error) {
      for (const candidate of this.candidates) candidate.close()
      this.candidates.clear()
      if (!replacement) this.handlers.onState?.("offline")
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  notifyForeground(reason: RemoteForegroundReason): void {
    if (this.closed) return
    if (reason === "network-change") {
      void this.race(true).catch(() => {})
      return
    }
    if (!this.active) {
      void this.race(false).catch(() => {})
      return
    }
    this.active.notifyForeground(reason)
  }

  get connectionState(): RemoteClientState {
    return this.active?.connectionState ?? "offline"
  }

  close(): void {
    this.closed = true
    this.active?.close()
    for (const candidate of this.candidates) candidate.close()
    this.active = null
    this.candidates.clear()
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
  const endpoints = parsePairingEndpoints(uri.trim())
  const attempts = endpoints.map(endpoint => {
    const candidate = new OrbitRemoteClient(handlers)
    return candidate.connect(endpoint).then(
      () => candidate,
      (error: unknown) => {
        candidate.close()
        throw error
      },
    )
  })
  let winner: OrbitRemoteClient | null = null
  try {
    winner = await Promise.any(attempts)
    return winner
  } catch {
    throw new Error("无法为屏幕通道连接 Orbit Host")
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
