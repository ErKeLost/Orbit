import { DriverToolError } from "./errors.ts"
import { createCliClient, type CuaToolClient } from "./tool-client.ts"
import type { ToolResult } from "./tool-result.ts"

/**
 * Typed wrappers over the Cua Driver MCP tool surface.
 *
 * Only the tools the gui_task loop needs are wrapped. Everything here is a
 * thin translation: the driver owns element/capture binding, the action ladder
 * and read-back, and this module never retries or escalates on its own — a
 * refusal is reported so the loop can offer the next rung as a new candidate.
 */

export type Bounds = { x: number; y: number; w: number; h: number }

export type AppInfo = {
  name: string
  bundleId?: string
  pid: number
  running: boolean
  active: boolean
  launchPath?: string
}

export type WindowInfo = {
  windowId: number
  title: string
  pid: number
  appName?: string
  onScreen: boolean
  bounds?: Bounds
  zIndex?: number
}

/** One actionable row of the accessibility tree, as the driver emits it. */
export type CuaElement = {
  elementIndex: number
  elementToken?: string
  role: string
  depth: number
  parentIndex?: number
  label?: string
  value?: string
  valueDescription?: string
  enabled?: boolean
  selected?: boolean
  inWebContent?: boolean
  actions: string[]
  frame?: Bounds
  min?: number
  max?: number
}

export type Screenshot = {
  mimeType: string
  width: number
  height: number
  /** Present only when the caller asked for inline pixels. */
  base64?: string
}

export type WindowState = {
  appName: string
  windowTitle: string
  pid: number
  windowId: number
  snapshotId?: string
  captureId?: string
  elements: CuaElement[]
  elementsComplete: boolean
  truncated: boolean
  totalElementCount: number
  screenshot?: Screenshot
  raw: Record<string, unknown>
}

export type ActionEffect = "confirmed" | "unverifiable" | "suspected_noop" | "partial" | "refused"

export type Escalation = { recommended: "px" | "page" | "foreground"; reason?: string }

export type ActionResult = {
  effect?: ActionEffect
  verified: boolean
  escalation?: Escalation
  code?: string
  raw: Record<string, unknown>
}

export type VisualRegion = {
  id: string
  kind: "text" | "icon"
  text?: string
  label?: string
  confidence: number
  interactive: boolean
  bounds: Bounds
}

export type VisualRegionSet = {
  captureId: string
  regions: VisualRegion[]
}

export type PermissionState = { accessibility: boolean; screenRecording: boolean }

export interface CuaDriver {
  readonly transport: "cli"
  readonly session?: string
  listTools(): Promise<string[]>
  listApps(): Promise<AppInfo[]>
  listWindows(query?: { app?: string; pid?: number; onScreenOnly?: boolean }): Promise<WindowInfo[]>
  getWindowState(input: GetWindowStateInput): Promise<WindowState>
  click(input: ClickInput): Promise<ActionResult>
  doubleClick(input: PointInput & { elementToken?: string }): Promise<ActionResult>
  rightClick(input: PointInput & { elementToken?: string }): Promise<ActionResult>
  typeText(input: TypeInput): Promise<ActionResult>
  setValue(input: { elementToken: string; value: string }): Promise<ActionResult>
  pressKey(input: { key: string; modifiers?: string[]; elementToken?: string; pid?: number; windowId?: number }): Promise<ActionResult>
  hotkey(input: { keys: string[]; elementToken?: string; pid?: number; windowId?: number }): Promise<ActionResult>
  scroll(input: { direction: "up" | "down" | "left" | "right"; amount?: number; by?: string; elementToken?: string; x?: number; y?: number; pid?: number; windowId?: number }): Promise<ActionResult>
  invokeMenu(input: { pid: number; windowId: number; path: string[] }): Promise<ActionResult>
  parseVisualRegions(captureId: string, options?: { kinds?: Array<"text" | "icon">; minConfidence?: number; maxRegions?: number }): Promise<VisualRegionSet>
  verifyState(input: { pid: number; windowId: number; expect: unknown[] }): Promise<{ satisfied: boolean; raw: Record<string, unknown> }>
  checkPermissions(): Promise<PermissionState>
  callTool(name: string, args?: Record<string, unknown>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ToolResult>
  dispose(): Promise<void>
}

export type GetWindowStateInput = {
  pid: number
  windowId: number
  includeAccessibilityTree?: boolean
  includeScreenshot?: boolean
  treeFormat?: "elements" | "markdown"
  since?: string
  query?: string
  maxElements?: number
  maxDepth?: number
  timeoutMs?: number
  fullOutput?: boolean
  maxImageDimension?: number
}

export type PointInput = {
  x?: number
  y?: number
  captureId?: string
  deliveryMode?: "background" | "foreground"
  button?: "left" | "right" | "middle"
  count?: number
  pid?: number
  windowId?: number
}

export type ClickInput = PointInput & {
  elementToken?: string
  /** AX action used on the element path. `press` is the driver default. */
  action?: "press" | "show_menu" | "pick" | "confirm" | "cancel" | "open" | "show_alternate_ui" | "show_default_ui"
}

export type TypeInput = {
  text: string
  elementToken?: string
  x?: number
  y?: number
  pid?: number
  windowId?: number
  deliveryMode?: "background" | "foreground"
}

export async function connectDriver(options: { signal?: AbortSignal; socket?: string; session?: string } = {}): Promise<CuaDriver> {
  const client = await createCliClient({ signal: options.signal, socket: options.socket, session: options.session })
  return createDriver(client, options)
}

export function createDriver(client: CuaToolClient, options: { signal?: AbortSignal } = {}): CuaDriver {
  const call = (name: string, args: Record<string, unknown> = {}, timeoutMs?: number) =>
    client.call(name, prune(args), { signal: options.signal, timeoutMs })

  const action = async (name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ActionResult> => {
    const result = await call(name, args, timeoutMs)
    return normalizeAction(result)
  }

  return {
    transport: client.transport,
    session: client.session,
    listTools: () => client.listTools(),
    async listApps() {
      const { value } = await call("list_apps")
      const apps = Array.isArray(value.apps) ? value.apps as any[] : []
      return apps.map(app => ({
        name: String(app.name ?? ""),
        bundleId: typeof app.bundle_id === "string" ? app.bundle_id : undefined,
        pid: Number(app.pid ?? 0),
        running: app.running === true,
        active: app.active === true,
        launchPath: typeof app.launch_path === "string" ? app.launch_path : undefined,
      })).filter(app => app.name && Number.isFinite(app.pid) && app.pid > 0)
    },
    async listWindows(query = {}) {
      const { value } = await call("list_windows", {
        app: query.app,
        pid: query.pid,
        on_screen_only: query.onScreenOnly,
      })
      const windows = Array.isArray(value.windows) ? value.windows as any[] : []
      return windows.map(window => ({
        windowId: Number(window.window_id ?? 0),
        title: String(window.title ?? ""),
        pid: Number(window.pid ?? 0),
        appName: typeof window.app_name === "string" ? window.app_name : undefined,
        onScreen: window.is_on_screen === true,
        bounds: toBounds(window.bounds),
        zIndex: typeof window.z_index === "number" ? window.z_index : undefined,
      })).filter(window => Number.isFinite(window.windowId) && window.windowId > 0)
    },
    async getWindowState(input) {
      const { value } = await call("get_window_state", {
        pid: input.pid,
        window_id: input.windowId,
        include_accessibility_tree: input.includeAccessibilityTree,
        include_screenshot: input.includeScreenshot,
        tree_format: input.treeFormat ?? "elements",
        since: input.since,
        query: input.query,
        max_elements: input.maxElements,
        max_depth: input.maxDepth,
        timeout_ms: input.timeoutMs,
        full_output: input.fullOutput,
        max_image_dimension: input.maxImageDimension,
      }, (input.timeoutMs ?? 15_000) + 10_000)
      return normalizeWindowState(value)
    },
    click: input => action("click", {
      element_token: input.elementToken,
      action: input.action,
      pid: input.pid,
      window_id: input.windowId,
      x: input.x,
      y: input.y,
      capture_id: input.captureId,
      delivery_mode: input.deliveryMode,
      button: input.button,
      count: input.count,
    }),
    doubleClick: input => action("double_click", {
      element_token: input.elementToken,
      pid: input.pid,
      window_id: input.windowId,
      x: input.x,
      y: input.y,
      capture_id: input.captureId,
      delivery_mode: input.deliveryMode,
    }),
    rightClick: input => action("right_click", {
      element_token: input.elementToken,
      pid: input.pid,
      window_id: input.windowId,
      x: input.x,
      y: input.y,
      delivery_mode: input.deliveryMode,
    }),
    typeText: input => action("type_text", {
      text: input.text,
      element_token: input.elementToken,
      pid: input.pid,
      window_id: input.windowId,
      x: input.x,
      y: input.y,
      delivery_mode: input.deliveryMode,
    }, 30_000),
    setValue: input => action("set_value", { element_token: input.elementToken, value: input.value }),
    pressKey: input => action("press_key", { key: input.key, modifiers: input.modifiers, element_token: input.elementToken, pid: input.pid, window_id: input.windowId }),
    hotkey: input => action("hotkey", { keys: input.keys, element_token: input.elementToken, pid: input.pid, window_id: input.windowId }),
    scroll: input => action("scroll", {
      direction: input.direction,
      amount: input.amount,
      by: input.by,
      element_token: input.elementToken,
      x: input.x,
      y: input.y,
      pid: input.pid,
      window_id: input.windowId,
    }),
    invokeMenu: input => action("invoke_menu", { pid: input.pid, window_id: input.windowId, path: input.path }, 20_000),
    async parseVisualRegions(captureId, options = {}) {
      const { value } = await call("parse_visual_regions", {
        capture_id: captureId,
        options: {
          kinds: options.kinds,
          min_confidence: options.minConfidence,
          max_regions: options.maxRegions,
        },
      }, 60_000)
      const regions = Array.isArray(value.regions) ? value.regions as any[] : []
      return {
        captureId,
        regions: regions.map(region => ({
          id: String(region.id ?? ""),
          kind: region.kind === "icon" ? "icon" as const : "text" as const,
          text: typeof region.text === "string" ? region.text : undefined,
          label: typeof region.label === "string" ? region.label : undefined,
          confidence: Number(region.confidence ?? 0),
          interactive: region.interactive === true,
          bounds: toBounds(region.bounds) ?? { x: 0, y: 0, w: 0, h: 0 },
        })).filter(region => region.id),
      }
    },
    async verifyState(input) {
      const { value } = await call("verify_state", { pid: input.pid, window_id: input.windowId, expect: input.expect }, 20_000)
      const satisfied = value.satisfied === true || value.verified === true
      return { satisfied, raw: value }
    },
    async checkPermissions() {
      const { value } = await call("check_permissions")
      return { accessibility: value.accessibility === true, screenRecording: value.screen_recording === true }
    },
    callTool: (name, args, callOptions) => client.call(name, args, callOptions),
    dispose: () => client.dispose(),
  }
}

/** Normalize the driver's newline-free JSON payload; it uses snake_case. */
export function normalizeWindowState(value: Record<string, unknown>): WindowState {
  const rawElements = Array.isArray(value.elements) ? value.elements as any[] : []
  const screenshot = value.screenshot && typeof value.screenshot === "object"
    ? value.screenshot as Record<string, unknown>
    : undefined
  const pngBase64 = typeof value.screenshot_png_b64 === "string" ? value.screenshot_png_b64 : undefined
  return {
    appName: String(value.app_name ?? ""),
    windowTitle: String(value.window_title ?? ""),
    pid: Number(value.pid ?? 0),
    windowId: Number(value.window_id ?? 0),
    snapshotId: typeof value.snapshot_id === "string" ? value.snapshot_id : undefined,
    captureId: typeof value.capture_id === "string" ? value.capture_id : undefined,
    elements: rawElements.map(normalizeElement).sort((left, right) => left.elementIndex - right.elementIndex),
    elementsComplete: value.elements_complete === true,
    truncated: value.truncated === true,
    totalElementCount: Number(value.total_element_count ?? rawElements.length),
    screenshot: screenshot || pngBase64 || value.screenshot_width || value.screenshot_height || value.screenshot_mime_type
      ? {
        mimeType: String(screenshot?.mime_type ?? value.screenshot_mime_type ?? "image/png"),
        width: Number(screenshot?.width ?? value.screenshot_width ?? 0),
        height: Number(screenshot?.height ?? value.screenshot_height ?? 0),
        base64: pngBase64,
      }
      : undefined,
    raw: value,
  }
}

function normalizeElement(element: any): CuaElement {
  return {
    elementIndex: Number(element.element_index ?? 0),
    elementToken: typeof element.element_token === "string" ? element.element_token : undefined,
    role: String(element.role ?? "unknown"),
    depth: Number(element.depth ?? 0),
    parentIndex: typeof element.parent_index === "number" ? element.parent_index : undefined,
    label: nonEmpty(element.label),
    value: nonEmpty(element.value),
    valueDescription: nonEmpty(element.value_description),
    enabled: typeof element.enabled === "boolean" ? element.enabled : undefined,
    selected: typeof element.selected === "boolean" ? element.selected : undefined,
    inWebContent: element.in_web_content === true,
    actions: Array.isArray(element.actions) ? element.actions.map(String) : [],
    frame: toBounds(element.frame),
    min: typeof element.min === "number" ? element.min : undefined,
    max: typeof element.max === "number" ? element.max : undefined,
  }
}

export function normalizeAction(result: ToolResult): ActionResult {
  const value = result.value
  const effect = typeof value.effect === "string" ? value.effect as ActionEffect : undefined
  const escalationRaw = value.escalation && typeof value.escalation === "object" ? value.escalation as Record<string, unknown> : undefined
  const recommended = escalationRaw?.recommended
  const escalation: Escalation | undefined = recommended === "px" || recommended === "page" || recommended === "foreground"
    ? { recommended, reason: typeof escalationRaw?.reason === "string" ? escalationRaw.reason : undefined }
    : undefined
  return {
    effect,
    verified: value.verified === true || effect === "confirmed",
    escalation,
    code: typeof value.code === "string" ? value.code : undefined,
    raw: value,
  }
}

function toBounds(value: unknown): Bounds | undefined {
  if (!value || typeof value !== "object") return undefined
  const bounds = value as Record<string, unknown>
  const x = Number(bounds.x ?? NaN)
  const y = Number(bounds.y ?? NaN)
  const w = Number(bounds.width ?? bounds.w ?? NaN)
  const h = Number(bounds.height ?? bounds.h ?? NaN)
  if (![x, y, w, h].every(Number.isFinite)) return undefined
  return { x, y, w, h }
}

function nonEmpty(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value)
  return text.trim() ? text : undefined
}

/** Drop undefined so the driver never sees a key it must reject. */
function prune(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
}

export { DriverToolError }
