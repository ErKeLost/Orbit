/**
 * Create (or re-point) the Speech Engine resource that ElevenLabs calls.
 *
 *   PUBLIC_URL=https://xxx.trycloudflare.com bun run create-engine
 *
 * Speech Engine has no dashboard UI: the resource is the API object that stores the
 * WebSocket URL, so this must run once per tunnel URL, and again whenever the URL
 * changes. Prints the `seng_…` id to put in SPEECH_ENGINE_ID.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"

const apiKey = process.env.ELEVENLABS_API_KEY
const publicUrl = process.env.PUBLIC_URL
if (!apiKey) throw new Error("缺少 ELEVENLABS_API_KEY")
if (!publicUrl) throw new Error("缺少 PUBLIC_URL（例如 https://xxx.trycloudflare.com）")

const wsUrl = `${publicUrl.replace(/^http/, "ws").replace(/\/$/, "")}${process.env.WS_PATH ?? "/ws"}`
const client = new ElevenLabsClient({ apiKey })
const name = process.env.ENGINE_NAME ?? "Orbit Pi"

const engine = await client.speechEngine.create({
  name,
  speechEngine: { wsUrl },
})
console.log(`engine: ${engine.engineId}\nws_url: ${wsUrl}`)
