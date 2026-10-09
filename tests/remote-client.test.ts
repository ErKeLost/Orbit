import { afterEach, describe, expect, test } from "bun:test"
import { OrbitRemoteClient, remoteReconnectDelay } from "../src/lib/remote-client"
import { decryptRemoteFrame, encryptRemoteFrame, equalBytes } from "../src/lib/remote-crypto"

function makeKey(): string {
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + 1
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

const KEY = makeKey()

type SocketHandler = ((event: { data?: string }) => void) | null

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []
  static autoHello = true

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  onopen: SocketHandler = null
  onmessage: SocketHandler = null
  onerror: SocketHandler = null
  onclose: SocketHandler = null

  private sessionId: Uint8Array | null = null
  private inSeq = -1
  private outSeq = 0
  private outboundTail: Promise<void> = Promise.resolve()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.open())
  }

  private open() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  send(raw: string) {
    void this.handleIncoming(raw)
  }

  private async handleIncoming(raw: string) {
    let frame
    try {
      frame = await decryptRemoteFrame(raw, KEY)
    } catch {
      return
    }
    if (!this.sessionId) {
      // First frame is the client's auth frame, which establishes the session.
      if (frame.seq !== 0) return
      this.sessionId = frame.sessionId
      this.inSeq = 0
      this.outSeq = 0
      if (FakeWebSocket.autoHello) await this.sendHello()
      return
    }
    if (!equalBytes(frame.sessionId, this.sessionId) || frame.seq <= this.inSeq) return
    this.inSeq = frame.seq
    const request = JSON.parse(frame.plaintext) as { type?: string; requestId?: string }
    if (!request.requestId) return
    const response = request.type === "host.ping"
      ? { type: "host.pong", requestId: request.requestId, serverTime: Date.now() }
      : request.type === "host.snapshot"
        ? { type: "remote.result", requestId: request.requestId, ok: true, result: { protocol: "orbit.remote.v1", serverTime: Date.now(), theme: "dark", connections: [] } }
        : { type: "remote.result", requestId: request.requestId, ok: true, result: null }
    await this.sendEnvelope(response)
  }

  private async sendHello() {
    const sessionId = this.sessionId
    if (!sessionId) return
    const payload = await encryptRemoteFrame(JSON.stringify({
      type: "host.hello",
      protocol: "orbit.remote.v1",
      hostId: "desktop",
      serverTime: Date.now(),
    }), KEY, sessionId, 0)
    queueMicrotask(() => this.onmessage?.({ data: payload }))
  }

  private async sendEnvelope(message: unknown) {
    const sessionId = this.sessionId
    if (!sessionId) return
    const seq = ++this.outSeq
    this.outboundTail = this.outboundTail.then(async () => {
      const payload = await encryptRemoteFrame(JSON.stringify(message), KEY, sessionId, seq)
      queueMicrotask(() => this.onmessage?.({ data: payload }))
    })
    await this.outboundTail
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    queueMicrotask(() => this.onclose?.({}))
  }

  serverClose() {
    this.close()
  }

  async serverSend(message: unknown) {
    // The client sends its auth frame asynchronously after the socket opens;
    // wait until this fake host has processed it before answering.
    for (let attempt = 0; attempt < 100 && !this.sessionId; attempt += 1) {
      await Bun.sleep(1)
    }
    await this.sendEnvelope(message)
  }
}

const originalWebSocket = globalThis.WebSocket
const clients: OrbitRemoteClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  FakeWebSocket.instances = []
  FakeWebSocket.autoHello = true
  globalThis.WebSocket = originalWebSocket
})

const endpoint = { mode: "direct", host: "127.0.0.1", port: 17777, token: "1234567890abcdef", encryptionKey: KEY } as const

describe("remote client reconnect", () => {
  test("uses bounded exponential backoff", () => {
    expect([0, 1, 2, 8].map(attempt => remoteReconnectDelay(attempt, 100, 500))).toEqual([100, 200, 400, 500])
  })

  test("reconnects after an unexpected close and stops after an explicit close", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const states: string[] = []
    const client = new OrbitRemoteClient({ onState: state => states.push(state) }, { reconnectBaseMs: 5, reconnectMaxMs: 10, heartbeatMs: 0 })
    clients.push(client)

    await client.connect(endpoint)
    expect(client.connectionState).toBe("online")
    expect(FakeWebSocket.instances).toHaveLength(1)

    FakeWebSocket.instances[0].serverClose()
    await Bun.sleep(20)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(client.connectionState).toBe("online")
    expect(states).toContain("connecting")
    expect(states).toContain("offline")

    client.close()
    await Bun.sleep(20)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(client.connectionState).toBe("offline")
  })

  test("accepts host.pong as the heartbeat response", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = new OrbitRemoteClient({}, { reconnectBaseMs: 5, reconnectMaxMs: 10, heartbeatMs: 5, heartbeatTimeoutMs: 10 })
    clients.push(client)
    await client.connect(endpoint)

    await Bun.sleep(30)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(client.connectionState).toBe("online")
  })

  test("receives desktop theme events and validates themed snapshots", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const events: string[] = []
    const client = new OrbitRemoteClient({ onEvent: event => { if (event.type === "host.theme") events.push(event.theme) } }, { heartbeatMs: 0 })
    clients.push(client)
    await client.connect(endpoint)

    expect((await client.getSnapshot()).theme).toBe("dark")
    await FakeWebSocket.instances[0].serverSend({ type: "host.theme", theme: "light", serverTime: Date.now() })
    await FakeWebSocket.instances[0].serverSend({ type: "host.theme", theme: "system", serverTime: Date.now() })
    await Bun.sleep(0)
    expect(events).toEqual(["light"])
  })

  test("does not report online until the host handshake arrives", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    FakeWebSocket.autoHello = false
    const states: string[] = []
    const client = new OrbitRemoteClient({ onState: state => states.push(state) }, {
      heartbeatMs: 0,
      handshakeTimeoutMs: 50,
      reconnectBaseMs: 100,
    })
    clients.push(client)
    const connection = client.connect(endpoint)
    await Bun.sleep(5)
    expect(client.connectionState).toBe("connecting")
    expect(states).not.toContain("online")
    await expect(connection).rejects.toThrow(/握手|关闭/)
  })

  test("replaces a stale socket immediately after a network change", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = new OrbitRemoteClient({}, { heartbeatMs: 0 })
    clients.push(client)
    await client.connect(endpoint)
    const first = FakeWebSocket.instances[0]
    client.notifyForeground("network-change")
    await Bun.sleep(0)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]).not.toBe(first)
    expect(client.connectionState).toBe("online")
  })

  test("keeps the authenticated socket alive until replacement handshake succeeds", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = new OrbitRemoteClient({}, { heartbeatMs: 0 })
    clients.push(client)
    await client.connect(endpoint)
    const first = FakeWebSocket.instances[0]
    FakeWebSocket.autoHello = false

    client.notifyForeground("network-change")
    await Bun.sleep(0)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(first.readyState).toBe(FakeWebSocket.OPEN)

    await FakeWebSocket.instances[1].serverSend({
      type: "host.hello",
      protocol: "orbit.remote.v1",
      hostId: "desktop",
      serverTime: Date.now(),
    })
    await Bun.sleep(20)
    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    expect(client.connectionState).toBe("online")
  })
})

describe("remote client chunk reassembly", () => {
  // The desktop cuts one Pi event into `pi.event.chunk` frames when it is too
  // large for a single frame — a `get_messages` response on a few hundred
  // messages. Dropping it instead is what a phone sees as "Pi get_messages
  // 响应超时" while the desktop looks fine, so reassembly is the contract.
  async function connected(
    onPiEvent: (project: string, payload: unknown) => void,
    onError?: (error: Error) => void,
    options: { reconnectBaseMs?: number; reconnectMaxMs?: number } = {},
  ) {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = new OrbitRemoteClient(
      { onPiEvent, ...(onError ? { onError } : {}) },
      { heartbeatMs: 0, ...options },
    )
    clients.push(client)
    await client.connect(endpoint)
    return client
  }

  // Inbound frames are decrypted on a promise chain, so a delivered payload
  // lands a turn after the frame that carried it.
  const settle = () => Bun.sleep(20)

  test("reassembles one payload from frames that arrive in order", async () => {
    const received: { project: string; payload: unknown }[] = []
    await connected((project, payload) => received.push({ project, payload }))
    const payload = JSON.stringify({ type: "response", command: "get_messages", id: "r1", success: true, data: { messages: [{ role: "user", content: "你好" }] } })
    const cut = Math.floor(payload.length / 3)
    const parts = [payload.slice(0, cut), payload.slice(cut, cut * 2), payload.slice(cut * 2)]
    for (const [index, data] of parts.entries()) {
      await FakeWebSocket.instances[0].serverSend({ type: "pi.event.chunk", project: "/w/demo", id: 7, index, total: parts.length, data })
    }
    await settle()
    expect(received).toEqual([{ project: "/w/demo", payload: JSON.parse(payload) }])
  })

  test("holds a payload until its last frame, whatever order frames arrive in", async () => {
    const received: unknown[] = []
    await connected((_project, payload) => received.push(payload))
    const payload = JSON.stringify({ type: "response", command: "get_messages", id: "r2", success: true, data: { messages: ["a", "b"] } })
    const cut = Math.floor(payload.length / 2)
    const parts = [payload.slice(0, cut), payload.slice(cut)]
    await FakeWebSocket.instances[0].serverSend({ type: "pi.event.chunk", project: "/w/demo", id: 8, index: 1, total: 2, data: parts[1] })
    await settle()
    expect(received).toHaveLength(0)
    await FakeWebSocket.instances[0].serverSend({ type: "pi.event.chunk", project: "/w/demo", id: 8, index: 0, total: 2, data: parts[0] })
    await settle()
    expect(received).toEqual([JSON.parse(payload)])
  })

  test("says so when a payload cannot be reassembled", async () => {
    const errors: string[] = []
    const received: unknown[] = []
    await connected((_project, payload) => received.push(payload), (error) => errors.push(error.message))
    await FakeWebSocket.instances[0].serverSend({ type: "pi.event.chunk", project: "/w/demo", id: 9, index: 0, total: 1, data: "not json" })
    await settle()
    expect(received).toEqual([])
    expect(errors).toEqual(["电脑端发来的分段事件无法解析"])
  })

  test("keeps a dropped socket's half-built payload out of the next one", async () => {
    const received: unknown[] = []
    await connected((_project, payload) => received.push(payload), undefined, { reconnectBaseMs: 1, reconnectMaxMs: 5 })
    await FakeWebSocket.instances[0].serverSend({ type: "pi.event.chunk", project: "/w/demo", id: 11, index: 0, total: 2, data: '{"type":"response"' })
    await settle()
    FakeWebSocket.instances[0].serverClose()
    await settle()
    expect(FakeWebSocket.instances).toHaveLength(2)
    // The same chunk id after a reconnect belongs to a new payload, not to the
    // half of the old one that can never be completed.
    await FakeWebSocket.instances[1].serverSend({ type: "pi.event.chunk", project: "/w/demo", id: 11, index: 0, total: 1, data: '{"type":"response","id":"r4"}' })
    await settle()
    expect(received).toEqual([{ type: "response", id: "r4" }])
  })
})
