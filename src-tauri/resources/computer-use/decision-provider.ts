import { readFileSync } from "node:fs"
import { TypeSafeClient } from "@typesafe-ai/sdk"

/** Decision backend used by gui_task. Jev and Cloudflare Clef-flash both
 * speak the SystemOne protocol, so the engine and prompts stay identical;
 * only the transport and credentials differ. */
export type DecisionModel = "jev" | "clef-flash"

const CLOUDFLARE_RUN_URL = "https://api.cloudflare.com/client/v4/accounts"

export function configuredDecisionModel(): DecisionModel {
  const raw = process.env.ORBIT_CU_DECISION_MODEL?.trim().toLowerCase()
  // The 27B `clef` variant was retired from the selector; keep accepting the
  // old value and route it to Clef-flash so existing configs still work.
  return raw === "clef" || raw === "clef-flash" ? "clef-flash" : "jev"
}

export function isClefModel(model: DecisionModel = configuredDecisionModel()): boolean {
  return model === "clef-flash"
}

function readSecretFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  try {
    const value = readFileSync(path, "utf8").trim()
    return value || undefined
  } catch {
    return undefined
  }
}

export function loadCloudflareToken(): string {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || readSecretFromPath(process.env.ORBIT_CF_API_TOKEN_PATH)
  if (!token) throw new Error("未配置 Cloudflare API Token，请在 设置 → 操作电脑 中保存")
  return token
}

function loadCloudflareAccountId(): string {
  const account = process.env.ORBIT_CF_ACCOUNT_ID?.trim()
  if (!account) throw new Error("未配置 Cloudflare Account ID，请在 设置 → 操作电脑 中保存")
  return account
}

/**
 * Cloudflare hosts Clef behind Workers AI, not a SystemOne root. The SDK
 * always POSTs `{baseURL}/v1/systemone`, so this adapter rewrites that single
 * request to the Workers AI run endpoint and lifts `result` back to the top
 * level. Everything downstream keeps speaking the Jev/SystemOne protocol.
 */
function createClefFetch(accountId: string, token: string, model: DecisionModel): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase()
    if (method !== "POST" || !input.endsWith("/v1/systemone")) throw new Error(`Clef 适配器只支持 POST /v1/systemone，收到 ${method} ${input}`)
    const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { state?: unknown; questions?: unknown; model?: string }
    const selected: DecisionModel = request.model === "clef-flash" ? "clef-flash" : model
    const response = await fetch(`${CLOUDFLARE_RUN_URL}/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${selected}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: selected, state: request.state, questions: request.questions }),
      signal: init?.signal ?? undefined,
    })
    const payload = await response.json().catch(() => null) as { success?: boolean; result?: unknown; errors?: { message?: string }[] } | null
    if (!payload || !response.ok || payload.success === false) {
      const message = payload?.errors?.[0]?.message ?? `Cloudflare 返回 ${response.status}`
      return new Response(JSON.stringify({ error: { message } }), { status: response.status >= 400 ? response.status : 502, headers: { "Content-Type": "application/json" } })
    }
    return new Response(JSON.stringify(payload.result ?? {}), { status: 200, headers: { "Content-Type": "application/json" } })
  }
}

/**
 * Build the SystemOne client for the selected backend. Jev keeps the upstream
 * TypeSafe client; Clef reuses the same SDK with a Workers AI transport so no
 * separate proxy process is required. The Jev key is only read for Jev, so a
 * Clef-only machine never needs a TypeSafe credential.
 */
export function createDecisionClient(loadJevKey: () => string): TypeSafeClient {
  const model = configuredDecisionModel()
  if (!isClefModel(model)) {
    const baseURL = process.env.ORBIT_CU_SYSTEMONE_BASE_URL?.trim()
    return new TypeSafeClient({ apiKey: loadJevKey(), logLevel: "off", ...(baseURL ? { baseURL } : {}) })
  }
  const accountId = loadCloudflareAccountId()
  const token = loadCloudflareToken()
  return new TypeSafeClient({
    // The adapter owns the real credential; the SDK only needs a non-empty key.
    apiKey: token,
    baseURL: "https://clef.systemone.invalid",
    defaultModel: model,
    logLevel: "off",
    // The upstream SDK default is 10s; a cold 27B `clef` request can exceed it.
    timeout: 30_000,
    fetch: createClefFetch(accountId, token, model),
  })
}
