import {
  decodeRemoteMessage,
  encodeRemoteMessage,
  isRemoteEvent,
  isRemoteHostSnapshot,
  remoteWebSocketUrl,
  REMOTE_PROTOCOL,
  type RemoteEndpoint,
  type RemoteEvent,
  type RemoteConnection,
  type RemoteHostSnapshot,
  type RemoteHostOperation,
  type RemoteJson,
  type RemoteRequest,
} from "./remote-protocol"
import { decryptRemoteFrame, encryptRemoteFrame } from "./remote-crypto"

export type RemoteClientState = "offline" | "connecting" | "online"
export type RemoteForegroundReason = "app-resume" | "network-change" | "focus"

export type RemoteClientOptions = {
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  heartbeatMs?: number
  heartbeatTimeoutMs?: number
  heartbeatMissedLimit?: number
  connectTimeoutMs?: number
  handshakeTimeoutMs?: number
}

export type RemoteClientHandlers = {
  onState?: (state: RemoteClientState) => void
  /** A replacement physical channel became authoritative while logical state stayed alive. */
  onReconnected?: () => void
  onEvent?: (event: RemoteEvent) => void
  onPiEvent?: (project: string, payload: RemoteJson) => void
  onError?: (error: Error) => void
}

export function remoteReconnectDelay(attempt: number, baseMs = 500, maxMs = 15_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
}

type PendingRequest = {
  resolve: (result: RemoteJson | undefined) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type SocketMode = "initial" | "replacement"

type PhysicalConnection = {
  socket: WebSocket
  mode: SocketMode
  authenticated: boolean
  settled: boolean
  resolve: () => void
  reject: (error: Error) => void
  connectTimer: ReturnType<typeof setTimeout> | null
  handshakeTimer: ReturnType<typeof setTimeout> | null
  inboundTail: Promise<void>
}

/** A stable logical client backed by replaceable authenticated WebSockets. */
export class OrbitRemoteClient {
  private active: PhysicalConnection | null = null
  private replacement: PhysicalConnection | null = null
  private state: RemoteClientState = "offline"
  private handlers: RemoteClientHandlers
  private readonly options: Required<RemoteClientOptions>
  private sequence = 0
  private pending = new Map<string, PendingRequest>()
  private endpoint: RemoteEndpoint | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private replacementTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectAttempt = 0
  private reconnectEnabled = false
  private manuallyClosed = true
  private heartbeatPending = false
  private heartbeatMisses = 0
  private lastInboundAt = 0
  private outboundTail: Promise<void> = Promise.resolve()

  constructor(handlers: RemoteClientHandlers = {}, options: RemoteClientOptions = {}) {
    this.handlers = handlers
    this.options = {
      reconnectBaseMs: options.reconnectBaseMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 5_000,
      heartbeatMs: options.heartbeatMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5_000,
      heartbeatMissedLimit: options.heartbeatMissedLimit ?? 3,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 8_000,
    }
  }

  get connectionState(): RemoteClientState {
    return this.state
  }

  connect(endpoint: RemoteEndpoint): Promise<void> {
    this.manuallyClosed = true
    this.clearReconnect()
    this.clearReplacementRetry()
    this.stopHeartbeat()
    this.closePhysical(this.active)
    this.closePhysical(this.replacement)
    this.active = null
    this.replacement = null
    this.rejectPending(new Error("Orbit Host 连接已替换"))
    this.endpoint = endpoint
    this.manuallyClosed = false
    this.reconnectEnabled = false
    this.reconnectAttempt = 0
    this.setState("connecting")
    return this.openSocket("initial").then(() => {
      this.reconnectEnabled = true
      if (!this.active && !this.manuallyClosed) this.scheduleReconnect()
    })
  }

  private openSocket(mode: SocketMode): Promise<void> {
    const endpoint = this.endpoint
    if (!endpoint) return Promise.reject(new Error("Orbit Host 地址不可用"))
    return new Promise((resolve, reject) => {
      let socket: WebSocket
      try {
        socket = new WebSocket(remoteWebSocketUrl(endpoint))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      let connection!: PhysicalConnection
      const resolveOnce = () => {
        if (connection.settled) return
        connection.settled = true
        resolve()
      }
      const rejectOnce = (error: Error) => {
        if (connection.settled) return
        connection.settled = true
        reject(error)
      }
      connection = {
        socket,
        mode,
        authenticated: false,
        settled: false,
        resolve: resolveOnce,
        reject: rejectOnce,
        connectTimer: null,
        handshakeTimer: null,
        inboundTail: Promise.resolve(),
      }
      if (mode === "replacement") this.replacement = connection
      else this.active = connection
      this.armConnectionTimers(connection)

      socket.onopen = () => {
        if (!this.isCurrent(connection)) return
        this.clearConnectTimer(connection)
        connection.handshakeTimer = setTimeout(() => {
          if (this.isCurrent(connection) && !connection.authenticated) {
            this.failSocket(connection, new Error("Orbit Host 认证握手超时"))
          }
        }, this.options.handshakeTimeoutMs)
      }
      socket.onmessage = event => {
        connection.inboundTail = connection.inboundTail
          .then(() => this.handleIncoming(connection, event.data))
          .catch(error => this.failSocket(connection, error instanceof Error ? error : new Error(String(error))))
      }
      socket.onerror = () => {
        if (!this.isCurrent(connection)) return
        const error = new Error("无法连接 Orbit Host")
        this.handlers.onError?.(error)
        if (!connection.authenticated) connection.reject(error)
        socket.close()
      }
      socket.onclose = () => this.handleClose(connection)
    })
  }

  private async handleIncoming(connection: PhysicalConnection, raw: unknown): Promise<void> {
    if (!this.isCurrent(connection) || typeof raw !== "string") return
    const message = await this.decodeFrame(raw)
    this.lastInboundAt = Date.now()
    if (!isRemoteEvent(message)) throw new Error("Orbit Host 返回了无效的远程消息")
    if (!connection.authenticated) {
      if (message.type !== "host.hello" || message.protocol !== REMOTE_PROTOCOL) {
        throw new Error("Orbit Host 认证握手无效")
      }
      if (this.endpoint?.mode === "relay" && message.hostId !== this.endpoint.hostId) {
        throw new Error("Orbit Relay Host 身份不匹配")
      }
      if (this.endpoint?.mode === "direct" && this.endpoint.hostId && message.hostId !== this.endpoint.hostId) {
        throw new Error("Orbit LAN Host 身份不匹配")
      }
      connection.authenticated = true
      this.clearConnectionTimers(connection)
      if (connection.mode === "replacement") this.promote(connection)
      else this.activateInitial(connection)
    }
    this.receive(message)
  }

  private activateInitial(connection: PhysicalConnection): void {
    if (this.active !== connection) return
    this.reconnectAttempt = 0
    this.setState("online")
    this.startHeartbeat()
    connection.resolve()
  }

  private promote(connection: PhysicalConnection): void {
    if (this.replacement !== connection) return
    const previous = this.active
    this.replacement = null
    this.active = connection
    this.reconnectAttempt = 0
    this.clearReplacementRetry()
    this.rejectPending(new Error("网络路径已切换，原请求需要重新确认"))
    this.stopHeartbeat()
    this.setState("online")
    this.startHeartbeat()
    this.handlers.onReconnected?.()
    this.closePhysical(previous)
    connection.resolve()
  }

  private handleClose(connection: PhysicalConnection): void {
    this.clearConnectionTimers(connection)
    if (this.active === connection) {
      this.active = null
      this.stopHeartbeat()
      this.rejectPending(new Error("Orbit Host 连接已关闭"))
      this.setState("offline")
      connection.reject(new Error("Orbit Host 连接已关闭"))
      if (!this.manuallyClosed && this.reconnectEnabled) this.scheduleReconnect()
      return
    }
    if (this.replacement === connection) {
      this.replacement = null
      connection.reject(new Error("Orbit Host 替换连接已关闭"))
      if (!this.manuallyClosed && this.active) this.scheduleReplacementRetry()
    }
  }

  private armConnectionTimers(connection: PhysicalConnection): void {
    connection.connectTimer = setTimeout(() => {
      if (this.isCurrent(connection) && connection.socket.readyState === WebSocket.CONNECTING) {
        this.failSocket(connection, new Error("Orbit Host WebSocket 连接超时"))
      }
    }, this.options.connectTimeoutMs)
  }

  private clearConnectionTimers(connection: PhysicalConnection): void {
    this.clearConnectTimer(connection)
    if (connection.handshakeTimer) clearTimeout(connection.handshakeTimer)
    connection.handshakeTimer = null
  }

  private clearConnectTimer(connection: PhysicalConnection): void {
    if (connection.connectTimer) clearTimeout(connection.connectTimer)
    connection.connectTimer = null
  }

  private failSocket(connection: PhysicalConnection, error: Error): void {
    if (!this.isCurrent(connection)) return
    this.handlers.onError?.(error)
    connection.socket.close()
  }

  private isCurrent(connection: PhysicalConnection): boolean {
    return this.active === connection || this.replacement === connection
  }

  send(request: RemoteRequest): void {
    const connection = this.active
    if (!connection || !connection.authenticated || connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Orbit Host 未连接")
    }
    const raw = encodeRemoteMessage(request)
    const endpoint = this.endpoint
    if (!endpoint || !("encryptionKey" in endpoint) || !endpoint.encryptionKey) {
      connection.socket.send(raw)
      return
    }
    const encryptionKey = endpoint.encryptionKey
    this.outboundTail = this.outboundTail
      .catch(() => undefined)
      .then(async () => {
        const frame = await encryptRemoteFrame(raw, encryptionKey)
        if (this.active === connection && connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.send(frame)
        }
      })
      .catch(error => this.handlers.onError?.(error instanceof Error ? error : new Error(String(error))))
  }

  private async decodeFrame(raw: string): Promise<RemoteEvent | RemoteRequest | null> {
    const endpoint = this.endpoint
    const value = endpoint && "encryptionKey" in endpoint && endpoint.encryptionKey
      ? await decryptRemoteFrame(raw, endpoint.encryptionKey)
      : raw
    return decodeRemoteMessage(value)
  }

  /**
   * Send a message that expects no reply.
   *
   * Used for high-frequency input: the host does not answer, so a finger on
   * the screen costs one small frame per event instead of a round trip.
   */
  notify(request: RemoteRequest): void {
    this.send(request)
  }

  sendPiCommand(project: string, command: Record<string, RemoteJson>, timeoutMs = 30_000): Promise<void> {
    return this.request({ type: "pi.command", project, command }, timeoutMs).then(() => undefined)
  }

  getSnapshot(timeoutMs = 10_000): Promise<RemoteHostSnapshot> {
    return this.request({ type: "host.snapshot" }, timeoutMs).then(result => {
      if (!isRemoteHostSnapshot(result)) throw new Error("Orbit Host 返回了无效的状态快照")
      return result
    })
  }

  attach(connectionId: string, timeoutMs = 10_000): Promise<RemoteConnection> {
    return this.request({ type: "connection.attach", connectionId }, timeoutMs).then(result => result as RemoteConnection)
  }

  /** Ask the desktop to start capturing. Resolution and rate are advisory. */
  startScreen(settings: Record<string, RemoteJson> = {}, timeoutMs = 20_000): Promise<RemoteJson | undefined> {
    return this.request({ type: "screen.start", settings }, timeoutMs)
  }

  stopScreen(timeoutMs = 5_000): Promise<void> {
    return this.request({ type: "screen.stop" }, timeoutMs).then(() => undefined)
  }

  screenStats(timeoutMs = 8_000): Promise<RemoteJson | undefined> {
    return this.request({ type: "screen.stats" }, timeoutMs)
  }

  runHostOperation<T = RemoteJson>(operation: RemoteHostOperation, timeoutMs = 30_000): Promise<T> {
    return this.request({ type: "host.operation", operation }, timeoutMs).then(result => result as T)
  }

  request(request: RemoteRequest, timeoutMs = 30_000): Promise<RemoteJson | undefined> {
    const requestId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error("Orbit Host 请求超时"))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timeout })
      try {
        this.send({ ...request, requestId })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    this.manuallyClosed = true
    this.reconnectEnabled = false
    this.endpoint = null
    this.clearReconnect()
    this.clearReplacementRetry()
    this.stopHeartbeat()
    this.closePhysical(this.active)
    this.closePhysical(this.replacement)
    this.active = null
    this.replacement = null
    this.rejectPending(new Error("Orbit Host 连接已关闭"))
    this.setState("offline")
  }

  /** Notify the transport that the mobile app or network became usable again. */
  notifyForeground(reason: RemoteForegroundReason = "app-resume"): void {
    if (this.manuallyClosed || !this.endpoint) return
    if (reason === "network-change") {
      if (this.active?.authenticated) this.startReplacement()
      else this.restartActive()
      return
    }
    if (!this.active) {
      this.clearReconnect()
      this.reconnectAttempt = 0
      void this.openSocket("initial").catch(() => {
        if (!this.active && !this.manuallyClosed) this.scheduleReconnect()
      })
      return
    }
    if (!this.active.authenticated) {
      this.restartActive()
      return
    }
    this.sendHeartbeatNow()
  }

  private restartActive(): void {
    if (this.manuallyClosed || !this.endpoint) return
    this.clearReconnect()
    this.clearReplacementRetry()
    this.closePhysical(this.active)
    this.closePhysical(this.replacement)
    this.active = null
    this.replacement = null
    this.stopHeartbeat()
    this.rejectPending(new Error("网络路径已变化，正在切换连接"))
    this.setState("connecting")
    void this.openSocket("initial").catch(() => {
      if (!this.active && !this.manuallyClosed) this.scheduleReconnect()
    })
  }

  private startReplacement(): void {
    if (this.replacement || this.manuallyClosed || !this.active || !this.endpoint) return
    this.clearReplacementRetry()
    void this.openSocket("replacement").catch(() => {
      if (this.active && !this.manuallyClosed) this.scheduleReplacementRetry()
    })
  }

  private scheduleReplacementRetry(): void {
    if (this.replacementTimer || this.manuallyClosed || !this.active) return
    const delay = remoteReconnectDelay(this.reconnectAttempt++, this.options.reconnectBaseMs, this.options.reconnectMaxMs)
    this.replacementTimer = setTimeout(() => {
      this.replacementTimer = null
      this.startReplacement()
    }, delay)
  }

  private clearReplacementRetry(): void {
    if (this.replacementTimer) clearTimeout(this.replacementTimer)
    this.replacementTimer = null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manuallyClosed || !this.endpoint) return
    const delay = remoteReconnectDelay(this.reconnectAttempt++, this.options.reconnectBaseMs, this.options.reconnectMaxMs)
    this.setState("connecting")
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket("initial").catch(() => {
        if (!this.active && !this.manuallyClosed) this.scheduleReconnect()
      })
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private closePhysical(connection: PhysicalConnection | null): void {
    if (!connection) return
    this.clearConnectionTimers(connection)
    connection.socket.close()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (this.options.heartbeatMs <= 0) return
    this.heartbeatTimer = setInterval(() => this.sendHeartbeatNow(), this.options.heartbeatMs)
    this.sendHeartbeatNow()
  }

  private sendHeartbeatNow(): void {
    const connection = this.active
    if (this.heartbeatPending || !connection?.authenticated || this.state !== "online") return
    if (Date.now() - this.lastInboundAt < this.options.heartbeatMs) return
    this.heartbeatPending = true
    this.request({ type: "host.ping" }, this.options.heartbeatTimeoutMs)
      .then(() => { this.heartbeatMisses = 0 })
      .catch(() => {
        this.heartbeatMisses += 1
        if (this.heartbeatMisses >= this.options.heartbeatMissedLimit) connection.socket.close()
      })
      .finally(() => { this.heartbeatPending = false })
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.heartbeatPending = false
  }

  private receive(event: RemoteEvent): void {
    this.handlers.onEvent?.(event)
    if (event.type === "pi.event") this.handlers.onPiEvent?.(event.project, event.payload)
    if (event.type === "pi.events") {
      for (const payload of event.payloads) this.handlers.onPiEvent?.(event.project, payload)
    }
    if (!("requestId" in event) || !event.requestId) return
    const pending = this.pending.get(event.requestId)
    if (!pending) return
    if (event.type === "host.pong") {
      clearTimeout(pending.timeout)
      this.pending.delete(event.requestId)
      pending.resolve({ serverTime: event.serverTime })
      return
    }
    if (event.type !== "remote.result" && event.type !== "remote.error") return
    clearTimeout(pending.timeout)
    this.pending.delete(event.requestId)
    if (event.type === "remote.error") pending.reject(new Error(event.error))
    else if (event.ok) pending.resolve(event.result)
    else pending.reject(new Error(event.error ?? "Orbit Host 请求失败"))
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private setState(state: RemoteClientState): void {
    if (this.state === state) return
    this.state = state
    this.handlers.onState?.(state)
  }
}
