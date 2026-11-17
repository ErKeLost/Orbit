/** Stable refs and a fail-closed hit test, without leaving Playwright.
 * Playwright recycles `e1` on every aria snapshot, so the public ref is ours.
 * A ref is reused when the same snapshot line appears the same number of times,
 * in the same order. If that count changes, the whole group is stale instead of
 * shifting a later control onto an earlier ref.
 */

export type Observed = { native: string; identity: string }
export type RefEntry = { native: string; identity: string }

const refPattern = () => /\[ref=((?:f\d+)?e\d+)\]/g

export function observeTree(tree: string): Observed[] {
  const lines = tree.split("\n")
  const seen = new Set<string>()
  const out: Observed[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = refPattern().exec(lines[i] ?? "")
    if (!match?.[1] || seen.has(match[1])) continue
    seen.add(match[1])
    let identity = (lines[i] ?? "").replace(refPattern(), "").replace(/\[box=[^\]]+\]/g, "").trim()
    const next = lines[i + 1]?.trim() ?? ""
    if (next.startsWith("- /url:") || next.startsWith("/url:")) identity += "\n" + next.replace(/^- /, "")
    out.push({ native: match[1], identity })
  }
  return out
}

export function assignRefs(previous: ReadonlyMap<string, RefEntry>, observed: readonly Observed[], nextId: number) {
  const previousByIdentity = new Map<string, { ids: string[]; total: number }>()
  for (const [id, entry] of previous) {
    const group = previousByIdentity.get(entry.identity) ?? { ids: [], total: 0 }
    group.ids.push(id)
    group.total++
    previousByIdentity.set(entry.identity, group)
  }
  const nextCount = new Map<string, number>()
  for (const item of observed) nextCount.set(item.identity, (nextCount.get(item.identity) ?? 0) + 1)
  const refs = new Map<string, RefEntry>()
  const publicOf = new Map<string, string>()
  const used = new Set<string>()
  let id = nextId
  for (const item of observed) {
    const group = previousByIdentity.get(item.identity)
    // Same count and order: keep every copy. A removal makes the whole group stale
    // rather than shifting a later button onto an earlier ref.
    const reusable = group && group.total === nextCount.get(item.identity) ? group.ids.shift() : undefined
    const publicId = reusable && !used.has(reusable) ? reusable : `e${id++}`
    used.add(publicId)
    refs.set(publicId, { native: item.native, identity: item.identity })
    publicOf.set(item.native, publicId)
  }
  return { refs, nextId: id, publicOf }
}

/** Main-frame text repeats the accessibility tree. Child frames stay, so a cross-origin iframe is still visible. */
export function frameSnapshotText(frames: readonly { main: boolean; text: string }[], limit = 4000) {
  return frames.filter(frame => !frame.main && frame.text).map(frame => frame.text).join("\n").slice(0, limit)
}

export function rewriteRefs(tree: string, publicOf: ReadonlyMap<string, string>) {
  return tree.replace(refPattern(), (all, native: string) => {
    const id = publicOf.get(native)
    return id ? `[ref=${id}]` : all
  })
}

type Live = {
  tagName?: string
  id?: string
  className?: unknown
  disabled?: boolean
  textContent?: string | null
  value?: unknown
  checked?: boolean
  getAttribute?: (name: string) => string | null
  matches?: (selector: string) => boolean
  closest?: (selector: string) => Live | null
  contains?: (node: Live) => boolean
  parentElement?: Live | null
  parentNode?: Live | null
  getRootNode?: () => { host?: Live | null }
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number }
  ownerDocument?: {
    defaultView?: { innerWidth: number; innerHeight: number; getComputedStyle?: (el: Live) => { visibility?: string } } | null
    elementFromPoint?: (x: number, y: number) => Live | null
  } | null
}

/** Name and href only. Fill and keypress do not need a clear hit point. Serialized into the page, so it has no module dependencies. */
export function identityMismatch(el: Live, identity: string | null): string | null {
  if (!identity) return null
  const name = /"([^"]*)"/.exec(identity)?.[1]
  if (name) {
    const live = `${el.getAttribute?.("aria-label") ?? ""} ${el.getAttribute?.("title") ?? ""} ${el.textContent ?? ""} ${el.value ?? ""}`
    if (!live.includes(name)) return "The observed target changed. Read a new browser_snapshot."
  }
  const url = /\/url:\s*(\S+)/.exec(identity)?.[1]
  const href = el.getAttribute?.("href")
  if (url && href && !href.includes(url) && !url.includes(href)) return "The observed target changed. Read a new browser_snapshot."
  return null
}

/** Runs in the page via Playwright, so it cannot call helpers from this module. */
export function inspectTarget(el: Live, identity: string | null): string | null {
  if (identity) {
    const name = /"([^"]*)"/.exec(identity)?.[1]
    if (name) {
      const live = `${el.getAttribute?.("aria-label") ?? ""} ${el.getAttribute?.("title") ?? ""} ${el.textContent ?? ""} ${el.value ?? ""}`
      if (!live.includes(name)) return "The observed target changed. Read a new browser_snapshot."
    }
    const url = /\/url:\s*(\S+)/.exec(identity)?.[1]
    const href = el.getAttribute?.("href")
    if (url && href && !href.includes(url) && !url.includes(href)) return "The observed target changed. Read a new browser_snapshot."
  }
  const rect = el.getBoundingClientRect?.()
  const view = el.ownerDocument?.defaultView
  const visibility = view?.getComputedStyle?.(el).visibility
  if (!rect || (rect.width <= 0 && rect.height <= 0) || visibility === "hidden" || visibility === "collapse") return "Element is not visible, so the click would not reach it. Snapshot again after it is shown."
  if (el.disabled || el.matches?.(":disabled") || el.getAttribute?.("aria-disabled") === "true") return "Element is disabled, so the click would not reach it."
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  if (!view || x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return "Element is outside the viewport, so the click would not reach it. Scroll it into view and snapshot again."
  const hit = el.ownerDocument?.elementFromPoint?.(x, y)
  if (!hit || hit === el) return null
  const up = (node: Live | null | undefined) => node ? node.parentElement ?? node.parentNode ?? node.getRootNode?.().host ?? null : null
  for (let node: Live | null = hit; node; node = up(node)) if (node === el) return null
  for (let node: Live | null = el; node; node = up(node)) if (node === hit) return null
  const hitLabel = hit.closest?.("label")
  if (hitLabel && (hitLabel.contains?.(el) || (hitLabel as { control?: Live }).control === el)) return null
  const ownLabel = el.closest?.("label")
  if (ownLabel?.contains?.(hit)) return null
  let desc = (hit.tagName ?? "element").toLowerCase()
  if (hit.id) desc += `#${hit.id}`
  else if (typeof hit.className === "string" && hit.className.trim()) desc += `.${hit.className.trim().split(/\s+/).slice(0, 2).join(".")}`
  return `Element is covered by <${desc}> at its click point, so the input would land on that element instead. Dismiss or interact with the covering element, then snapshot again.`
}
