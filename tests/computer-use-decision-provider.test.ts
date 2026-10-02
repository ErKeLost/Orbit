import { afterEach, describe, expect, test } from "bun:test"
import { configuredDecisionModel, createDecisionClient, isClefModel } from "../src-tauri/resources/computer-use/decision-provider"

const ENV_KEYS = ["ORBIT_CU_DECISION_MODEL", "ORBIT_CU_SYSTEMONE_BASE_URL", "ORBIT_CF_ACCOUNT_ID", "ORBIT_CF_API_TOKEN_PATH", "CLOUDFLARE_API_TOKEN"] as const

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = patch[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

afterEach(() => setEnv({}))

describe("computer use decision provider", () => {
  test("defaults to Jev when nothing is configured", () => {
    setEnv({})
    expect(configuredDecisionModel()).toBe("jev")
    expect(isClefModel()).toBe(false)
  })

  test("selects Clef-flash from the environment and ignores unknown values", () => {
    setEnv({ ORBIT_CU_DECISION_MODEL: "clef-flash" })
    expect(configuredDecisionModel()).toBe("clef-flash")
    expect(isClefModel()).toBe(true)
    // The retired 27B `clef` value still resolves to Clef-flash.
    setEnv({ ORBIT_CU_DECISION_MODEL: "CLEF" })
    expect(configuredDecisionModel()).toBe("clef-flash")
    setEnv({ ORBIT_CU_DECISION_MODEL: "gpt" })
    expect(configuredDecisionModel()).toBe("jev")
  })

  test("keeps the TypeSafe client for Jev", () => {
    setEnv({})
    const client = createDecisionClient(() => "jev-key")
    expect(client.baseURL).toBe("https://api.typesafe.ai")
    expect(client.defaultModel).toBe("jev-latest")
  })

  test("honors a custom SystemOne base URL for Jev", () => {
    setEnv({ ORBIT_CU_SYSTEMONE_BASE_URL: "https://systemone.example.com/" })
    const client = createDecisionClient(() => "jev-key")
    expect(client.baseURL).toBe("https://systemone.example.com")
  })

  test("rewrites a SystemOne request to the Cloudflare Workers AI endpoint", async () => {
    setEnv({ ORBIT_CU_DECISION_MODEL: "clef-flash", ORBIT_CF_ACCOUNT_ID: "acct-123", CLOUDFLARE_API_TOKEN: "cf-token" })
    const calls: { url: string; init: RequestInit }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      return new Response(JSON.stringify({
        success: true,
        result: { model: "clef-flash", answers: { reachable: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 12, output_tokens: 0 } },
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as typeof fetch
    try {
      const client = createDecisionClient(() => { throw new Error("Jev key must not be read for Clef") })
      const response = await client.systemOne({ state: { task: "x" }, questions: { reachable: { type: "noul", instructions: "Reachable?" } } })
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/cloudflare/clef-flash")
      const body = JSON.parse(String(calls[0].init.body)) as { model: string; state: unknown }
      expect(body.model).toBe("clef-flash")
      expect(body.state).toEqual({ task: "x" })
      expect(response.model).toBe("clef-flash")
      expect(response.answers.reachable.noul).toBeCloseTo(0.99)
      expect(response.usage.input_tokens).toBe(12)
    } finally {
      globalThis.fetch = original
    }
  })

  test("turns a Cloudflare failure into an API error", async () => {
    setEnv({ ORBIT_CU_DECISION_MODEL: "clef-flash", ORBIT_CF_ACCOUNT_ID: "acct-123", CLOUDFLARE_API_TOKEN: "cf-token" })
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "bad model" }] }), { status: 400, headers: { "Content-Type": "application/json" } })) as typeof fetch
    try {
      const client = createDecisionClient(() => "unused")
      let caught: unknown
      try {
        await client.systemOne({ state: "x", questions: { q: { type: "noul", instructions: "?" } } })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect(String(caught)).toContain("bad model")
    } finally {
      globalThis.fetch = original
    }
  })
})
