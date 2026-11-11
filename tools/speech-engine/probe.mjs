// Smoke test for the speech-engine chain: forged Speech Engine JWT in, transcript out,
// `agent_response` back. See docs/VOICE_ARCHITECTURE.md.
import { createHash, createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import WS from "ws"

const key = JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/auth.json", "utf8")).elevenlabs.key
const secret = createHash("sha256").update(key.trim()).digest()
const b64 = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const now = Math.floor(Date.now() / 1000)
const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))
const body = b64(JSON.stringify({ iss: "https://api.elevenlabs.io/convai/speech-engine", sub: "convai_speech_engine_upstream", iat: now, exp: now + 600 }))
const jwt = `${head}.${body}.${b64(createHmac("sha256", secret).update(`${head}.${body}`).digest())}`

// Default target: whatever ~/.pi/agent/eleven.json points at (i.e. the real path
// ElevenLabs takes). `ws://127.0.0.1:3001/ws` checks only the local half.
const stored = (() => {
  try {
    return JSON.parse(readFileSync(process.env.HOME + "/.pi/agent/eleven.json", "utf8")).wsUrl
  } catch {
    return undefined
  }
})()
const url = process.argv[2] ?? stored ?? "ws://127.0.0.1:3001/ws"
const say = process.argv[3] ?? "say only the word pong"
const label = process.argv[4] ?? url
const ws = new WS(url, { headers: { "X-Elevenlabs-Speech-Engine-Authorization": jwt } })
const seen = []
const done = why => {
  console.log(`${label} => ${why}`)
  if (seen.length) console.log("   ", seen.slice(-8).join(" | "))
  try { ws.terminate() } catch {}
  process.exit(0)
}
ws.on("open", () => {
  console.log(`${label}: opened (auth ok)`)
  ws.send(JSON.stringify({ type: "init", conversation_id: "probe-" + Date.now() }))
  setTimeout(() => ws.send(JSON.stringify({ type: "user_transcript", event_id: 1, user_transcript: [{ role: "user", content: say }] })), 300)
})
ws.on("message", raw => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }))
  if (msg.type === "agent_response") {
    seen.push(`agent:${JSON.stringify(msg.content)}${msg.is_final ? "(final)" : ""}`)
    if (msg.is_final) done("FULL ROUND OK")
    return
  }
  seen.push(msg.type)
})
ws.on("unexpected-response", (_q, res) => done(`HTTP ${res.statusCode}`))
ws.on("error", e => done(`ERROR ${e.message}`))
ws.on("close", (c, r) => done(`CLOSE ${c} ${r}`))
setTimeout(() => done("TIMEOUT 30s"), 30000)
