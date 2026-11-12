/**
 * Create the Speech Engine resource. Prefer `repoint.ts` / `up.sh`: this does not
 * write `eleven.json`, and a second run creates another `seng_…`.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import { realtimeEngineConfig, wsUrlFrom } from "./engine-config.ts"

const apiKey = process.env.ELEVENLABS_API_KEY
const publicUrl = process.env.PUBLIC_URL
if (!apiKey) throw new Error("缺少 ELEVENLABS_API_KEY")
if (!publicUrl) throw new Error("缺少 PUBLIC_URL（例如 https://xxx.trycloudflare.com）")

const wsUrl = wsUrlFrom(publicUrl)
const client = new ElevenLabsClient({ apiKey })
const engine = await client.speechEngine.create({
  name: process.env.ENGINE_NAME ?? "Orbit Pi",
  ...realtimeEngineConfig(wsUrl),
})
const engineId = engine.speechEngineId || (engine as { engineId?: string }).engineId
console.log(`engine: ${engineId}\nws_url: ${wsUrl}`)
