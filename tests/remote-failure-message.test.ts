/**
 * What a failed pairing attempt says.
 *
 * `Promise.any` rejects with an AggregateError whose own message is "All
 * promises were rejected" — a string that tells the user nothing about which
 * address was tried or why it refused. That literal text once reached the
 * pairing screen, so these tests pin the replacement: 每一条路线都要点名，
 * 而且要在手机那一行 10px 的字里读得下去。
 */
import { describe, expect, test } from "bun:test"
import { remoteFailureMessage } from "../src/lib/remote-runtime"
import type { RemoteEndpoint } from "../src/lib/remote-protocol"

const lan: RemoteEndpoint = {
  mode: "direct",
  host: "192.168.1.20",
  port: 3777,
  token: "t".repeat(24),
  encryptionKey: "k".repeat(43),
  hostId: "host-12345678",
}

const relay: RemoteEndpoint = {
  mode: "relay",
  relayUrl: "wss://orbit-pi.example.test/",
  hostId: "host-12345678",
  token: "t".repeat(24),
  encryptionKey: "k".repeat(43),
}

describe("pairing failure message", () => {
  test("never surfaces the aggregate error itself", () => {
    const message = remoteFailureMessage("连不上电脑", [lan, relay], new Map([[lan, "WebSocket 连接超时"], [relay, "认证握手超时"]]))
    expect(message).not.toContain("All promises were rejected")
  })

  test("names every route with its own reason, in try order", () => {
    const message = remoteFailureMessage("连不上电脑", [lan, relay], new Map([[lan, "WebSocket 连接超时"], [relay, "认证握手超时"]]))
    expect(message).toContain("局域网 192.168.1.20:3777（超时）")
    expect(message).toContain("中转 orbit-pi.example.test（握手失败）")
    expect(message.indexOf("局域网")).toBeLessThan(message.indexOf("中转"))
  })

  test("a relay in the failed set adds the host-side hint, split off by ` · `", () => {
    const [line, hint] = remoteFailureMessage("连不上电脑", [relay], new Map([[relay, "连接已关闭"]])).split(" · ")
    expect(hint).toContain("移动访问")
    // One route, one reason: the phone shows this rank on a clamped line, so a
    // second `；` or a second bracket here would be a build error, not a layout.
    expect(line).toBe("连不上电脑：中转 orbit-pi.example.test（连接被关闭）")
  })

  test("a LAN-only failure does not blame the relay", () => {
    const message = remoteFailureMessage("连不上电脑", [lan], new Map([[lan, "未响应"]]))
    expect(message).not.toContain("移动访问")
  })

  test("a socket that never opened is not called「连不上」twice", () => {
    const [line] = remoteFailureMessage("连不上电脑", [relay], new Map([[relay, "无法连接 Orbit Host"]])).split(" · ")
    expect(line).toBe("连不上电脑：中转 orbit-pi.example.test（没响应）")
  })

  test("a route with no recorded reason still gets named", () => {
    const message = remoteFailureMessage("连不上电脑", [lan], new Map())
    expect(message).toContain("局域网 192.168.1.20:3777（未响应）")
  })
})
