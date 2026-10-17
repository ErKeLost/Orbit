/**
 * Which of a host's addresses to try, and in what order.
 *
 * A pairing URI can carry several endpoints for the same machine: the LAN
 * address, the relay, and whatever a previous session learned. They are not
 * interchangeable — the LAN route is a few milliseconds and costs the relay
 * nothing, the relay route crosses the internet — so "whichever socket opened
 * first" is the wrong rule for anything long-lived.
 *
 * The ranking mirrors t3code's route model (MIT): loopback, LAN, tailnet/VPN,
 * public, then relay. It is a *preference*, not a filter: a worse-ranked route
 * is still tried when the better ones do not answer, which is what keeps a
 * phone working when it leaves the house.
 */
import { isLocalLoopbackHost, isPrivateNetworkHost, isSharedAddressSpaceHost, isTailnetHost } from "./host-classification"
import type { RemoteEndpoint } from "./remote-protocol"

export type RemoteRouteKind = "loopback" | "lan" | "tailnet" | "vpn" | "public" | "relay"

const RANK: Record<RemoteRouteKind, number> = {
  loopback: 0,
  lan: 1,
  tailnet: 2,
  vpn: 2,
  public: 3,
  relay: 5,
}

export function remoteRouteKind(endpoint: RemoteEndpoint): RemoteRouteKind {
  if (endpoint.mode === "relay") return "relay"
  if (isLocalLoopbackHost(endpoint.host)) return "loopback"
  if (isTailnetHost(endpoint.host)) return "tailnet"
  // `100.64.0.0/10` is shared by Tailscale and by VPNs that picked the same
  // range; without DNS proving it is Tailscale, it stays a VPN route. The rank
  // is the same, which is the only thing this file decides.
  if (isSharedAddressSpaceHost(endpoint.host)) return "vpn"
  return isPrivateNetworkHost(endpoint.host) ? "lan" : "public"
}

function remoteRouteRank(endpoint: RemoteEndpoint): number {
  return RANK[remoteRouteKind(endpoint)]
}

/** A stable identity for one route, so the same address is not raced twice. */
export function remoteRouteKey(endpoint: RemoteEndpoint): string {
  return endpoint.mode === "relay"
    ? `relay:${endpoint.relayUrl}:${endpoint.hostId}`
    : `direct:${endpoint.secure ? "wss" : "ws"}://${endpoint.host}:${endpoint.port}`
}

/**
 * Best route first, everything else in its original order.
 *
 * Stable on purpose: two LAN addresses rank the same, and the order the pairing
 * URI listed them in is the only information left about which one the host
 * itself preferred.
 */
export function rankRemoteEndpoints(endpoints: RemoteEndpoint[]): RemoteEndpoint[] {
  const seen = new Set<string>()
  const unique = endpoints.filter(endpoint => {
    const key = remoteRouteKey(endpoint)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique
    .map((endpoint, index) => ({ endpoint, index, rank: remoteRouteRank(endpoint) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(entry => entry.endpoint)
}

/** Whether `candidate` is a strictly better route than `current`. */
export function isBetterRoute(candidate: RemoteEndpoint, current: RemoteEndpoint): boolean {
  return remoteRouteRank(candidate) < remoteRouteRank(current)
}
