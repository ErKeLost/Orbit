/**
 * Which route a phone should use, and how long it should wait between tries.
 *
 * Both are pure functions on purpose: the decisions that make a remote session
 * feel fast (LAN before relay) or slow (every client returning in the same
 * millisecond) are made here, not inside a WebSocket handler, so they can be
 * checked without a phone, a host, or a network.
 */
import { describe, expect, test } from "bun:test"
import { remoteReconnectDelay } from "../src/lib/remote-client"
import { parsePairingEndpoints, type RemoteEndpoint } from "../src/lib/remote-protocol"
import { isBetterRoute, rankRemoteEndpoints, remoteRouteKind, remoteRouteKey } from "../src/lib/remote-route"

const direct = (host: string, port = 3777): RemoteEndpoint => ({
  mode: "direct",
  host,
  port,
  token: "t".repeat(24),
  encryptionKey: "k".repeat(43),
  hostId: "host-12345678",
})

const relay: RemoteEndpoint = {
  mode: "relay",
  relayUrl: "wss://relay.example.test/",
  hostId: "host-12345678",
  token: "t".repeat(24),
  encryptionKey: "k".repeat(43),
}

describe("route classification", () => {
  test("a private address is a LAN route, not a public one", () => {
    expect(remoteRouteKind(direct("192.168.1.20"))).toBe("lan")
    expect(remoteRouteKind(direct("10.0.0.5"))).toBe("lan")
    expect(remoteRouteKind(direct("172.16.4.4"))).toBe("lan")
    // A single-label host is a machine on the local network, not the internet.
    expect(remoteRouteKind(direct("desktop.local"))).toBe("lan")
  })

  test("loopback is its own, best kind", () => {
    expect(remoteRouteKind(direct("127.0.0.1"))).toBe("loopback")
    expect(remoteRouteKind(direct("localhost"))).toBe("loopback")
  })

  test("a tailnet name and Tailscale's IPv6 range are tailnet routes", () => {
    expect(remoteRouteKind(direct("macbook.tailnet-abc.ts.net"))).toBe("tailnet")
    expect(remoteRouteKind(direct("fd7a:115c:a1e0::1"))).toBe("tailnet")
  })

  test("100.64/10 without a tailnet name stays a VPN route", () => {
    // Tailscale's IPv4 addresses live in the same range Cloudflare WARP uses, so
    // an address alone proves nothing. The rank is the same either way; only the
    // label differs, and the label is what a report shows.
    expect(remoteRouteKind(direct("100.101.102.103"))).toBe("vpn")
  })

  test("a public address and the relay are the fallbacks", () => {
    expect(remoteRouteKind(direct("orbit.example.com"))).toBe("public")
    expect(remoteRouteKind(direct("203.0.113.9"))).toBe("public")
    expect(remoteRouteKind(relay)).toBe("relay")
  })
})

describe("route ranking", () => {
  test("the fastest route comes first and the relay comes last", () => {
    const ranked = rankRemoteEndpoints([relay, direct("203.0.113.9"), direct("192.168.1.20"), direct("127.0.0.1")])
    expect(ranked.map(remoteRouteKind)).toEqual(["loopback", "lan", "public", "relay"])
  })

  test("equal routes keep the order the pairing URI listed them in", () => {
    // Two LAN addresses rank the same; the host's own order is the only
    // information left about which one it preferred.
    const ranked = rankRemoteEndpoints([direct("192.168.1.50"), direct("10.0.0.2")])
    expect(ranked.map(endpoint => (endpoint.mode === "direct" ? endpoint.host : ""))).toEqual(["192.168.1.50", "10.0.0.2"])
  })

  test("the same address listed twice is one route", () => {
    const ranked = rankRemoteEndpoints([direct("192.168.1.20"), direct("192.168.1.20"), relay, relay])
    expect(ranked).toHaveLength(2)
    expect(remoteRouteKey(ranked[0]!)).not.toBe(remoteRouteKey(ranked[1]!))
  })

  test("a pairing URI keeps both routes, best first", () => {
    const uri = `orbit://pair?host=192.168.1.20&port=3777&relay=${encodeURIComponent("wss://relay.example.test/")}&hostId=host-12345678&token=${"t".repeat(24)}&key=${"k".repeat(43)}&protocol=orbit.remote.v1`
    const ranked = rankRemoteEndpoints(parsePairingEndpoints(uri))
    expect(ranked.map(remoteRouteKind)).toEqual(["lan", "relay"])
  })
})

describe("route preference", () => {
  test("better means strictly better, so a tie is not an upgrade", () => {
    expect(isBetterRoute(direct("192.168.1.20"), relay)).toBe(true)
    expect(isBetterRoute(relay, direct("192.168.1.20"))).toBe(false)
    expect(isBetterRoute(direct("10.0.0.2"), direct("192.168.1.20"))).toBe(false)
  })
})

describe("reconnect delay", () => {
  test("grows exponentially, is capped, and is never zero", () => {
    // `random` is injected so the bounds are the thing under test, not the dice.
    for (const attempt of [0, 1, 2, 3, 6, 20]) {
      const low = remoteReconnectDelay(attempt, 500, 15_000, () => 0)
      const high = remoteReconnectDelay(attempt, 500, 15_000, () => 1)
      expect(low).toBeGreaterThanOrEqual(250)
      expect(low).toBeLessThanOrEqual(high)
      expect(high).toBeLessThanOrEqual(15_000)
    }
  })

  test("the cap holds even after many attempts", () => {
    expect(remoteReconnectDelay(64, 500, 15_000, () => 1)).toBe(15_000)
  })

  test("two clients that failed at the same moment do not come back together", () => {
    // Without jitter both computed the same delay, so a host that restarted got
    // every client back in the same millisecond.
    const first = remoteReconnectDelay(3, 500, 15_000, () => 0.1)
    const second = remoteReconnectDelay(3, 500, 15_000, () => 0.9)
    expect(first).not.toBe(second)
    expect(second).toBeGreaterThan(first)
  })
})
