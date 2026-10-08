import { describe, expect, test } from "bun:test"
import { decodeRemoteMessage, encodeRemoteMessage, isRemoteEvent, isRemoteHostSnapshot, isRemoteRequest, parsePairingEndpoints, parsePairingUri, remoteWebSocketUrl, REMOTE_PROTOCOL } from "../src/lib/remote-protocol"

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

  test("validates typed host operations", () => {
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "session.list", cwd: "/workspace/demo" } })).toBe(true)
    expect(isRemoteRequest({ type: "host.operation", operation: { name: "arbitrary.command", cwd: "/workspace/demo" } })).toBe(false)
  })
})
