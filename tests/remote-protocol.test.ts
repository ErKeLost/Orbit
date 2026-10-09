import { describe, expect, test } from "bun:test"
import { decodeRemoteMessage, encodeRemoteMessage, findRemoteConnection, isRemoteEvent, isRemoteHostSnapshot, isRemoteRequest, parsePairingEndpoints, parsePairingUri, remoteWebSocketUrl, sameRemotePath, REMOTE_PROTOCOL } from "../src/lib/remote-protocol"

const KEY = "k".repeat(43)

describe("remote protocol", () => {
  test("round trips a Pi command without interpreting its payload", () => {
    const message = { type: "pi.command" as const, requestId: "r1", project: "/workspace/demo", command: { type: "prompt", message: "hello" } }
    expect(decodeRemoteMessage(encodeRemoteMessage(message))).toEqual(message)
    expect(isRemoteRequest(message)).toBe(true)
  })

  test("builds a tokenless websocket endpoint", () => {
    expect(remoteWebSocketUrl({ mode: "direct", host: "192.168.1.8", port: 17890, token: "a b", encryptionKey: KEY })).toBe("ws://192.168.1.8:17890/ws")
    expect(remoteWebSocketUrl({ mode: "direct", host: "2001:db8::8", port: 17890, token: "abc", encryptionKey: KEY })).toBe("ws://[2001:db8::8]:17890/ws")
    expect(remoteWebSocketUrl({ mode: "relay", relayUrl: "wss://101.201.45.25/", hostId: "host-12345678", token: "1234567890abcdef", encryptionKey: KEY })).toBe("wss://101.201.45.25/relay/client/host-12345678")
  })

  test("rejects malformed requests", () => {
    expect(decodeRemoteMessage("{bad")).toBeNull()
    expect(isRemoteRequest({ type: "pi.command", project: "/tmp", command: "not-object" })).toBe(false)
    expect(REMOTE_PROTOCOL).toBe("orbit.remote.v1")
  })

  test("validates batched Pi events", () => {
    expect(isRemoteEvent({ type: "pi.events", project: "/workspace/demo", payloads: [{ type: "message_update" }] })).toBe(true)
    expect(isRemoteEvent({ type: "connection.closed", project: "/workspace/demo" })).toBe(true)
    expect(isRemoteEvent({ type: "host.hello", protocol: REMOTE_PROTOCOL, hostId: "desktop", serverTime: 1, theme: "dark" })).toBe(true)
    expect(isRemoteEvent({ type: "host.hello", protocol: REMOTE_PROTOCOL, hostId: "desktop", serverTime: 1, theme: "system" })).toBe(false)
    expect(isRemoteEvent({ type: "host.hello", protocol: "old", hostId: "desktop", serverTime: 1 })).toBe(false)
    expect(decodeRemoteMessage('{"type":"unknown"}')).toBeNull()
  })

  test("carries the desktop theme in snapshots and one-way host events", () => {
    expect(isRemoteHostSnapshot({ protocol: REMOTE_PROTOCOL, serverTime: 1, theme: "dark", connections: [] })).toBe(true)
    expect(isRemoteHostSnapshot({ protocol: REMOTE_PROTOCOL, serverTime: 1, machineName: "studio", connections: [] })).toBe(true)
    expect(isRemoteHostSnapshot({ protocol: REMOTE_PROTOCOL, serverTime: 1, connections: [] })).toBe(true)
    expect(isRemoteHostSnapshot({ protocol: REMOTE_PROTOCOL, serverTime: 1, theme: "system", connections: [] })).toBe(false)
    expect(isRemoteEvent({ type: "host.theme", theme: "light", serverTime: 2 })).toBe(true)
    expect(isRemoteEvent({ type: "host.theme", theme: "system", serverTime: 2 })).toBe(false)
    expect(decodeRemoteMessage('{"type":"host.theme","theme":"dark","serverTime":3}')).toEqual({ type: "host.theme", theme: "dark", serverTime: 3 })
  })

  test("supports discovery and explicit connection attachment", () => {
    expect(isRemoteRequest({ type: "host.snapshot", requestId: "snapshot" })).toBe(true)
    expect(isRemoteRequest({ type: "connection.attach", requestId: "attach", connectionId: "/workspace/demo" })).toBe(true)
    expect(isRemoteRequest({ type: "connection.attach", connectionId: "" })).toBe(false)
  })

  test("parses IPv4 and IPv6 pairing URIs", () => {
    expect(parsePairingUri(`orbit://pair?host=192.168.1.8&port=17890&token=1234567890abcdef&key=${KEY}&protocol=orbit.remote.v1`)).toEqual({ mode: "direct", host: "192.168.1.8", port: 17890, token: "1234567890abcdef", encryptionKey: KEY })
    expect(parsePairingUri(`orbit://pair?host=2001%3Adb8%3A%3A8&port=443&token=1234567890abcdef&key=${KEY}&protocol=orbit.remote.v1`)).toEqual({ mode: "direct", host: "2001:db8::8", port: 443, token: "1234567890abcdef", encryptionKey: KEY })
    expect(parsePairingUri(`orbit://pair?host=192.168.1.8&port=17890&token=1234567890abcdef&key=${KEY}&hostId=desktop-id&protocol=orbit.remote.v1`)).toEqual({ mode: "direct", host: "192.168.1.8", port: 17890, token: "1234567890abcdef", hostId: "desktop-id", encryptionKey: KEY })
    expect(parsePairingEndpoints(`orbit://pair?host=192.168.1.8&port=17890&relay=wss%3A%2F%2F101.201.45.25&hostId=desktop-id&token=1234567890abcdef&key=${KEY}&protocol=orbit.remote.v1`)).toHaveLength(2)
    expect(parsePairingUri(`orbit://pair?relay=wss%3A%2F%2F101.201.45.25&hostId=host-12345678&token=1234567890abcdef&key=${KEY}&protocol=orbit.remote.v1`)).toEqual({ mode: "relay", relayUrl: "wss://101.201.45.25/", hostId: "host-12345678", token: "1234567890abcdef", encryptionKey: KEY })
    expect(() => parsePairingUri("orbit://pair?relay=wss%3A%2F%2F101.201.45.25&hostId=host-12345678&token=1234567890abcdef&protocol=orbit.remote.v1")).toThrow(/加密密钥/)
    // A LAN pairing without an application key is no longer accepted: E2EE is mandatory.
    expect(() => parsePairingUri("orbit://pair?host=192.168.1.8&port=17890&token=1234567890abcdef&protocol=orbit.remote.v1")).toThrow(/加密密钥/)
    expect(() => parsePairingUri("orbit://pair?host=127.0.0.1&port=0&token=short&protocol=old")).toThrow()
  })

  test("matches a project to its connection without trusting one spelling", () => {
    const connections = [{ id: "/tmp/demo", cwd: "/private/tmp/demo" }, { id: "/work/demo#2", cwd: "/work/demo" }]
    // The phone's spelling, the desktop's canonical directory, and an exact
    // connection id all reach the connection that serves the project.
    expect(findRemoteConnection(connections, "/tmp/demo")).toEqual(connections[0])
    expect(findRemoteConnection(connections, "/private/tmp/demo")).toEqual(connections[0])
    expect(findRemoteConnection(connections, "/work/demo#2")).toEqual(connections[1])
    expect(findRemoteConnection(connections, "/work/demo")).toEqual(connections[1])
    expect(findRemoteConnection(connections, "/work/demo/")).toEqual(connections[1])
    expect(findRemoteConnection(connections, "/work/other")).toBeUndefined()
    // An empty project is not the root directory, and `/` is a real path.
    expect(findRemoteConnection(connections, "")).toBeUndefined()
    expect(findRemoteConnection([{ id: "/", cwd: "/" }], "")).toBeUndefined()
    expect(findRemoteConnection([{ id: "/", cwd: "/" }], "/")).toEqual({ id: "/", cwd: "/" })
    expect(sameRemotePath("/work/demo/", "/work/demo")).toBe(true)
    expect(sameRemotePath("", "/")).toBe(false)
    expect(sameRemotePath("/work/a", "/work/b")).toBe(false)
  })

  test("validates typed host operations", () => {
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "session.list", cwd: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "project.add", path: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "project.forget", path: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "project.open", path: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "project.open", path: "" } })).toBe(false)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "connection.resolve", path: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "connection.resolve", path: "" } })).toBe(false)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "project.add", path: "" } })).toBe(false)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "arbitrary.command", cwd: "/workspace/demo" } })).toBe(false)
  })

  test("accepts the slices of an event too large for one frame", () => {
    expect(isRemoteEvent({ type: "pi.event.chunk", project: "/workspace/demo", id: 1, index: 0, total: 2, data: '{"type":"response"' })).toBe(true)
    // A slice that claims to be outside its own run would build a payload with a
    // hole in it, so it is not a slice at all.
    expect(isRemoteEvent({ type: "pi.event.chunk", project: "/workspace/demo", id: 1, index: 2, total: 2, data: "{}" })).toBe(false)
    expect(isRemoteEvent({ type: "pi.event.chunk", project: "/workspace/demo", id: 1, index: 0, total: 0, data: "{}" })).toBe(false)
    expect(isRemoteEvent({ type: "pi.event.chunk", project: "/workspace/demo", id: 1, index: 0, total: 2, data: 3 })).toBe(false)
    expect(isRemoteEvent({ type: "pi.event.chunk", project: "", id: 1, index: 0, total: 2, data: "{}" })).toBe(false)
  })

  test("routes a desktop command with the arguments its own UI sends", () => {
    expect(isRemoteRequest({ type: "host.invoke", command: "list_dir", args: { path: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.invoke", command: "git_changed_files" })).toBe(true)
    expect(isRemoteRequest({ type: "host.invoke", command: "" })).toBe(false)
    expect(isRemoteRequest({ type: "host.invoke" })).toBe(false)
    // Parameters, not a payload of arbitrary shape: an argument list that is
    // not an object is a client bug that should be caught here.
    expect(isRemoteRequest({ type: "host.invoke", command: "list_dir", args: "/tmp" })).toBe(false)
  })

  test("carries the project registry and the answerable commands", () => {
    const snapshot = { protocol: REMOTE_PROTOCOL, serverTime: 1, connections: [], projects: [{ path: "/work/app", name: "app", roots: ["/work/api"] }], commands: ["list_dir"] }
    expect(isRemoteHostSnapshot(snapshot)).toBe(true)
    expect(isRemoteHostSnapshot({ ...snapshot, projects: [{ path: "/work/app" }] })).toBe(false)
    expect(isRemoteHostSnapshot({ ...snapshot, commands: [1] })).toBe(false)
    // Both fields are additive: a Host that predates them still validates.
    expect(isRemoteHostSnapshot({ protocol: REMOTE_PROTOCOL, serverTime: 1, connections: [] })).toBe(true)
    expect(isRemoteEvent({ type: "host.projects", projects: [{ path: "/work/app", name: "app" }], serverTime: 2 })).toBe(true)
    expect(isRemoteEvent({ type: "host.projects", projects: "nope", serverTime: 2 })).toBe(false)
  })
})
