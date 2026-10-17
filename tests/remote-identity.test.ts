/**
 * The identity probe: what it refuses, and what it deliberately does not.
 *
 * The asymmetric rule is the whole design — a definitive "this is another host"
 * skips the route, while a timeout, a CORS refusal or a host too old to answer
 * with an id lets the socket try anyway. Getting that backwards would turn every
 * network hiccup into "无法连接 Orbit Host".
 */
import { afterEach, describe, expect, test } from "bun:test"
import { probeRemoteHostIdentity, remoteHostIdentityUrl, type RemoteHostIdentity } from "../src/lib/remote-identity"
import { REMOTE_PROTOCOL } from "../src/lib/remote-protocol"

const endpoint = {
  mode: "direct" as const,
  host: "192.168.1.20",
  port: 3777,
  token: "t".repeat(24),
  encryptionKey: "k".repeat(43),
  hostId: "host-12345678",
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(handler: (url: string) => Promise<Response> | Response): string[] {
  const calls: string[] = []
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return Promise.resolve(handler(url))
  }) as typeof fetch
  return calls
}

const identity = (overrides: Partial<RemoteHostIdentity> = {}): RemoteHostIdentity => ({
  service: "Orbit Host",
  protocol: REMOTE_PROTOCOL,
  hostId: "host-12345678",
  machineName: "MacBook",
  ...overrides,
})

describe("host identity probe", () => {
  test("asks the same port the socket would use", () => {
    expect(remoteHostIdentityUrl(endpoint)).toBe("http://192.168.1.20:3777/")
    expect(remoteHostIdentityUrl({ ...endpoint, host: "fd7a:115c:a1e0::1" })).toBe("http://[fd7a:115c:a1e0::1]:3777/")
    expect(remoteHostIdentityUrl({ ...endpoint, secure: true })).toBe("https://192.168.1.20:3777/")
  })

  test("a matching host id is accepted", async () => {
    stubFetch(() => Response.json(identity()))
    await expect(probeRemoteHostIdentity(endpoint)).resolves.toBeUndefined()
  })

  test("another host at the same address is refused, not merely noted", async () => {
    stubFetch(() => Response.json(identity({ hostId: "host-99999999" })))
    await expect(probeRemoteHostIdentity(endpoint)).rejects.toThrow("另一台 Orbit Host")
  })

  test("a host speaking another protocol is refused with both versions named", async () => {
    stubFetch(() => Response.json(identity({ protocol: "orbit.remote.v0" })))
    await expect(probeRemoteHostIdentity(endpoint)).rejects.toThrow("orbit.remote.v0")
  })

  test("a host too old to report its id is tried anyway", async () => {
    stubFetch(() => Response.json({ service: "Orbit Host", protocol: REMOTE_PROTOCOL, running: true }))
    await expect(probeRemoteHostIdentity(endpoint)).resolves.toBeUndefined()
  })

  test("a timeout is not a refusal: the socket gets to decide", async () => {
    globalThis.fetch = (() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch
    await expect(probeRemoteHostIdentity(endpoint)).resolves.toBeUndefined()
  })

  test("something else on that port is not evidence of a different host", async () => {
    // A refused request is a browser decision (mixed content, CORS) and a plain
    // page is a proxy; neither proves which machine this is.
    stubFetch(() => new Response("<html>hello</html>", { status: 200 }))
    await expect(probeRemoteHostIdentity(endpoint)).resolves.toBeUndefined()
    stubFetch(() => new Response("nope", { status: 403 }))
    await expect(probeRemoteHostIdentity(endpoint)).resolves.toBeUndefined()
  })
})
