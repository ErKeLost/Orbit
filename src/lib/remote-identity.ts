/**
 * Is this address really my desktop?
 *
 * A pairing URI is stored on the phone and keeps working across Wi-Fi networks.
 * The address in it does not: `192.168.1.20` at home is some other machine at a
 * café, and the phone's first move is to open a WebSocket to whatever now holds
 * that address. Orbit's token never travels in the clear — it sits inside the
 * first encrypted frame — so a stranger gets ciphertext, not a credential. But
 * the run still pays a full connect timeout, and when it finally fails the
 * report says "无法连接 Orbit Host", which is the same message a switched-off
 * desktop produces.
 *
 * The host already answers one unauthenticated question on the same port (`curl
 * host:port` is how a person checks whether it is listening). Asking it for its
 * identity only lets the phone *skip* a route, so the rule is asymmetric on
 * purpose: a definitive mismatch refuses, and everything else — a timeout, a
 * CORS refusal, a host too old to answer with an id — is "unverified" and the
 * socket is tried anyway. A verification step that can break a working
 * connection would be worse than no verification at all.
 */

import type { DirectRemoteEndpoint } from "./remote-protocol"
import { REMOTE_PROTOCOL } from "./remote-protocol"

/** What the host prints about itself, without a token. */
export type RemoteHostIdentity = {
  service?: string
  protocol?: string
  hostId?: string
  machineName?: string
}

/**
 * Short by design: this is a route filter, not a health check. A host that
 * cannot answer in a second and a half is either gone or not worth waiting for,
 * and the WebSocket attempt behind this is still allowed to succeed.
 */
const PROBE_TIMEOUT_MS = 1_500

export function remoteHostIdentityUrl(endpoint: DirectRemoteEndpoint): string {
  const scheme = endpoint.secure ? "https" : "http"
  const host = endpoint.host.includes(":") && !endpoint.host.startsWith("[") ? `[${endpoint.host}]` : endpoint.host
  return `${scheme}://${host}:${endpoint.port}/`
}

/**
 * Ask the endpoint who it is, and refuse only on a definitive answer.
 *
 * Resolves when the route may be tried — including when the host could not be
 * verified at all — and rejects only when something answered and said it is not
 * this Host (another host id, or another protocol version).
 */
export async function probeRemoteHostIdentity(endpoint: DirectRemoteEndpoint): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(remoteHostIdentityUrl(endpoint), {
      signal: controller.signal,
      // A cached "yes" is exactly the case this exists to catch.
      cache: "no-store",
      headers: { accept: "application/json" },
    })
  } catch {
    // Timeout, no route, or a browser refusing the request (a mixed-content or
    // CORS decision, which says nothing about the host). Let the socket decide.
    return
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) return
  let identity: RemoteHostIdentity
  try {
    identity = (await response.json()) as RemoteHostIdentity
  } catch {
    // Something answered on this port and it is not our JSON. That is not proof
    // of a different *Orbit* host — it may be a proxy page — so the socket still
    // gets its turn.
    return
  }
  if (typeof identity.service !== "string" || !identity.service.includes("Orbit")) return
  if (typeof identity.protocol === "string" && identity.protocol !== REMOTE_PROTOCOL) {
    throw new Error(`这个 Orbit Host 的协议是 ${identity.protocol}，手机需要 ${REMOTE_PROTOCOL}`)
  }
  if (endpoint.hostId && identity.hostId && identity.hostId !== endpoint.hostId) {
    throw new Error("这个地址上是另一台 Orbit Host")
  }
  // An older host answers without `hostId`: unverifiable, but not a mismatch.
}
