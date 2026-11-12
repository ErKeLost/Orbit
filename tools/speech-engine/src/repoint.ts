/**
 * Point the Speech Engine at this machine's tunnel and apply the low-latency profile.
 *
 *   PUBLIC_URL=https://xxx.trycloudflare.com bun run src/repoint.ts
 *
 * A quick tunnel gets a new hostname every restart. Re-pointing the existing engine
 * keeps the `seng_…` id. The same call also sets scribe_realtime, flash TTS, eager
 * turn-taking and a one-hour cap. Eleven Realtime models cannot be used here.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { realtimeEngineConfig, wsUrlFrom } from "./engine-config.ts"

const apiKey = process.env.ELEVENLABS_API_KEY ?? keyFromPiAuth()
const publicUrl = process.env.PUBLIC_URL
if (!apiKey) throw new Error("缺少 ELEVENLABS_API_KEY（也可以在 ~/.pi/agent/auth.json 里配 elevenlabs）")
if (!publicUrl) throw new Error("缺少 PUBLIC_URL（例如 https://xxx.trycloudflare.com）")

const configPath = join(homedir(), ".pi", "agent", "eleven.json")
const wsUrl = wsUrlFrom(publicUrl)
const client = new ElevenLabsClient({ apiKey })
const name = process.env.ENGINE_NAME ?? "Orbit Pi"
const existing = process.env.SPEECH_ENGINE_ID || storedEngineId()
const current = existing ? await client.speechEngine.get(existing).catch(() => undefined) : undefined
const patch = realtimeEngineConfig(wsUrl, current)
const engine = existing
  ? await client.speechEngine.update(existing, patch)
  : await client.speechEngine.create({ name, ...patch })
const engineId = engine.speechEngineId || (engine as { engineId?: string }).engineId || existing

writeFileSync(configPath, `${JSON.stringify({ engineId, wsUrl, updatedAt: new Date().toISOString() }, null, 2)}\n`)
console.log(`engine: ${engineId}\nws_url: ${wsUrl}\n${existing ? "re-pointed" : "created"} → ${configPath}`)

function keyFromPiAuth(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))
    return auth?.elevenlabs?.key
  } catch {
    return undefined
  }
}

function storedEngineId(): string | undefined {
  try {
    return JSON.parse(readFileSync(configPath, "utf8"))?.engineId || undefined
  } catch {
    return undefined
  }
}
