import { timingSafeEqual } from "node:crypto"

const port = Number(process.env.PORT || 8787)
const hostname = process.env.HOSTNAME_BIND || "127.0.0.1"
const tlsCertPath = process.env.ORBIT_RELAY_TLS_CERT || ""
const tlsKeyPath = process.env.ORBIT_RELAY_TLS_KEY || ""
const configuredHostKey = process.env.ORBIT_RELAY_HOST_KEY || ""
const maxClientsPerHost = Number(process.env.MAX_CLIENTS_PER_HOST || 8)
const maxHostsPerIp = Number(process.env.MAX_HOSTS_PER_IP || 4)
const maxAuthFailuresPerMinute = Number(process.env.MAX_AUTH_FAILURES_PER_MINUTE || 20)
const hosts = new Map()
const hostCountsByIp = new Map()
const authFailures = new Map()

if (!/^[A-Za-z0-9_-]{32,256}$/.test(configuredHostKey)) {
  throw new Error("ORBIT_RELAY_HOST_KEY must be a 32-256 character URL-safe secret")
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function clientIp(request, server) {
  // Only trust the header the reverse proxy (Caddy) sets authoritatively.
  // X-Forwarded-For and any client-supplied header are spoofable, so they are
  // deliberately ignored.
  return request.headers.get("x-real-ip")?.trim() || server.requestIP(request)?.address || "unknown"
}

function route(request, server) {
  const url = new URL(request.url)
  const match = url.pathname.match(/^\/relay\/(host|client)\/([A-Za-z0-9-]{8,80})$/)
  if (!match) return null
  return { role: match[1], hostId: match[2], ip: clientIp(request, server) }
}

function rateLimited(ip) {
  const now = Date.now()
  const recent = (authFailures.get(ip) || []).filter(timestamp => now - timestamp < 60_000)
  authFailures.set(ip, recent)
  return recent.length >= maxAuthFailuresPerMinute
}

function recordFailure(ip) {
  const recent = authFailures.get(ip) || []
  recent.push(Date.now())
  authFailures.set(ip, recent)
}

function log(message) {
  console.log(new Date().toISOString(), message)
}

function closeHost(hostId, host) {
  if (hosts.get(hostId) !== host) return
  hosts.delete(hostId)
  hostCountsByIp.set(host.ip, Math.max(0, (hostCountsByIp.get(host.ip) || 1) - 1))
  log(`host ${hostId} disconnected from ${host.ip}`)
  for (const client of host.clients.values()) client.close(1012, "Orbit Host disconnected")
  host.clients.clear()
}

const tls = tlsCertPath && tlsKeyPath ? { cert: Bun.file(tlsCertPath), key: Bun.file(tlsKeyPath) } : undefined

const server = Bun.serve({
  hostname,
  port,
  tls,
  maxRequestBodySize: 8_388_608,
  fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/health") return Response.json({ service: "orbit-relay", hosts: hosts.size, uptime: Math.floor(process.uptime()) })
    const data = route(request, server)
    if (!data) return new Response("Not found", { status: 404 })
    if (rateLimited(data.ip)) return new Response("Too many attempts", { status: 429 })
    if (data.role === "client") {
      // Token authentication happens on the first WebSocket frame, not in the
      // URL, so the token never lands in access logs. Only the cheap checks run
      // here.
      const host = hosts.get(data.hostId)
      if (!host) return new Response("Orbit Host unavailable", { status: 404 })
      if (host.clients.size >= maxClientsPerHost) return new Response("Too many clients", { status: 429 })
    } else if ((hostCountsByIp.get(data.ip) || 0) >= maxHostsPerIp && !hosts.has(data.hostId)) {
      return new Response("Too many hosts", { status: 429 })
    }
    return server.upgrade(request, { data: { ...data, authenticated: false } }) ? undefined : new Response("Upgrade required", { status: 426 })
  },
  websocket: {
    maxPayloadLength: 8_388_608,
    idleTimeout: 120,
    open(_socket) {
      // Both roles authenticate with their first message; nothing to attach yet.
    },
    message(socket, message) {
      const { role, hostId, ip } = socket.data
      if (!socket.data.authenticated) {
        let frame
        try { frame = JSON.parse(String(message)) } catch { frame = null }

        if (role === "host") {
          if (frame?.relay !== "register" || !safeEqual(String(frame.hostKey || ""), configuredHostKey) || !/^[A-Za-z0-9_-]{32,256}$/.test(String(frame.clientToken || ""))) {
            recordFailure(ip)
            log(`host registration DENIED for ${hostId} from ${ip}`)
            return socket.close(1008, "Invalid host credentials")
          }
          const previous = hosts.get(hostId)
          if (previous) {
            // Remove the old registration before installing the replacement. Its
            // close callback may run later and must not tear down the new host.
            closeHost(hostId, previous)
            previous.socket.close(1012, "Orbit Host replaced")
          }
          socket.data.authenticated = true
          const host = { socket, ip, clientToken: String(frame.clientToken), clients: new Map() }
          hosts.set(hostId, host)
          hostCountsByIp.set(ip, (hostCountsByIp.get(ip) || 0) + 1)
          log(`host ${hostId} registered from ${ip}`)
          socket.send(JSON.stringify({ relay: "registered" }))
          return
        }

        // client
        if (frame?.relay !== "auth" || typeof frame.token !== "string") {
          recordFailure(ip)
          return socket.close(1008, "Orbit Host unavailable")
        }
        const host = hosts.get(hostId)
        if (!host || !safeEqual(host.clientToken, frame.token)) {
          recordFailure(ip)
          log(`client rejected for ${hostId} from ${ip} (host ${host ? "token mismatch" : "not registered"})`)
          return socket.close(1008, "Orbit Host unavailable")
        }
        if (host.clients.size >= maxClientsPerHost) return socket.close(1008, "Too many clients")
        const clientId = crypto.randomUUID()
        socket.data.authenticated = true
        socket.data.clientId = clientId
        host.clients.set(clientId, socket)
        log(`client ${clientId} attached to ${hostId} from ${ip}`)
        host.socket.send(JSON.stringify({ relay: "connect", clientId }))
        return
      }

      const { clientId } = socket.data
      const host = hosts.get(hostId)
      if (!host || host.socket !== (role === "host" ? socket : host.socket)) return socket.close(1012, "Orbit Host unavailable")
      if (role === "client") {
        if (host.clients.get(clientId) !== socket) return socket.close(1008, "Invalid relay session")
        host.socket.send(JSON.stringify({ relay: "frame", clientId, data: String(message) }))
        return
      }
      let frame
      try { frame = JSON.parse(String(message)) } catch { return }
      if (frame?.relay !== "frame" || typeof frame.clientId !== "string" || typeof frame.data !== "string") return
      host.clients.get(frame.clientId)?.send(frame.data)
    },
    close(socket, code, reason) {
      const { role, hostId, clientId } = socket.data
      log(`socket closed role=${role} host=${hostId} client=${clientId || "-"} code=${code || "-"} reason=${reason || "-"}`)
      const host = hosts.get(hostId)
      if (!host) return
      if (role === "host") {
        // A replaced host closes asynchronously. Only the socket that still
        // owns this registration is allowed to remove it.
        if (host.socket !== socket) return
        return closeHost(hostId, host)
      }
      if (!clientId || host.clients.get(clientId) !== socket) return
      host.clients.delete(clientId)
      log(`client ${clientId} detached from ${hostId}`)
      host.socket.send(JSON.stringify({ relay: "disconnect", clientId }))
    },
  },
})

console.log(`Orbit Relay listening on ${hostname}:${server.port}${tls ? " (TLS)" : ""}`)
