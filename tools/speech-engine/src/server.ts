/**
 * Speech Engine pipe. ElevenLabs sends transcripts. The desktop decides the
 * words. This process does not spawn Pi.
 *
 *   ELEVENLABS_API_KEY=sk_…  SPEECH_ENGINE_ID=seng_…  bun run start
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import { Desk, DESK_MISSING, announcementOf, withoutAnnouncements } from "./desk.ts"
import { dropReason, latestUserText, previousAgentText } from "./utterance.ts"

const PORT = Number(process.env.PORT ?? 3001)
const WS_PATH = process.env.WS_PATH ?? "/ws"
const startedAt = Date.now()
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts)

if (!process.env.ELEVENLABS_API_KEY) throw new Error("缺少 ELEVENLABS_API_KEY")
if (!process.env.SPEECH_ENGINE_ID) throw new Error("缺少 SPEECH_ENGINE_ID（seng_…）")

const desk = new Desk()
let calls = 0

function cors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
  response.setHeader("access-control-allow-headers", "content-type")
  response.setHeader("cache-control", "no-store")
}

function json(response: ServerResponse, status: number, body: unknown) {
  cors(response)
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(Buffer.from(chunk)))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

async function posted(request: IncomingMessage): Promise<{ id?: string; text?: string }> {
  const text = await readBody(request)
  if (!text.trim()) return {}
  try {
    const body = JSON.parse(text) as { id?: unknown; text?: unknown }
    return {
      id: typeof body.id === "string" ? body.id : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
    }
  } catch {
    return {}
  }
}

const handlers = {
  onInit(conversationId: string) {
    calls++
    log(`[call] ${conversationId}`)
  },
  onTranscript(transcript: { role: string; content: string }[], signal: AbortSignal, session: { conversationId?: string; sendResponse: (value: AsyncIterable<string> | string) => unknown }) {
    const visible = withoutAnnouncements(transcript)
    const latest = latestUserText(transcript)
    const announced = announcementOf(latest)
    if (announced) {
      log(`[announce] ${announced.slice(0, 80)}`)
      desk.spoke(announced)
      session.sendResponse(announced)
      return
    }
    const dropped = dropReason(latest)
    if (dropped === "empty") {
      if (latest) log(`[turn] ignored empty transcript ${JSON.stringify(latest)}`)
      return
    }
    if (dropped === "background") {
      log(`[turn] ignored ${latest.length} chars of background audio`)
      return
    }
    if (!desk.attached) {
      log("[turn] desk is not connected")
      session.sendResponse(DESK_MISSING)
      return
    }
    const heard = previousAgentText(visible)
    log(`[turn] ${session.conversationId ?? ""}: ${latest.slice(0, 80)}`)
    const { spoken } = desk.enqueue(latest, heard, signal)
    session.sendResponse(spoken)
  },
  onClose(session: { conversationId?: string }) {
    log(`[call] ${session.conversationId ?? ""} ended`)
  },
  onDisconnect(session: { conversationId?: string }) {
    log(`[call] ${session.conversationId ?? ""} dropped`)
  },
  onError(error: Error, session?: { conversationId?: string }) {
    console.error("[engine]", session?.conversationId ?? "", error.message)
  },
}

const server = createServer((request, response) => {
  const path = request.url?.split("?")[0] ?? "/"
  if (request.method === "OPTIONS") {
    cors(response)
    response.writeHead(204).end()
    return
  }
  if (path === "/health") {
    json(response, 200, {
      ok: true,
      engineId: process.env.SPEECH_ENGINE_ID,
      calls,
      desk: desk.attached,
      inFlight: 0,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    })
    return
  }
  if (path === "/desk/hello" && request.method === "POST") {
    desk.hello()
    json(response, 200, { ok: true })
    return
  }
  if (path === "/desk/next" && request.method === "GET") {
    const timeout = Number(new URL(request.url ?? "", "http://127.0.0.1").searchParams.get("timeout") ?? 20000)
    void desk.next(Math.min(20000, Math.max(1, timeout))).then(turn => {
      if (!turn) {
        cors(response)
        response.writeHead(204).end()
        return
      }
      json(response, 200, turn)
    })
    return
  }
  if (path === "/desk/chunk" && request.method === "POST") {
    void posted(request).then(body => {
      if (body.id && body.text) desk.chunk(body.id, body.text)
      json(response, 200, { ok: true })
    })
    return
  }
  if (path === "/desk/end" && request.method === "POST") {
    void posted(request).then(body => {
      if (body.id) desk.end(body.id)
      json(response, 200, { ok: true })
    })
    return
  }
  if (path === "/desk/spoken" && request.method === "GET") {
    void desk.waitSpoken(1600).then(text => {
      if (!text) {
        cors(response)
        response.writeHead(204).end()
        return
      }
      json(response, 200, { text })
    })
    return
  }
  response.writeHead(404, { "content-type": "text/plain" }).end("not found")
})

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
client.speechEngine.attach(process.env.SPEECH_ENGINE_ID, server, WS_PATH, handlers as never)

server.listen(PORT, () => {
  console.log(`speech engine on :${PORT}${WS_PATH} — ${process.env.SPEECH_ENGINE_ID} (desk, no pi)`)
})

const LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB ?? 4096)
setInterval(() => {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024)
  log(`[stats] rss ${rssMb}MB — calls ${calls}, desk ${desk.attached}`)
  if (rssMb < LIMIT_MB) return
  console.error(`[watchdog] rss ${rssMb}MB over ${LIMIT_MB}MB — exiting so the supervisor can restart`)
  process.exit(1)
}, 30_000).unref()

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
