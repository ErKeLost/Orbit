/**
 * Speech Engine 服务端：ElevenLabs 送来转写，Pi 给出回答，原样送回去。
 *
 * 这里没有任何我们自己的时序逻辑——不说话、不插入缓冲句、不判断该不该打断。
 * 断句、轮次、打断、识别、合成全在 ElevenLabs 那边；我们只做一次转发。
 *
 *   ELEVENLABS_API_KEY=sk_…  SPEECH_ENGINE_ID=seng_…  bun run start
 */
import { SpeechEngine } from "@elevenlabs/elevenlabs-js"
import { PiVoice } from "./pi.ts"

const cwd = process.env.PI_CWD ?? process.cwd()

if (!process.env.ELEVENLABS_API_KEY) throw new Error("缺少 ELEVENLABS_API_KEY")
if (!process.env.SPEECH_ENGINE_ID) throw new Error("缺少 SPEECH_ENGINE_ID（seng_…）")

const agents = new Map<string, PiVoice>()

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

const server = new SpeechEngine.Server({
  port: 3001,
  engineId: process.env.SPEECH_ENGINE_ID,
  onInit(conversationId) {
    agents.get(conversationId)?.dispose()
    agents.set(conversationId, take())
    console.log(`[call] ${conversationId}`)
  },
  onTranscript(transcript, signal, session) {
    const conversationId = (session as { conversationId?: string }).conversationId ?? ""
    const pi = agents.get(conversationId)
    const latest = [...transcript].reverse().find(message => message.role === "user")?.content?.trim()
    // "..." means the recogniser heard silence, not a request. Answering it just makes
    // Pi invent work, so drop it and say nothing.
    if (!pi || !latest || !/[\p{L}\p{N}]/u.test(latest)) {
      if (latest) console.log(`[turn] ignored empty transcript ${JSON.stringify(latest)}`)
      return
    }
    console.log(`[turn] ${conversationId}: ${latest.slice(0, 80)}`)
    // The transcript is already Pi's conversation: Pi keeps its own history per call,
    // so only the newest utterance is forwarded.
    session.sendResponse(pi.prompt(latest, signal))
  },
  onClose(session) {
    const conversationId = (session as { conversationId?: string }).conversationId ?? ""
    agents.get(conversationId)?.dispose()
    agents.delete(conversationId)
    console.log(`[call] ${conversationId} ended`)
  },
  onError(error) {
    console.error("[engine]", error)
  },
})

keepOneReady()
server.start()
console.log(`speech engine on :3001/ws — ${process.env.SPEECH_ENGINE_ID}`)

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const pi of [...agents.values(), ...spare.splice(0)]) pi.dispose()
    void server.stop().finally(() => process.exit(0))
  })
}
