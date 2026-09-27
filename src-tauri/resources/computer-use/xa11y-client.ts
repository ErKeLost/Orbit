import { access, constants } from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentDesktopCommandError, type AgentDesktopClient, type DesktopEnvelope, type DesktopNode, type SnapshotData } from "./agent-desktop-client.ts"

export async function createXa11yClient(signal?: AbortSignal): Promise<AgentDesktopClient> {
  const binary = await resolveWorker()
  await access(binary, constants.X_OK)
  const worker = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], signal })
  const pending = new Map<number, { resolve: (value: DesktopEnvelope) => void; reject: (error: Error) => void }>()
  let nextId = 1
  let activeApp = ""
  let buffer = ""
  worker.stdout.on("data", chunk => {
    buffer += String(chunk)
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const response = JSON.parse(line) as DesktopEnvelope & { id?: number }
        const id = response.id
        if (typeof id !== "number") continue
        const request = pending.get(id)
        if (!request) continue
        pending.delete(id)
        request.resolve(response)
      } catch (error) {
        for (const request of pending.values()) request.reject(new Error(`Invalid xa11y worker response: ${String(error)}`))
        pending.clear()
      }
    }
  })
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  worker.on("error", error => fail(error))
  worker.on("close", code => fail(new Error(`xa11y worker exited (${code ?? "unknown"})`)))

  return {
    backend: "xa11y",
    async run<T>(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DesktopEnvelope<T>> {
      const headed = args[0] === "--headed"
      const commandOffset = headed ? 1 : 0
      const command = args[commandOffset]
      if (!command) throw new Error("xa11y command is missing")
      const app = valueAfter(args, "--app") ?? (command === "launch" ? args[commandOffset + 1] : undefined) ?? activeApp
      if (command === "launch") activeApp = app
      const id = nextId++
      const payload: Record<string, unknown> = {
        id,
        command: ["launch", "snapshot", "activate-app", "now-playing", "menubar"].includes(command) ? command : "action",
        app,
      }
      if (!["launch", "snapshot", "activate-app", "now-playing", "menubar"].includes(command)) {
        payload.operation = command === "scroll"
          ? valueAfter(args, "--direction") === "up" ? "scroll-up" : "scroll-down"
          : command
        payload.ref = args[commandOffset + 1] ?? ""
        if (command === "menu-press") {
          payload.path = JSON.parse(args[commandOffset + 1] ?? "[]")
          payload.ref = ""
        }
        if (["set-value", "type"].includes(command)) payload.value = args[commandOffset + 2]
        if (headed) payload.headed = true
        // Event-driven settle: the worker arms an AXObserver before dispatch
        // and returns once the app has posted notifications and gone quiet.
        const settleTimeout = Number(valueAfter(args, "--settle-timeout-ms"))
        if (Number.isFinite(settleTimeout) && settleTimeout > 0) payload.settle = { timeoutMs: Math.round(settleTimeout), quietMs: 90, maxAfterFirstMs: 700 }
      }
      const response = await new Promise<DesktopEnvelope>((resolvePromise, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const settle = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => { if (timer) clearTimeout(timer); fn(...args) }
        pending.set(id, { resolve: settle(resolvePromise), reject: settle(reject) })
        worker.stdin.write(`${JSON.stringify(payload)}\n`, error => { if (error && pending.delete(id)) { if (timer) clearTimeout(timer); reject(error) } })
        if (options.timeoutMs) {
          timer = setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`xa11y request timed out after ${options.timeoutMs}ms`))
          }, options.timeoutMs)
          timer.unref?.()
        }
      })
      if (!response.ok) throw new AgentDesktopCommandError(command ?? "xa11y", response.error ?? { code: "AX_ERROR", message: "xa11y request failed" })
      if (command === "snapshot") {
        const normalized = normalizeSnapshot(response.data)
        const root = valueAfter(args, "--root")
        return { ...response, data: (root ? sliceSnapshotRoot(normalized, root) : normalized) as T }
      }
      if (command === "launch") return { ...response, data: response.data as T }
      return response as DesktopEnvelope<T>
    },
    async dispose() { worker.kill() },
  }
}

export function normalizeSnapshot(value: unknown): SnapshotData {
  const data = value as { app: string; window: { id: string; title?: string }; snapshot_id: string; complete: boolean; ref_count: number; tree: { children?: unknown[] } }
  const children = data.tree.children ?? []
  if (!Array.isArray(children) || children.length === 0) throw new Error("AX snapshot contains no verified window; desktop task blocked")
  const tree: DesktopNode = {
    role: "application",
    name: data.app,
    children: children.map(convertNode),
    children_count: children.length,
  }
  return { app: data.app, window: { id: data.window.id, title: data.window.title ?? data.app }, snapshot_id: data.snapshot_id, complete: data.complete, truncated: !data.complete, ref_count: data.ref_count, tree }
}

function sliceSnapshotRoot(snapshot: SnapshotData, rootRef: string): SnapshotData {
  let target: DesktopNode | undefined
  try {
    const parsed = JSON.parse(rootRef) as { path?: unknown }
    const path = Array.isArray(parsed.path) ? parsed.path.filter((item): item is number => Number.isInteger(item) && item >= 0) : []
    let current: DesktopNode | undefined = snapshot.tree
    for (const index of path) current = current?.children?.[index]
    target = current
  } catch {
    target = undefined
  }
  if (!target) return snapshot
  return {
    ...snapshot,
    complete: true,
    truncated: false,
    tree: { role: "application", name: snapshot.app, children: [target], children_count: 1 },
  }
}

function convertNode(node: any): DesktopNode {
  const states = normalizeStates(node.states)
  const actions = Array.isArray(node.actions) ? node.actions.map((x: string) => mapAction(x)) : []
  return {
    role: String(node.role ?? "unknown"),
    // Chromium publishes empty strings for missing AX labels. Treat them as
    // absent so descendant text can identify an otherwise anonymous element.
    name: nonEmpty(node.name),
    description: nonEmpty(node.description),
    value: nonEmpty(node.value),
    ref_id: node.ref_id,
    states,
    available_actions: actions,
    bounds: node.bounds ?? undefined,
    children_count: Array.isArray(node.children) ? node.children.length : Number(node.children_count ?? 0),
    children: Array.isArray(node.children) ? node.children.map(convertNode) : [],
  }
}

function normalizeStates(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (!value || typeof value !== "object") return []
  const aliases: Record<string, string> = { enabled: "enabled", visible: "visible", focused: "focused", selected: "selected", checked: "checked", editable: "editable", expanded: "expanded", active: "active", disabled: "disabled", hidden: "hidden", offscreen: "offscreen" }
  return Object.entries(value as Record<string, unknown>).filter(([key, item]) => item === true && aliases[key]).map(([key]) => aliases[key])
}

function mapAction(action: string): string {
  const map: Record<string, string> = { focus: "SetFocus", activate: "Activate", press: "Click", set_value: "SetValue", type_text: "TypeText", scroll_into_view: "ScrollTo", scroll_up_by_page: "ScrollUpByPage", scroll_down_by_page: "ScrollDownByPage" }
  return map[action] ?? action
}
function nonEmpty(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value)
  return text.trim() ? text : undefined
}
function valueAfter(args: string[], flag: string): string | undefined { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
async function resolveWorker(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.ORBIT_XA11Y_WORKER,
    // In `tauri dev`, prefer the freshly compiled debug worker. The copied
    // resources worker can be stale because beforeBundleCommand is not part
    // of the dev loop.
    resolve(process.cwd(), "src-tauri/target/debug/ax_control"),
    resolve(process.cwd(), "target/debug/ax_control"),
    // This module is shipped under src-tauri/resources/computer-use; the
    // workspace target is therefore two levels above this directory.
    // Tauri dev/build resources live under target/<profile>/resources; the
    // worker binary is a sibling of resources in that profile directory.
    resolve(here, "../../ax_control"),
    // Bundled worker ships inside the computer-use resources directory.
    resolve(here, "ax_control"),
    resolve(here, "../../target/debug/ax_control"),
    resolve(here, "../../../target/debug/ax_control"),
  ].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) { try { await access(candidate, constants.X_OK); return candidate } catch {} }
  throw new Error("xa11y worker is unavailable; build src-tauri/bin/ax_control first")
}
