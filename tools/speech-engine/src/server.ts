/**
 * Speech Engine server: ElevenLabs sends transcripts, Pi answers, the text is spoken.
 *
 * ElevenLabs owns capture, turn-taking, interruption and synthesis. Jev decides
 * whether the utterance needs the working agent. Otherwise a no-tools Pi answers
 * in the user's language. No phrase list.
 *
 *   ELEVENLABS_API_KEY=sk_…  SPEECH_ENGINE_ID=seng_…  bun run start
 */
import { createServer } from "node:http"
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import { routeUtterance } from "./gate.ts"
import { MOUTH_RULES, PiVoice } from "./pi.ts"
import { dropReason, latestUserText, previousAgentText } from "./utterance.ts"

const PORT = Number(process.env.PORT ?? 3001)
const WS_PATH = process.env.WS_PATH ?? "/ws"
const cwd = process.env.PI_CWD ?? process.cwd()
const startedAt = Date.now()
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts)

if (!process.env.ELEVENLABS_API_KEY) throw new Error("缺少 ELEVENLABS_API_KEY")
if (!process.env.SPEECH_ENGINE_ID) throw new Error("缺少 SPEECH_ENGINE_ID（seng_…）")

const agents = new Map<string, PiVoice>()
const boots = new Map<string, number>()
let calls = 0

const spare: PiVoice[] = []
const mouths: PiVoice[] = []
let warming: Promise<void> | null = null
let warmingMouth: Promise<void> | null = null

async function makeReady(options: ConstructorParameters<typeof PiVoice>[0]) {
  const pi = new PiVoice(options)
  try {
    await pi.ready()
    return pi
  } catch (error) {
    pi.dispose()
    throw error
  }
}

function keepOneReady() {
  if (spare.length || warming) return
  warming = makeReady({ cwd })
    .then(pi => {
      spare.push(pi)
    })
    .catch(error => log("[warm] pi not ready", error instanceof Error ? error.message : error))
    .finally(() => {
      warming = null
    })
}

function keepMouthReady() {
  if (mouths.length || warmingMouth) return
  warmingMouth = makeReady({ cwd, tools: false, filler: false, systemPrompt: MOUTH_RULES })
    .then(pi => {
      mouths.push(pi)
    })
    .catch(error => log("[warm] mouth not ready", error instanceof Error ? error.message : error))
    .finally(() => {
      warmingMouth = null
    })
}

async function take() {
  const ready = spare.pop()
  keepOneReady()
  return ready ?? makeReady({ cwd })
}

async function takeMouth() {
  const ready = mouths.pop()
  keepMouthReady()
  return ready ?? makeReady({ cwd, tools: false, filler: false, systemPrompt: MOUTH_RULES })
}

function release(conversationId: string) {
  boots.set(conversationId, (boots.get(conversationId) ?? 0) + 1)
  agents.get(conversationId)?.dispose()
  agents.delete(conversationId)
}

async function waitForPi(conversationId: string, signal: AbortSignal) {
  const boot = boots.get(conversationId)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !signal.aborted) {
    const pi = agents.get(conversationId)
    if (pi) return pi
    if (boots.get(conversationId) !== boot) return undefined
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  return agents.get(conversationId)
}

async function* speak(conversationId: string, text: string, signal: AbortSignal): AsyncGenerator<string> {
  const pi = await waitForPi(conversationId, signal)
  if (signal.aborted) return
  if (!pi) {
    log("[call] agent process is not ready")
    return
  }
  yield* pi.prompt(text, signal)
}

function spokenRequest(said: string, heard: string) {
  return heard ? `context:\n${heard}\n---\n${said}` : said
}

async function* reply(said: string, heard: string, signal: AbortSignal): AsyncGenerator<string> {
  let mouth: PiVoice
  try {
    mouth = await takeMouth()
  } catch (error) {
    log("[mouth] not ready", error instanceof Error ? error.message : error)
    return
  }
  try {
    yield* mouth.prompt(spokenRequest(said, heard), signal)
  } finally {
    if (signal.aborted) mouth.dispose()
    else mouths.push(mouth)
    keepMouthReady()
  }
}

async function* answer(conversationId: string, said: string, heard: string, signal: AbortSignal): AsyncGenerator<string> {
  const turn = await routeUtterance(said, heard, signal)
  if (signal.aborted || turn.kind === "drop") return
  if (turn.kind === "speak") {
    log(`[gate] ${conversationId} speak`)
    yield* reply(turn.text, heard, signal)
    return
  }
  log(`[gate] ${conversationId} agent: ${said.slice(0, 80)}`)
  yield* speak(conversationId, turn.text, signal)
}

const handlers = {
  onInit(conversationId: string) {
    release(conversationId)
    const boot = (boots.get(conversationId) ?? 0) + 1
    boots.set(conversationId, boot)
    void take()
      .then(pi => {
        if (boots.get(conversationId) !== boot) {
          pi.dispose()
          return
        }
        agents.set(conversationId, pi)
        calls++
        log(`[call] ${conversationId} — ${agents.size} in flight`)
      })
      .catch(error => log("[call] pi failed", error instanceof Error ? error.message : error))
  },
  onTranscript(transcript: { role: string; content: string }[], signal: AbortSignal, session: { conversationId?: string; sendResponse: (value: AsyncIterable<string>) => unknown }) {
    const conversationId = session.conversationId ?? ""
    const latest = latestUserText(transcript)
    const dropped = dropReason(latest)
    if (dropped === "empty") {
      if (latest) log(`[turn] ignored empty transcript ${JSON.stringify(latest)}`)
      return
    }
    if (dropped === "background") {
      log(`[turn] ignored ${latest.length} chars of background audio: ${latest.slice(0, 60)}…`)
      return
    }
    log(`[turn] ${conversationId}: ${latest.slice(0, 80)}`)
    session.sendResponse(answer(conversationId, latest, previousAgentText(transcript), signal))
  },
  onClose(session: { conversationId?: string }) {
    const conversationId = session.conversationId ?? ""
    release(conversationId)
    log(`[call] ${conversationId} ended — ${agents.size} in flight`)
  },
  onDisconnect(session: { conversationId?: string }) {
    release(session.conversationId ?? "")
  },
  onError(error: Error, session?: { conversationId?: string }) {
    console.error("[engine]", session?.conversationId ?? "", error.message)
  },
}

const server = createServer((request, response) => {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("cache-control", "no-store")
  if (request.url?.split("?")[0] !== "/health") {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found")
    return
  }
  const body = JSON.stringify({
    ok: true,
    engineId: process.env.SPEECH_ENGINE_ID,
    cwd,
    calls,
    inFlight: agents.size,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  })
  response.writeHead(200, { "content-type": "application/json" }).end(body)
})

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
client.speechEngine.attach(process.env.SPEECH_ENGINE_ID, server, WS_PATH, handlers as never)

server.listen(PORT, () => {
  console.log(`speech engine on :${PORT}${WS_PATH} — ${process.env.SPEECH_ENGINE_ID} (cwd ${cwd})`)
})

keepOneReady()
keepMouthReady()

const LIMIT_MB = Number(process.env.MEMORY_LIMIT_MB ?? 4096)
setInterval(() => {
  const usage = process.memoryUsage()
  const rssMb = Math.round(usage.rss / 1024 / 1024)
  const heapMb = Math.round(usage.heapUsed / 1024 / 1024)
  log(`[stats] rss ${rssMb}MB heap ${heapMb}MB — calls ${calls}, in flight ${agents.size}, spares ${spare.length}`)
  if (rssMb < LIMIT_MB) return
  console.error(`[watchdog] rss ${rssMb}MB over ${LIMIT_MB}MB — exiting so the supervisor can restart`)
  process.exit(1)
}, 300_000)
setInterval(() => {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024)
  if (rssMb < LIMIT_MB) return
  console.error(`[watchdog] rss ${rssMb}MB over ${LIMIT_MB}MB — exiting so the supervisor can restart`)
  process.exit(1)
}, 30_000).unref()

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const pi of [...agents.values(), ...spare.splice(0), ...mouths.splice(0)]) pi.dispose()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
