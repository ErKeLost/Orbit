/**
 * What kind of network address an endpoint points at.
 *
 * Ported from t3code `packages/shared/src/hostClassification.ts` (MIT,
 * Copyright 2026 T3 Tools Inc.), trimmed to the two questions Orbit asks: is
 * this route local, and which route should be tried first. The IPv4/IPv6
 * parsing is kept verbatim because the cases it handles are the ones a
 * hand-written check gets wrong — IPv4-mapped IPv6, `127.1`, a single trailing
 * dot, and the fact that Tailscale's IPv4 addresses live inside the shared
 * `100.64.0.0/10` range that Cloudflare WARP also uses.
 *
 * Why this matters for a phone: the same host is reachable over loopback, the
 * LAN, a tailnet, and the relay at once, and only one of them is fast. Ranking
 * them is how "the picture comes back over Wi-Fi instead of the relay" is
 * decided by fact rather than by which socket happened to open first.
 */

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/u, "")
}

function parseIpv4Address(host: string): readonly number[] | null {
  const parts = normalizeHostname(host).split(".").map(Number)
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null
}

function parseIpv4MappedIpv6Address(host: string): readonly number[] | null {
  const normalized = normalizeHostname(host)
  if (!normalized.startsWith("::ffff:")) return null
  const suffix = normalized.slice("::ffff:".length)
  const dotted = parseIpv4Address(suffix)
  if (dotted) return dotted
  const hextets = suffix.split(":")
  if (hextets.length !== 2 || hextets.some(part => !/^[\da-f]{1,4}$/u.test(part))) return null
  const high = Number.parseInt(hextets[0]!, 16)
  const low = Number.parseInt(hextets[1]!, 16)
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff]
}

function parseIpv6Address(host: string): readonly number[] | null {
  const normalized = normalizeHostname(host)
  if (!normalized.includes(":")) return null
  const halves = normalized.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves[1] ? halves[1].split(":") : []
  if ([...head, ...tail].some(part => !/^[\da-f]{1,4}$/u.test(part))) return null
  const missing = 8 - head.length - tail.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail].map(part => Number.parseInt(part, 16))
}

function ipv6PrefixMatches(address: readonly number[], prefix: readonly number[], prefixLength: number): boolean {
  const fullHextets = Math.floor(prefixLength / 16)
  if (address.slice(0, fullHextets).some((part, index) => part !== prefix[index])) return false
  const remainingBits = prefixLength % 16
  if (remainingBits === 0) return true
  const mask = (0xffff << (16 - remainingBits)) & 0xffff
  return (address[fullHextets]! & mask) === (prefix[fullHextets]! & mask)
}

function isPrivateIpv4Address(parts: readonly number[]): boolean {
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 198 && parts[1]! >= 18 && parts[1]! <= 19)
  )
}

export function isLocalLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host)
  if (normalized === "localhost" || normalized === "::1") return true
  return parseIpv4Address(normalized)?.[0] === 127
}

/**
 * A name or address only Tailscale uses: a MagicDNS name, or its IPv6 range
 * `fd7a:115c:a1e0::/48`. Its IPv4 addresses come from the shared
 * `100.64.0.0/10` range, so on their own they prove nothing.
 */
export function isTailnetHost(host: string): boolean {
  const normalized = normalizeHostname(host)
  if (normalized.endsWith(".ts.net")) return true
  const ipv6 = parseIpv6Address(normalized)
  return ipv6 !== null && ipv6PrefixMatches(ipv6, [0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0], 48)
}

/** `100.64.0.0/10`: Tailscale, or another VPN that chose the same range. */
export function isSharedAddressSpaceHost(host: string): boolean {
  const parts = parseIpv4Address(host)
  return parts !== null && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

export function isPrivateNetworkHost(host: string): boolean {
  const normalized = normalizeHostname(host)
  if (
    normalized === "::" ||
    isLocalLoopbackHost(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "home.arpa" ||
    normalized.endsWith(".home.arpa") ||
    (!normalized.includes(".") && !normalized.includes(":"))
  ) {
    return true
  }
  if (normalized.endsWith(".ts.net")) return true
  const parts = parseIpv4Address(normalized) ?? parseIpv4MappedIpv6Address(normalized)
  if (parts) return isPrivateIpv4Address(parts)
  const firstIpv6Token = normalized.split(":", 1)[0] ?? ""
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16)
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  )
}
