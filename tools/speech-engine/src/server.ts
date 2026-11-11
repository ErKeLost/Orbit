/**
 * Speech Engine 服务端：ElevenLabs 送来转写，Pi 给出回答，原样送回去。
 *
 * 这里没有任何我们自己的时序逻辑——不说话、不插入缓冲句、不判断该不该打断。
 * 断句、轮次、打断、识别、合成全在 ElevenLabs 那边；我们只做一次转发。
 *
 *   ELEVENLABS_API_KEY=sk_…  SPEECH_ENGINE_ID=seng_…  bun run start
 *
 * 除了 `/ws`，同一个端口还提供一个 `GET /health`：应用在开麦前会先问它一句。
 * 语音最难受的失败方式是"连上了但没人说话"，所以任何一处断了，扫描式地查一遍
 * 比看日志快：这个端点会告诉你服务在不在、跑的是哪个 engine、内存多大。
 */
import { createServer } from "node:http"
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import { PiVoice } from "./pi.ts"

const PORT = Number(process.env.PORT ?? 3001)
const WS_PATH = process.env.WS_PATH ?? "/ws"
const cwd = process.env.PI_CWD ?? process.cwd()
const startedAt = Date.now()
/** 带时间戳的行：事后想知道"那句话是几点几分说的"时，只有内容没用。 */
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts)

if (!process.env.ELEVENLABS_API_KEY) throw new Error("缺少 ELEVENLABS_API_KEY")
if (!process.env.SPEECH_ENGINE_ID) throw new Error("缺少 SPEECH_ENGINE_ID（seng_…）")

const agents = new Map<string, PiVoice>()
let calls = 0
/** 一段对麦说的话有多少个字符算正常：超过这条线基本就是背景音（电影、播客）了。 */
const MAX_UTTERANCE = Number(process.env.MAX_UTTERANCE_CHARS ?? 1200)

/** 空着的 Pi：只为省掉进程启动的几百毫秒，不影响说什么。 */
const spare: PiVoice[] = []
const keepOneReady = () => {
  if (!spare.length) spare.push(new PiVoice({ cwd }))
}
const take = () => {
  const pi = spare.pop()
  keepOneReady()
  return pi ?? new PiVoice({ cwd })
}
const release = (conversationId: string) => {
  agents.get(conversationId)?.dispose()
  agents.delete(conversationId)
}

const handlers = {
  onInit(conversationId: string) {
    release(conversationId)
    agents.set(conversationId, take())
    calls++
    log(`[call] ${conversationId} — ${agents.size} in flight`)
  },
  onTranscript(transcript: { role: string; content: string }[], signal: AbortSignal, session: { conversationId?: string; sendResponse: (value: AsyncIterable<string>) => unknown }) {
    const conversationId = session.conversationId ?? ""
    const pi = agents.get(conversationId)
    const latest = [...transcript].reverse().find(message => message.role === "user")?.content?.trim()
    // "..." means the recogniser heard silence, not a request. Answering it just makes
    // Pi invent work, so drop it and say nothing.
    if (!pi || !latest || !/[\p{L}\p{N}]/u.test(latest)) {
      if (latest) log(`[turn] ignored empty transcript ${JSON.stringify(latest)}`)
      return
    }
    // 房间里的外放（视频、播客）会被话筒当成用户在说话，于是整段独白被转写下来、
    // 当成一条请求扔给 Pi。对麦说话不会一口气说一千二百个字符——超过就当背景音，
    // 丢掉并留痕，而不是让 Pi 去执行一段电影台词。
    if (latest.length > MAX_UTTERANCE) {
      log(`[turn] ignored ${latest.length} chars of background audio: ${latest.slice(0, 60)}…`)
      return
    }
    log(`[turn] ${conversationId}: ${latest.slice(0, 80)}`)
    // The transcript is already Pi's conversation: Pi keeps its own history per call,
    // so only the newest utterance is forwarded.
    session.sendResponse(pi.prompt(latest, signal))
  },
  onClose(session: { conversationId?: string }) {
    const conversationId = session.conversationId ?? ""
    release(conversationId)
    log(`[call] ${conversationId} ended — ${agents.size} in flight`)
  },
  onDisconnect(session: { conversationId?: string }) {
    // The socket dropped without a `close` message; without this the Pi process and
    // its stream would outlive the call.
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

// attach() 自己接管 upgrade 与 JWT 校验，我们只负责那个普通的 HTTP 处理函数。
const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
client.speechEngine.attach(process.env.SPEECH_ENGINE_ID, server, WS_PATH, handlers as never)

server.listen(PORT, () => {
  console.log(`speech engine on :${PORT}${WS_PATH} — ${process.env.SPEECH_ENGINE_ID} (cwd ${cwd})`)
})

keepOneReady()

/**
 * 内存哨兵。上一次死法的记录：一个 bun 进程涨到 49 GB 被内核杀掉，机器同时被拖进
 * 4 GB 交换。进程自己退出，比让整台机器卡死、并且死得无声无息要好。
 *
 * 同时每 5 分钟写一行体检：下次再涨，日志里能看出涨的是不是某一段时间、哪几通电话。
 */
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
// The cheap check runs more often than the log line: a runaway allocation must be caught
// before it drags the whole machine into swap.
setInterval(() => {
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024)
  if (rssMb < LIMIT_MB) return
  console.error(`[watchdog] rss ${rssMb}MB over ${LIMIT_MB}MB — exiting so the supervisor can restart`)
  process.exit(1)
}, 30_000).unref()

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const pi of [...agents.values(), ...spare.splice(0)]) pi.dispose()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
