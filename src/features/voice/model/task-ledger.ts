export type VoiceTaskKind = "action" | "lookup"
export type VoiceTaskStatus = "queued" | "running" | "waiting" | "settled" | "failed" | "cancelled"

export type VoiceTaskRecord = {
  taskId: string
  taskKey: string
  targetSession: string
  kind: VoiceTaskKind
  request: string
  status: VoiceTaskStatus
  result?: string
  error?: string
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

const WEATHER_WORDS = /weather|forecast|temperature|天气|气温|温度|预报/u
const CITIES = ["beijing", "北京", "shanghai", "上海", "guangzhou", "广州", "shenzhen", "深圳", "chengdu", "成都", "hangzhou", "杭州", "new york", "纽约"]

function normalize(text: string) {
  return text.toLowerCase().replace(/[\s\u3000]+/gu, " ").replace(/[?!？！。,.，、:：;；]+/gu, " ").trim()
}

function weatherLocation(text: string) {
  const normalized = normalize(text)
  return CITIES.find(city => normalized.includes(city)) ?? "default"
}

/** Stable enough for dedupe; the executor still receives the user's exact text. */
export function voiceTaskKey(text: string, kind: VoiceTaskKind): string {
  const normalized = normalize(text)
  if (kind === "lookup" && WEATHER_WORDS.test(normalized)) return `lookup:weather:${weatherLocation(normalized)}`
  return `${kind}:${normalized}`
}

export function requestsRefresh(text: string) {
  return /重新|再查|最新|refresh|again|再看|查一下最新/u.test(normalize(text))
}

function isWeather(text: string) { return WEATHER_WORDS.test(normalize(text)) }

export class TaskLedger {
  private readonly records = new Map<string, VoiceTaskRecord>()

  start(input: { taskId: string; targetSession: string; kind: VoiceTaskKind; request: string; now?: number }) {
    const now = input.now ?? Date.now()
    const record: VoiceTaskRecord = {
      taskId: input.taskId,
      taskKey: voiceTaskKey(input.request, input.kind),
      targetSession: input.targetSession,
      kind: input.kind,
      request: input.request,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(this.key(record.taskKey, record.targetSession), record)
    return record
  }

  findReusable(taskKey: string, targetSession: string, now = Date.now()) {
    const record = this.records.get(this.key(taskKey, targetSession))
    if (!record) return undefined
    if (record.status === "settled" && record.expiresAt !== undefined && record.expiresAt <= now) return undefined
    if (record.status === "failed" || record.status === "cancelled") return undefined
    return record
  }

  findReusableForRequest(text: string, kind: VoiceTaskKind, targetSession: string, now = Date.now()) {
    const key = voiceTaskKey(text, kind)
    const exact = this.findReusable(key, targetSession, now)
    if (exact || kind !== "lookup" || !isWeather(text) || weatherLocation(text) !== "default") return exact
    return [...this.records.values()]
      .filter(record => record.targetSession === targetSession && record.taskKey.startsWith("lookup:weather:") && record.status !== "failed" && record.status !== "cancelled")
      .filter(record => record.status !== "settled" || record.expiresAt === undefined || record.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  activeForSession(targetSession: string) {
    return [...this.records.values()]
      .filter(record => record.targetSession === targetSession && ["queued", "running", "waiting"].includes(record.status))
      .sort((a, b) => a.createdAt - b.createdAt)[0]
  }

  markRunning(taskId: string, targetSession: string, now = Date.now()) {
    const current = this.get(taskId, targetSession)
    if (!current || current.status !== "queued") return current
    return this.update(taskId, targetSession, { status: "running", updatedAt: now })
  }

  settle(taskId: string, targetSession: string, result: string, kind: VoiceTaskKind, now = Date.now()) {
    return this.update(taskId, targetSession, {
      status: "settled",
      result: result.trim().slice(0, 8000),
      error: undefined,
      updatedAt: now,
      // Read-only facts are useful briefly; actions must be explicitly asked for again.
      expiresAt: kind === "lookup" ? now + 5 * 60_000 : undefined,
    })
  }

  fail(taskId: string, targetSession: string, error: string, now = Date.now()) {
    return this.update(taskId, targetSession, { status: "failed", error: error.slice(0, 2000), updatedAt: now })
  }

  cancel(taskId: string, targetSession: string, now = Date.now()) {
    return this.update(taskId, targetSession, { status: "cancelled", updatedAt: now })
  }

  clear() { this.records.clear() }

  get(taskId: string, targetSession: string) {
    return [...this.records.values()].find(record => record.taskId === taskId && record.targetSession === targetSession)
  }

  private key(taskKey: string, targetSession: string) { return `${targetSession}\u0000${taskKey}` }

  private update(taskId: string, targetSession: string, patch: Partial<VoiceTaskRecord>) {
    const key = [...this.records.entries()].find(([, record]) => record.taskId === taskId && record.targetSession === targetSession)?.[0]
    if (!key) return undefined
    const current = this.records.get(key)!
    const next = { ...current, ...patch }
    this.records.set(key, next)
    return next
  }
}
