/**
 * Messages shared by the desktop host and the mobile client.
 *
 * Keep this protocol deliberately small: Pi's native RPC payload is carried
 * as an opaque JSON value so new Pi events do not require a mobile release.
 */
export const REMOTE_PROTOCOL = "orbit.remote.v1" as const

export type RemoteJson = string | number | boolean | null | RemoteJson[] | { [key: string]: RemoteJson }
export type RemoteTheme = "light" | "dark"

export type RemoteHostOperation =
  | { name: "session.list"; cwd: string }
  | { name: "project.files"; cwd: string }
  | { name: "session.turnDurations"; sessionPath: string }
  | { name: "session.delete"; sessionPath: string }
  /**
   * A project change, which the desktop window applies to its own registry.
   *
   * The Host validates the path and asks the window; the phone then sees the
   * result in `projects` rather than in this reply, because the window owns the
   * list (names, extra roots, order).
   */
  | { name: "project.add"; path: string }
  | { name: "project.forget"; path: string }
  /**
   * Open a project that is already in the desktop's registry.
   *
   * The registry lists every project, but a phone can only attach to a project
   * that has a live Pi connection on the desktop. Tapping a listed-but-closed
   * project used to dead-end on "电脑端没有这个项目的活动连接"; this operation asks
   * the desktop window to make the connection, exactly as selecting it there
   * would. `project.add` implies an open, this one is the open without a write.
   */
  | { name: "project.open"; path: string }

/** One project as the desktop publishes it to the phone. */
export type RemoteProject = { path: string; name: string; roots?: string[] }

/** Shape a phone asks the desktop preview for. The host clamps and may adapt. */
export type RemoteScreenSettings = {
  maxWidth?: number
  maxFps?: number
  quality?: number
  displayId?: number
  showCursor?: boolean
  /** `"app"` follows the frontmost application's window. */
  source?: "app" | "display"
  /**
   * `"h264"` or `"jpeg"`. The host answers with the codec it actually used in
   * `RemoteScreenStartResult.codec`, so a phone that cannot decode H.264 asks
   * for JPEG instead of discovering the problem frame by frame.
   */
  codec?: RemoteScreenCodec
}

export type RemoteScreenCodec = "h264" | "jpeg"

/** A capturable display, in both logical points and device pixels. */
export type RemoteDisplay = {
  id: number
  name: string
  logicalX: number
  logicalY: number
  logicalWidth: number
  logicalHeight: number
  pixelWidth: number
  pixelHeight: number
  scale: number
  primary: boolean
}

/** Input events. Coordinates are normalized to the captured display. */
export type RemoteScreenInput =
  | { kind: "pointer"; phase: "down" | "move" | "up"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  | { kind: "scroll"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; key: string }
  | { kind: "text"; value: string }

export type RemoteScreenStartResult = {
  display: RemoteDisplay
  displays: RemoteDisplay[]
  codec: RemoteScreenCodec
  width: number
  height: number
}

export type RemoteScreenStatus = {
  running: boolean
  permission: boolean
  subscribers: number
  codec: RemoteScreenCodec
  /** What the host actually followed; may differ from the request. */
  source: "app" | "display"
  width: number
  height: number
  fps: number
  effectiveFps: number
  quality: number
  displays: RemoteDisplay[]
  display?: RemoteDisplay
  captured: number
  published: number
  dropped: number
  unchanged: number
  encodeMsAvg: number
  encodeMsMax: number
  bitsPerSecond: number
  /** Excess viewer-reported queueing delay the host governor is acting on. */
  queueDelayMs: number
  failure?: string
}

export type RemoteRequest =
  | { type: "host.ping"; requestId?: string }
  | { type: "host.snapshot"; requestId?: string }
  | { type: "host.operation"; requestId?: string; operation: RemoteHostOperation }
  /**
   * Call one of the desktop's own commands.
   *
   * The phone runs the same application, so it asks the same questions; the
   * Host answers them with the same functions the desktop webview calls
   * (`src-tauri/src/remote_ops.rs`). What may be asked is a closed list the
   * Host advertises in `host.snapshot.commands`, so the phone only routes a
   * command to the Host when the Host said it would answer it.
   */
  | { type: "host.invoke"; requestId?: string; command: string; args?: RemoteJson }
  | { type: "connection.attach"; requestId?: string; connectionId: string }
  | { type: "pi.command"; requestId?: string; project: string; command: Record<string, RemoteJson> }
  | { type: "screen.start"; requestId?: string; settings?: RemoteScreenSettings }
  | { type: "screen.stop"; requestId?: string }
  | { type: "screen.stats"; requestId?: string }
  | { type: "screen.displays"; requestId?: string }
  | { type: "screen.input"; requestId?: string; event: RemoteScreenInput }
  /**
   * The viewer's own measurement of how long a frame queued.
   *
   * Sent without a request id, like input: the host answers nothing. It exists
   * because only the viewer can see a link filling up — a byte budget on the
   * host notices after the fact.
   */
  | { type: "screen.ack"; requestId?: string; seq?: number; queueDelayMs: number }

export type RemoteConnection = { id: string; cwd: string }
export type RemoteHostSnapshot = {
  protocol: typeof REMOTE_PROTOCOL
  serverTime: number
  theme?: RemoteTheme
  machineName?: string
  connections: RemoteConnection[]
  /** The desktop's project registry, as last published by its window. */
  projects?: RemoteProject[]
  /** Commands this Host will answer over `host.invoke`. */
  commands?: string[]
}

/**
 * One encoded preview frame. `data` is base64 of the codec payload; the
 * envelope is built once on the host and shared by every subscriber.
 *
 * For H.264 the payload is AVCC (length-prefixed NAL units) and `description`
 * — an `AVCDecoderConfigurationRecord` — is present only on the frames where it
 * changed, which for a static desktop means the first frame and nothing after.
 */
export type RemoteScreenFrame = {
  type: "screen.frame"
  seq: number
  capturedAt: number
  encodedAt: number
  width: number
  height: number
  displayId: number
  displayWidth: number
  displayHeight: number
  scale: number
  codec: RemoteScreenCodec
  keyframe: boolean
  /** The encoder restarted its reference chain; the decoder must reset. */
  resync?: boolean
  /** Base64 `AVCDecoderConfigurationRecord`, present only when it changed. */
  description?: string | null
  bytes: number
  data: string
}

export type RemoteEvent =
  | RemoteScreenFrame
  | { type: "host.hello"; protocol: typeof REMOTE_PROTOCOL; hostId: string; serverTime: number; theme?: RemoteTheme; machineName?: string }
  | { type: "host.theme"; theme: RemoteTheme; serverTime: number }
  | { type: "host.projects"; projects: RemoteProject[]; serverTime: number }
  | { type: "host.pong"; requestId?: string; serverTime: number }
  | { type: "pi.event"; project: string; payload: RemoteJson }
  | { type: "pi.events"; project: string; payloads: RemoteJson[] }
  | { type: "connection.closed"; project: string }
  | { type: "connection.invalidated"; project: string; command: string }
  | { type: "remote.result"; requestId?: string; ok: boolean; result?: RemoteJson; error?: string }
  | { type: "remote.error"; requestId?: string; error: string }

export type RemoteMessage = RemoteRequest | RemoteEvent

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function isRemoteTheme(value: unknown): value is RemoteTheme {
  return value === "light" || value === "dark"
}

export function isRemoteProject(value: unknown): value is RemoteProject {
  return record(value) && stringValue(value.path) && stringValue(value.name)
    && (value.roots === undefined || (Array.isArray(value.roots) && value.roots.every(stringValue)))
}

export function isRemoteHostSnapshot(value: unknown): value is RemoteHostSnapshot {
  if (!record(value) || value.protocol !== REMOTE_PROTOCOL || typeof value.serverTime !== "number" || (value.theme !== undefined && !isRemoteTheme(value.theme)) || (value.machineName !== undefined && !stringValue(value.machineName)) || !Array.isArray(value.connections)) return false
  if (value.projects !== undefined && (!Array.isArray(value.projects) || !value.projects.every(isRemoteProject))) return false
  if (value.commands !== undefined && (!Array.isArray(value.commands) || !value.commands.every(stringValue))) return false
  return value.connections.every(connection => record(connection) && stringValue(connection.id) && stringValue(connection.cwd))
}

export function isRemoteHostOperation(value: unknown): value is RemoteHostOperation {
  if (!record(value) || typeof value.name !== "string") return false
  if (value.name === "session.list" || value.name === "project.files") return stringValue(value.cwd)
  if (value.name === "session.turnDurations" || value.name === "session.delete") return stringValue(value.sessionPath)
  if (value.name === "project.add" || value.name === "project.forget" || value.name === "project.open") return stringValue(value.path)
  return false
}

function isRemoteScreenInput(value: unknown): value is RemoteScreenInput {
  if (!record(value) || typeof value.kind !== "string") return false
  if (value.kind === "text") return typeof value.value === "string"
  if (value.kind === "key") return stringValue(value.key)
  if (value.kind === "scroll") return finite(value.x) && finite(value.y) && finite(value.dx) && finite(value.dy)
  if (value.kind === "pointer") {
    return (value.phase === "down" || value.phase === "move" || value.phase === "up") && finite(value.x) && finite(value.y)
  }
  return false
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isRemoteScreenFrame(value: Record<string, unknown>): value is RemoteScreenFrame & Record<string, unknown> {
  return typeof value.seq === "number"
    && typeof value.width === "number"
    && typeof value.height === "number"
    && typeof value.keyframe === "boolean"
    && stringValue(value.data)
    && (value.codec === "jpeg" || value.codec === "h264")
    && (value.description === undefined || value.description === null || typeof value.description === "string")
}

/** Runtime guard used at the WebSocket boundary. */
export function isRemoteRequest(value: unknown): value is RemoteRequest {
  if (!record(value) || typeof value.type !== "string") return false
  if (value.type === "host.ping" || value.type === "host.snapshot") return value.requestId === undefined || typeof value.requestId === "string"
  if (value.type === "host.operation") return (value.requestId === undefined || typeof value.requestId === "string") && isRemoteHostOperation(value.operation)
  if (value.type === "host.invoke") {
    return (value.requestId === undefined || typeof value.requestId === "string")
      && stringValue(value.command)
      && (value.args === undefined || record(value.args))
  }
  if (value.type === "connection.attach") return (value.requestId === undefined || typeof value.requestId === "string") && stringValue(value.connectionId)
  if (value.type === "screen.start") return value.requestId === undefined || typeof value.requestId === "string"
  if (value.type === "screen.stop" || value.type === "screen.stats" || value.type === "screen.displays") return value.requestId === undefined || typeof value.requestId === "string"
  if (value.type === "screen.input") return (value.requestId === undefined || typeof value.requestId === "string") && isRemoteScreenInput(value.event)
  if (value.type === "screen.ack") {
    return (value.requestId === undefined || typeof value.requestId === "string")
      && typeof value.queueDelayMs === "number"
      && Number.isFinite(value.queueDelayMs)
  }
  return value.type === "pi.command"
    && (value.requestId === undefined || typeof value.requestId === "string")
    && stringValue(value.project)
    && record(value.command)
}

export function isRemoteEvent(value: unknown): value is RemoteEvent {
  if (!record(value) || typeof value.type !== "string") return false
  const requestId = value.requestId === undefined || typeof value.requestId === "string"
  switch (value.type) {
    case "screen.frame":
      return isRemoteScreenFrame(value)
    case "host.hello":
      return value.protocol === REMOTE_PROTOCOL && stringValue(value.hostId) && typeof value.serverTime === "number" && (value.theme === undefined || isRemoteTheme(value.theme)) && (value.machineName === undefined || stringValue(value.machineName))
    case "host.theme":
      return isRemoteTheme(value.theme) && typeof value.serverTime === "number"
    case "host.projects":
      return Array.isArray(value.projects) && value.projects.every(isRemoteProject) && typeof value.serverTime === "number"
    case "host.pong":
      return requestId && typeof value.serverTime === "number"
    case "pi.event":
      return stringValue(value.project) && value.payload !== undefined
    case "pi.events":
      return stringValue(value.project) && Array.isArray(value.payloads)
    case "connection.closed":
      return stringValue(value.project)
    case "connection.invalidated":
      return stringValue(value.project) && stringValue(value.command)
    case "remote.result":
      return requestId && typeof value.ok === "boolean" && (value.error === undefined || typeof value.error === "string")
    case "remote.error":
      return requestId && stringValue(value.error)
    default:
      return false
  }
}

export function encodeRemoteMessage(message: RemoteMessage): string {
  return JSON.stringify(message)
}

export function decodeRemoteMessage(raw: string): RemoteMessage | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (isRemoteRequest(value) || isRemoteEvent(value)) return value
  } catch {
    // A malformed frame is handled by the caller as a protocol error.
  }
  return null
}

export type DirectRemoteEndpoint = {
  mode: "direct"
  host: string
  port: number
  token: string
  secure?: boolean
  hostId?: string
  /** Application-layer key. Present on new pairings; absent for legacy LAN pairings. */
  encryptionKey?: string
}

export type RelayRemoteEndpoint = {
  mode: "relay"
  relayUrl: string
  hostId: string
  token: string
  encryptionKey: string
}

export type RemoteEndpoint = DirectRemoteEndpoint | RelayRemoteEndpoint
export type RemoteEndpointSet = { endpoints: RemoteEndpoint[] }

export function remoteWebSocketUrl(endpoint: RemoteEndpoint): string {
  if (endpoint.mode === "relay") {
    const url = new URL(endpoint.relayUrl)
    url.pathname = `${url.pathname.replace(/\/$/, "")}/relay/client/${encodeURIComponent(endpoint.hostId)}`
    url.search = ""
    return url.toString()
  }
  const scheme = endpoint.secure ? "wss" : "ws"
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host
  return `${scheme}://${host}:${endpoint.port}/ws`
}

export function parsePairingUri(value: string): RemoteEndpoint {
  return parsePairingEndpoints(value)[0]!
}

export function parsePairingEndpoints(value: string): RemoteEndpoint[] {
  let uri: URL
  try {
    uri = new URL(value)
  } catch {
    throw new Error("无效的 Orbit 配对地址")
  }
  const host = uri.searchParams.get("host")?.trim().replace(/^\[|\]$/g, "") ?? ""
  const relay = uri.searchParams.get("relay")?.trim() ?? ""
  const hostId = uri.searchParams.get("hostId")?.trim() ?? ""
  const encryptionKey = uri.searchParams.get("key")?.trim() ?? ""
  const port = Number(uri.searchParams.get("port"))
  const token = uri.searchParams.get("token") ?? ""
  const protocol = uri.searchParams.get("protocol")
  if (uri.protocol !== "orbit:" || uri.hostname !== "pair" || (uri.pathname && uri.pathname !== "/")) throw new Error("无效的 Orbit 配对地址")
  if (protocol !== REMOTE_PROTOCOL) throw new Error("Orbit Host 协议版本不兼容")
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("Orbit 配对令牌无效")
  const endpoints: RemoteEndpoint[] = []
  if (host && Number.isInteger(port) && port >= 1 && port <= 65_535) {
    try {
      new URL(`ws://${host.includes(":") ? `[${host}]` : host}:${port}`)
      if (!/^[A-Za-z0-9_-]{43}$/.test(encryptionKey)) throw new Error("Orbit LAN 加密密钥无效")
      endpoints.push({ mode: "direct", host, port, token, ...(hostId ? { hostId } : {}), encryptionKey })
    } catch (error) {
      if (error instanceof Error && error.message.includes("加密密钥")) throw error
    }
  }
  if (relay) {
    let relayUrl: URL
    try {
      relayUrl = new URL(relay)
    } catch {
      throw new Error("Orbit Relay 地址无效")
    }
    if (relayUrl.protocol !== "wss:" && !(relayUrl.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(relayUrl.hostname))) throw new Error("Orbit Relay 必须使用 wss://")
    if (!/^[A-Za-z0-9-]{8,80}$/.test(hostId)) throw new Error("Orbit Relay Host ID 无效")
    if (!/^[A-Za-z0-9_-]{43}$/.test(encryptionKey)) throw new Error("Orbit Relay 加密密钥无效")
    endpoints.push({ mode: "relay", relayUrl: relayUrl.toString(), hostId, token, encryptionKey })
  }
  if (endpoints.length === 0) throw new Error("Orbit Host 没有可用连接地址")
  return endpoints
}
