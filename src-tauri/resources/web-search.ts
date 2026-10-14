import { readFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Expand-backed web search configuration. Secrets live in auth.json. */
export type WebSearchSettings = {
  enabled: boolean
  baseUrl: string
  providerId: string
  searchUrl: string
}

export const WEB_SEARCH_TOOL = "web_search"
export const DEFAULT_EXPAND_BASE_URL = "https://api.expand.ai"
export const DEFAULT_EXPAND_PROVIDER_ID = "expand"
export const DEFAULT_SEARCH_URL = "https://www.bing.com/search?q="

export type WebSearchMode = "search" | "fetch" | "highlights"

const validUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\/[^\s]+$/i.test(value)
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value)

/** Resolve a partial on-disk config while keeping the feature on by default. */
export function resolveWebSearchSettings(stored: unknown): WebSearchSettings {
  const raw = stored && typeof stored === "object" ? stored as Record<string, unknown> : {}
  return {
    enabled: raw.enabled !== false,
    baseUrl: (validUrl(raw.baseUrl) ? raw.baseUrl : DEFAULT_EXPAND_BASE_URL).replace(/\/+$/, ""),
    providerId: validId(raw.providerId) ? raw.providerId : DEFAULT_EXPAND_PROVIDER_ID,
    searchUrl: validUrl(raw.searchUrl) ? raw.searchUrl : DEFAULT_SEARCH_URL,
  }
}

export function webSearchPageUrl(settings: WebSearchSettings, query: string): string {
  return `${settings.searchUrl}${encodeURIComponent(query.trim())}`
}

/** The exact Expand request is kept pure so it can be tested without a network call. */
export function webSearchRequest(settings: WebSearchSettings, mode: WebSearchMode, input: { query?: string; url?: string; maxResults?: number; minScore?: number }) {
  const target = mode === "search" ? webSearchPageUrl(settings, input.query ?? "") : input.url?.trim()
  if (!target) throw new Error(mode === "search" ? "搜索需要 query" : "该模式需要 url")
  if (mode === "highlights") {
    if (!input.query?.trim()) throw new Error("highlights 模式需要 query")
    return {
      url: `${settings.baseUrl}/v1/fetch/json`,
      body: {
        url: target,
        highlights: {
          query: input.query.trim(),
          maxResults: Math.min(50, Math.max(1, Math.floor(input.maxResults ?? 5))),
          minScore: Math.min(1, Math.max(0, input.minScore ?? 0.6)),
        },
        include: { markdown: true },
      },
    }
  }
  return {
    url: `${settings.baseUrl}/v1/fetch?include=`,
    body: { url: target },
  }
}

/** Keep the provider response bounded while preserving its cited Markdown links. */
export function formatWebSearchResult(query: string, markdown: string, maxChars = 20_000): string {
  const body = markdown.trim()
  const bounded = body.length > maxChars ? `${body.slice(0, maxChars)}\n\n[结果过长，已截断]` : body
  return `Expand Web Search：${query.trim()}\n\n${bounded}`
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function providerApiKey(auth: Record<string, unknown>, providerId: string): string | undefined {
  const wanted = providerId.toLowerCase()
  for (const [name, value] of Object.entries(auth)) {
    if (name.toLowerCase() !== wanted || !value || typeof value !== "object") continue
    const entry = value as Record<string, unknown>
    const key = entry.key ?? entry.apiKey ?? entry.value
    if (typeof key === "string" && key.trim()) return key.trim()
  }
  return undefined
}

function boundedJson(value: unknown, maxChars = 20_000): string {
  const text = JSON.stringify(value, null, 2)
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[结果过长，已截断]`
}

/** Register one tool with explicit modes so the model has one stable entry point. */
export function registerWebSearch(pi: ExtensionAPI, options: { readConfig: () => WebSearchSettings; authPath: string }): void {
  const settings = options.readConfig()
  if (!settings.enabled) return
  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: "Web Search",
    description: "使用 Expand 搜索网页、抓取 URL 或从页面提取相关片段。通过 mode 选择 search、fetch 或 highlights。",
    promptSnippet: "搜索互联网或读取网页内容",
    promptGuidelines: [
      "需要最新网页信息、搜索结果或网页正文时使用 web_search，不要用 bash curl 代替。",
      "search 传 query；fetch 传完整 http(s) URL；highlights 同时传 URL 和 query。",
    ],
    parameters: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["search", "fetch", "highlights"], description: "search 搜索网页；fetch 抓取 URL；highlights 提取页面相关片段。" },
        query: { type: "string", description: "search 的搜索词，或 highlights 的相关性问题。" },
        url: { type: "string", description: "fetch / highlights 要处理的完整 http(s) URL。" },
        maxResults: { type: "number", minimum: 1, maximum: 50, description: "highlights 返回的片段数量，默认 5。" },
        minScore: { type: "number", minimum: 0, maximum: 1, description: "highlights 的最低相关性分数，默认 0.6。" },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    defaultActive: true,
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined) {
      const input = params as { mode?: WebSearchMode; query?: string; url?: string; maxResults?: number; minScore?: number }
      const mode = input.mode
      if (mode !== "search" && mode !== "fetch" && mode !== "highlights") throw new Error("mode 必须是 search、fetch 或 highlights")
      const current = options.readConfig()
      const key = providerApiKey(readJson(options.authPath), current.providerId)
      if (!key) throw new Error(`未配置 Expand API Key（Provider ID: ${current.providerId}）`)
      const request = webSearchRequest(current, mode, input)
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "x-expand-api-key": key, "Content-Type": "application/json", Accept: mode === "highlights" ? "application/json" : "text/markdown" },
        body: JSON.stringify(request.body),
        signal,
      })
      const raw = await response.text()
      if (!response.ok) {
        let detail = raw
        try { detail = String((JSON.parse(raw) as { message?: unknown }).message ?? raw) } catch { /* keep text */ }
        throw new Error(`Expand ${mode} 请求失败（${response.status}）：${detail.slice(0, 800)}`)
      }
      const result = mode === "highlights" ? boundedJson(JSON.parse(raw)) : formatWebSearchResult(input.query ?? input.url ?? "", raw)
      return { content: [{ type: "text" as const, text: result }], details: { mode, query: input.query ?? null, url: input.url ?? null } }
    },
  })
}

type SearchToolApi = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">

/** Ensure the built-in web search remains active for a newly started session. */
export function enableWebSearchTool(pi: SearchToolApi): boolean {
  if (!pi.getAllTools().some(tool => tool.name === WEB_SEARCH_TOOL)) return false
  const active = pi.getActiveTools()
  if (active.includes(WEB_SEARCH_TOOL)) return false
  pi.setActiveTools([...active, WEB_SEARCH_TOOL])
  return true
}
