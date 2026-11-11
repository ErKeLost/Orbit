/**
 * Point the Speech Engine at this machine's tunnel.
 *
 *   PUBLIC_URL=https://xxx.trycloudflare.com bun run src/repoint.ts
 *
 * A quick tunnel gets a new hostname every time it restarts, and the engine stores the
 * absolute `ws_url` — so a restart used to mean "create a new engine, paste a new
 * `seng_…`, fail a call first". Re-pointing the engine that already exists keeps the id
 * (and therefore the app's settings) untouched.
 *
 * Without `SPEECH_ENGINE_ID` (or an existing `~/.pi/agent/eleven.json`) this creates the
 * first engine and prints its id.
 */
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const apiKey = process.env.ELEVENLABS_API_KEY ?? keyFromPiAuth()
const publicUrl = process.env.PUBLIC_URL
if (!apiKey) throw new Error("缺少 ELEVENLABS_API_KEY（也可以在 ~/.pi/agent/auth.json 里配 elevenlabs）")
if (!publicUrl) throw new Error("缺少 PUBLIC_URL（例如 https://xxx.trycloudflare.com）")

const configPath = join(homedir(), ".pi", "agent", "eleven.json")
const wsUrl = `${publicUrl.replace(/^http/, "ws").replace(/\/$/, "")}${process.env.WS_PATH ?? "/ws"}`
const client = new ElevenLabsClient({ apiKey })
const name = process.env.ENGINE_NAME ?? "Orbit Pi"

const existing = process.env.SPEECH_ENGINE_ID || storedEngineId()
const engine = existing
  ? await client.speechEngine.update(existing, { speechEngine: { wsUrl, requestHeaders: {} } })
  : await client.speechEngine.create({ name, speechEngine: { wsUrl, requestHeaders: {} } })
const engineId = engine.engineId ?? existing

// The app reads this file: the id it dials, and the address the id currently points at.
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
