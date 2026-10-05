import { createHash } from "node:crypto"
import type { DesktopDriver, DesktopBounds, DesktopNode, SnapshotData } from "./desktop-driver.ts"
import { OBSERVATION_CHARS, type DesktopCandidate, type DesktopObservation, type TextSlot } from "./gui-task-contract.ts"

// The offer set is pruned by property, never truncated to a count chosen by
// feel. The only real ceiling is the protocol's option count for one question,
// which this codebase already enforces in jev.ts; the operations that are
// always offered reserve the rest. Anything beyond the ceiling is reported in
// the observation, never silently dropped.
const MAX_QUESTION_OPTIONS = 255
const ALWAYS_OFFERED_OPERATIONS = 4
const MAX_OFFERED_ELEMENTS = MAX_QUESTION_OPTIONS - ALWAYS_OFFERED_OPERATIONS
// The only budgeted resource is the interface text the decision model reads. It
// is allocated here and never re-cut downstream, so the observation cannot be
// sliced mid-sentence by the state sanitizer.
// The element table is the interface; screen text is secondary context for it.
const CONTEXT_TEXT_SHARE = 0.15
const MAX_VISIBLE_TEXT = 32
const OVERLAY_ROLES = new Set(["sheet", "alert", "dialog", "menu", "popover"])

type FlatNode = DesktopNode & {
  path: string[]
  descendantSummary?: string
  siblingOrdinal?: number
  siblingCount?: number
  actionableAncestor?: { description: string; bounds?: DesktopBounds }
  /** Structural evidence, derived only from geometry and AX shape (never from
   * text): this node is one of several same-shaped siblings stacked
   * vertically, i.e. a repeated list row. */
  listRow?: { ordinal: number; count: number; inListContainer: boolean }
  /** Geometric facts for anonymous controls laid out in a horizontal cluster. */
  cluster?: { ordinal: number; count: number; sizeRank: number; centered: boolean }
  /** Text summaries of the nearest ancestors (nearest first). Used to tell
   * apart controls that share a label, such as one "Play" button per row. */
  ancestorText?: string[]
}

const LIST_CONTAINER_ROLES = new Set(["list", "table", "outline", "grid", "collection", "list_box", "listbox", "tree", "browser"])
const SCROLL_ACTIONS = ["Scroll", "ScrollDownByPage", "ScrollUpByPage", "scroll_down_by_page", "scroll_up_by_page"]

export async function observeDesktop(
  client: DesktopDriver,
  input: { app: string; windowId?: string; root?: string; goal?: string; textSlots: TextSlot[]; usedSlotIds: ReadonlySet<string>; allowPressEnter: boolean; skipMedia?: boolean },
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<DesktopObservation> {
  const base = ["snapshot", "--app", input.app, "--compact", "--include-bounds"]
  if (input.windowId) base.push("--window-id", input.windowId)
  // The tree stays local. Keeping inert descendants lets an unnamed actionable
  // parent inherit the visible text that identifies it before Jev sees candidates.
  const args = input.root ? [...base, "--root", input.root] : [...base, "--skeleton"]
  let snapshot = (await client.run<SnapshotData>(args, options)).data!

  if (!input.root) {
    const surface = findOverlay(snapshot.tree)
    if (surface && isModalOverlay(surface)) {
      // A modal sheet/alert blocks the window behind it: offering controls
      // under it invites clicks that silently do nothing. Scope candidates to
      // the overlay subtree (the xa11y worker has no --surface mode).
      snapshot = scopeToOverlay(snapshot)
    }
  }

  const nodes = flatten(snapshot.tree)
    .filter(node => node.ref_id && !(node.states ?? []).some(state => state === "disabled" || state === "hidden"))
  const actionableNodes = nodes.filter(hasSupportedCapability)
  // Prune structurally, never by relevance. A layout shell is an anonymous
  // wrapper whose controls live deeper; anonymous decoration is never a target.
  // What survives is every real control, in the tree's own reading order — the
  // order a person reads the screen, and the only order that cannot
  // systematically bury one control behind another. Ordering by inferred
  // relevance is what let a nameless control fall past a fixed cutoff.
  const shells = shellRefs(snapshot.tree)
  const elements = actionableNodes.filter(node => !isLayoutShell(node, shells) && !isDecoration(node)).slice(0, MAX_OFFERED_ELEMENTS)
  // Every element gets one index. The observation table and the per-target
  // questions both refer to it, so the detail lives in the state once instead
  // of being repeated for each candidate.
  const indexOf = new Map<string, number>()
  elements.forEach((node, index) => indexOf.set(node.ref_id as string, index + 1))
  const anchorValues = [...input.textSlots.map((slot: TextSlot) => slot.value), ...quotedGoalAnchors(input.goal ?? "")].filter(value => value.length > 0)
  const windowBounds = snapshot.tree.children?.find(node => node.role === "window")?.bounds
  const menu = !input.root && findOverlay(snapshot.tree) === undefined
    ? await readMenuBar(client, snapshot.window.title, options)
    : []
  let candidates = buildCandidates(elements, input.textSlots, input.usedSlotIds, Boolean(input.root), input.allowPressEnter, !snapshot.complete, windowBounds, findOverlay(snapshot.tree), input.goal ?? "", indexOf)
  candidates = addMenuCandidates(candidates, menu, input.goal ?? "")
  // Text slots add mutation candidates; they must never hide navigation or
  // activation candidates. The semantic layer decides whether a field is the
  // intended target after the user has identified the right surface.
  // The OS media fact is read once per real observation, never inside the
  // post-action settle polls (skipMedia); attachMedia completes those later.
  const mediaSkipped = Boolean(input.skipMedia)
  const media = input.skipMedia ? undefined : await readNowPlaying(client, options)
  const context = buildContext(
    snapshot,
    candidates,
    input.root,
    { observed: actionableNodes.length, pruned: actionableNodes.length - elements.length, offered: elements.length, kept: elements.length },
    media,
    nodes,
    anchorValues,
    elements,
    indexOf,
  )
  const treeFingerprint = createHash("sha256").update(JSON.stringify(nodes.map(node => ({
    role: node.role,
    name: node.name,
    description: node.description,
    value: visibleValue(node),
    states: node.states,
    actions: node.available_actions,
    childrenCount: node.children_count,
  })))).digest("hex")
  const fingerprint = combineFingerprint(treeFingerprint, media)
  return {
    app: snapshot.app,
    windowId: snapshot.window.id,
    title: snapshot.window.title,
    surface: findOverlay(snapshot.tree) ?? "window",
    root: input.root,
    snapshotId: snapshot.snapshot_id,
    complete: snapshot.complete,
    capturedAt: Date.now(),
    candidates,
    context,
    fingerprint,
    treeFingerprint,
    ...(media ? { media } : {}),
    ...(mediaSkipped ? { mediaSkipped } : {}),
    tree: snapshot.tree,
  }
}

type MenuItem = { path: string[]; enabled: boolean; shortcut?: string | null; checked?: boolean }
const MENU_TTL_MS = 5_000
const MAX_MENU_CANDIDATES = 120
const menuCache = new WeakMap<DesktopDriver, { title: string; at: number; items: MenuItem[] }>()

/** The application menu bar, cached per client for a few seconds and per
 * window title (enabled states follow the focused window's context). */
async function readMenuBar(client: DesktopDriver, title: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<MenuItem[]> {
  const cached = menuCache.get(client)
  if (cached && cached.title === title && Date.now() - cached.at < MENU_TTL_MS) return cached.items
  try {
    const data = (await client.run<{ items?: MenuItem[] }>(["menubar"], { timeoutMs: Math.min(options.timeoutMs, 3_000), signal: options.signal })).data
    const items = Array.isArray(data?.items) ? data!.items.filter(item => Array.isArray(item.path) && item.path.length >= 2) : []
    menuCache.set(client, { title, at: Date.now(), items })
    return items
  } catch {
    menuCache.set(client, { title, at: Date.now(), items: [] })
    return []
  }
}

/** Invalidate the cached menu bar (after any command that may change it). */
export function invalidateMenuCache(client: DesktopDriver): void {
  menuCache.delete(client)
}

/** Enabled menu commands become declared, labeled MENU_ITEM candidates.
 * Skipped: commands whose label a window control already offers (no
 * duplicate route), and quitting the target application. */
function addMenuCandidates(candidates: DesktopCandidate[], menu: MenuItem[], goal: string): DesktopCandidate[] {
  if (menu.length === 0) return candidates
  const windowLabels = new Set(candidates.filter(candidate => candidate.operation === "CLICK").map(candidate => /"([^"]+)"/.exec(candidate.criteria?.what ?? "")?.[1]).filter(Boolean) as string[])
  const tail = candidates.filter(candidate => ["WAIT", "DONE", "BLOCKED"].includes(candidate.operation))
  const head = candidates.filter(candidate => !tail.includes(candidate))
  const added: DesktopCandidate[] = []
  for (const item of menu) {
    if (added.length >= MAX_MENU_CANDIDATES) break
    const label = item.path.at(-1)!.replace(/[….]+$/, "").trim()
    if (!item.enabled || item.shortcut === "⌘Q" || windowLabels.has(label)) continue
    const path = item.path.join(" > ")
    const criteria: Record<string, string> = { what: `menu_item "${sanitize(item.path.at(-1)!, 80)}"`, where: `menu bar > ${sanitize(item.path.slice(0, -1).join(" > "), 120)}`, supports: "Press" }
    if (item.shortcut) criteria.shortcut = item.shortcut
    if (item.checked) criteria.state = "checked"
    if (item.path.some(segment => segment.replace(/[….]+$/, "").trim().length >= 2 && goal.includes(segment.replace(/[….]+$/, "").trim()))) criteria.goal_match = "menu path text appears in the goal"
    added.push({ id: "", operation: "MENU_ITEM", ref: `menu:${JSON.stringify(item.path)}`, menuPath: item.path, criteria, description: `menu command ${sanitize(path, 160)}${item.shortcut ? ` (${item.shortcut})` : ""}${item.checked ? "; checked" : ""}` })
  }
  return [...head, ...added, ...tail].map((candidate, index) => ({ ...candidate, id: `candidate-${index + 1}` }))
}

function combineFingerprint(tree: string, media: string | undefined): string {
  return createHash("sha256").update(JSON.stringify([tree, media ?? null])).digest("hex")
}

/** Complete an observation taken with skipMedia: insert the OS media fact
 * into its context header and recompute the combined fingerprint, so it is
 * indistinguishable from a regular observation. */
export function attachMedia(observation: DesktopObservation, media: string | undefined): DesktopObservation {
  if (!observation.mediaSkipped || !observation.treeFingerprint) return observation
  const { mediaSkipped: _skipped, ...rest } = observation
  const context = media ? observation.context.replace(/(candidates=\d+)/, `$1\n${media}`) : observation.context
  return { ...rest, context, ...(media ? { media } : {}), fingerprint: combineFingerprint(observation.treeFingerprint, media) }
}

export async function readMediaFact(client: DesktopDriver, options: { timeoutMs: number; signal?: AbortSignal }): Promise<string | undefined> {
  return readNowPlaying(client, options)
}

function flatten(root: DesktopNode): FlatNode[] {
  const result: FlatNode[] = []
  const visit = (node: DesktopNode, path: string[], siblingOrdinal?: number, siblingCount?: number, actionableAncestor?: FlatNode["actionableAncestor"], viewport?: DesktopBounds, structure: Pick<FlatNode, "listRow" | "cluster"> = {}, ancestorText: string[] = []) => {
    // AX keeps list rows below the fold "visible"; compare against the nearest
    // scroll container so pointer targets outside its viewport are scrolled
    // into view first instead of being clicked blindly.
    if (viewport && node.bounds && node.bounds.height > 0 && !(node.states ?? []).includes("offscreen")) {
      const center = node.bounds.y + node.bounds.height / 2
      if (center < viewport.y || center > viewport.y + viewport.height) node = { ...node, states: [...(node.states ?? []), "offscreen"] }
    }
    const scrollable = isScrollable(node)
    const nextViewport = scrollable && node.bounds?.height ? node.bounds : viewport
    const label = node.name ?? node.description
    const descendantSummary = summarizeDescendants(node)
    const self = label
      ? `${node.role} "${sanitize(label, 160)}"`
      : descendantSummary && hasPrimaryCapability(node)
        ? `${node.role} containing "${sanitize(descendantSummary, 100)}"`
        : node.role
    if (node.ref_id) result.push({ ...node, path, descendantSummary, siblingOrdinal, siblingCount, actionableAncestor, ...structure, ancestorText })
    const ownText = label ?? descendantSummary
    const nextAncestorText = ownText && node.role !== "window" && node.role !== "application" ? [ownText, ...ancestorText].slice(0, 3) : ancestorText
    const next = node.children?.length && path.at(-1) !== self ? [...path, self] : path
    const nextActionableAncestor = hasPrimaryCapability(node) && descendantSummary
      ? { description: self, bounds: node.bounds }
      : actionableAncestor
    const groups = groupSiblings(node.children ?? [])
    const children = node.children ?? []
    const inListContainer = scrollable || LIST_CONTAINER_ROLES.has(node.role.toLowerCase())
    const rows = detectListRows(children, inListContainer)
    const clusters = detectClusters(children)
    for (const [index, child] of children.entries()) {
      const siblings = groups.get(siblingIdentity(child))!
      visit(child, next, siblings.indexOf(index) + 1, siblings.length, nextActionableAncestor, nextViewport, { listRow: rows.get(index), cluster: clusters.get(index) }, nextAncestorText)
    }
  }
  visit(root, [], undefined, undefined, undefined, windowViewport(root))
  return result
}

/** The window frame is the initial viewport: an element whose center falls
 * outside it is offscreen by geometry alone. Apps that expose no page-scroll
 * action (Electron publishes AXScrollToVisible per element instead) otherwise
 * never produce an offscreen state, which silently disables SCROLL_TO. */
function windowViewport(root: DesktopNode): DesktopBounds | undefined {
  const queue: DesktopNode[] = [root]
  for (let index = 0; index < queue.length && index < 64; index++) {
    const node = queue[index]
    if (node.role === "window" && node.bounds) return node.bounds
    queue.push(...(node.children ?? []))
  }
  return undefined
}

function isScrollable(node: DesktopNode): boolean {
  return (node.available_actions ?? []).some(action => SCROLL_ACTIONS.includes(action))
}

/** A list row is proven by repetition, not by content: at least three siblings
 * with the same role and capabilities, near-equal size, the same left edge,
 * stacked vertically. Outside a scroll/list container, four are required.
 * A lone bar (toolbar, player, status strip) can never qualify. */
function detectListRows(children: DesktopNode[], inListContainer: boolean): Map<number, NonNullable<FlatNode["listRow"]>> {
  const result = new Map<number, NonNullable<FlatNode["listRow"]>>()
  const byShape = new Map<string, number[]>()
  for (const [index, child] of children.entries()) {
    const b = child.bounds
    if (!b || b.width <= 0 || b.height <= 0) continue
    const key = siblingIdentity(child)
    byShape.set(key, [...(byShape.get(key) ?? []), index])
  }
  for (const indices of byShape.values()) {
    // Cluster by near-equal geometry inside one capability group.
    const pending = [...indices]
    while (pending.length) {
      const seed = children[pending[0]].bounds!
      const same = pending.filter(index => {
        const b = children[index].bounds!
        return Math.abs(b.height - seed.height) <= Math.max(4, seed.height * 0.25)
          && Math.abs(b.width - seed.width) <= Math.max(8, seed.width * 0.15)
          && Math.abs(b.x - seed.x) <= 12
      })
      for (const index of same) pending.splice(pending.indexOf(index), 1)
      // Rows of one list are contiguous: split the stack wherever the gap to
      // the next item exceeds one row height, so a distant bar with the same
      // width can never join a list above it.
      const ordered = [...same].sort((a, b) => children[a].bounds!.y - children[b].bounds!.y)
      const runs: number[][] = []
      for (const index of ordered) {
        const run = runs.at(-1)
        const previous = run && children[run.at(-1)!].bounds!
        const current = children[index].bounds!
        const gap = previous ? current.y - (previous.y + previous.height) : Infinity
        if (run && gap >= -1 && gap <= Math.max(previous!.height, current.height)) run.push(index)
        else runs.push([index])
      }
      for (const run of runs) {
        if (run.length < (inListContainer ? 3 : 4)) continue
        run.forEach((index, position) => result.set(index, { ordinal: position + 1, count: run.length, inListContainer }))
      }
    }
  }
  return result
}

/** Horizontal clusters of small sibling controls (toolbars, transport bars,
 * tab strips). Only geometry is reported; Jev applies general UI knowledge
 * such as "the primary control is usually the largest, centered one". */
function detectClusters(children: DesktopNode[]): Map<number, NonNullable<FlatNode["cluster"]>> {
  const result = new Map<number, NonNullable<FlatNode["cluster"]>>()
  const items = [...children.entries()].filter(([, child]) => child.bounds && child.bounds.width > 0 && child.bounds.height > 0 && child.bounds.height <= 96 && child.bounds.width <= 160)
  if (items.length < 2 || items.length > 16) return result
  const centerY = (b: DesktopBounds) => b.y + b.height / 2
  const seedY = centerY(items[0][1].bounds!)
  const row = items.filter(([, child]) => Math.abs(centerY(child.bounds!) - seedY) <= Math.max(8, child.bounds!.height / 2))
  if (row.length < 2) return result
  row.sort((a, b) => a[1].bounds!.x - b[1].bounds!.x)
  const areas = row.map(([, child]) => child.bounds!.width * child.bounds!.height)
  const sortedAreas = [...new Set(areas)].sort((a, b) => b - a)
  const left = row[0][1].bounds!.x
  const right = row.at(-1)![1].bounds!.x + row.at(-1)![1].bounds!.width
  const middle = (left + right) / 2
  row.forEach(([index, child], position) => {
    const b = child.bounds!
    const centered = Math.abs(b.x + b.width / 2 - middle) <= Math.max(b.width / 2, 6)
    result.set(index, { ordinal: position + 1, count: row.length, sizeRank: sortedAreas.indexOf(areas[position]) + 1, centered })
  })
  return result
}

function groupSiblings(children: DesktopNode[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (const [index, child] of children.entries()) {
    const identity = siblingIdentity(child)
    const indices = groups.get(identity) ?? []
    indices.push(index)
    groups.set(identity, indices)
  }
  return groups
}

function siblingIdentity(node: DesktopNode): string {
  const capabilities = (node.available_actions ?? [])
    .filter(action => !["RightClick", "ScrollTo", "SetFocus"].includes(action))
    .sort()
  return `${node.role}:${capabilities.join(",")}`
}

function buildCandidates(nodes: FlatNode[], slots: TextSlot[], used: ReadonlySet<string>, insideRoot: boolean, allowPressEnter: boolean, allowDrill: boolean, windowBounds: DesktopBounds | undefined, overlay: string | undefined, goal: string, indexOf: ReadonlyMap<string, number>): DesktopCandidate[] {
  const candidates: DesktopCandidate[] = []
  const nextSlot = nextTextSlot(nodes, slots, used)
  let display: Record<string, string> | undefined
  let stable: Record<string, string | number> | undefined
  const add = (candidate: Omit<DesktopCandidate, "id">) => {
    candidates.push({ ...candidate, ...(display ? { criteria: display } : {}), ...(stable ? { identity: stable } : {}), id: `candidate-${candidates.length + 1}` })
  }
  // Wrapper elements whose label belongs to a specific named control inside
  // them are inert targets: pressing the wrapper does nothing, and offering it
  // lets the wrapper win the choice about half the time (upstream offerable()
  // withholds exactly these). Withhold wrapper clicks when a same-named
  // button/link advertises the action itself.
  // Controls sharing one label (a "Play" button in every row) are only
  // distinguishable by the item that contains them. Attach the nearest
  // ancestor text that differs between them.
  const labelCounts = new Map<string, number>()
  for (const node of nodes) {
    const label = (node.name ?? node.description ?? "").trim()
    if (label) labelCounts.set(`${node.role}:${label}`, (labelCounts.get(`${node.role}:${label}`) ?? 0) + 1)
  }
  const itemContext = (node: FlatNode): string | undefined => {
    const label = (node.name ?? node.description ?? "").trim()
    if (!label || (labelCounts.get(`${node.role}:${label}`) ?? 0) < 2) return undefined
    const context = node.ancestorText?.find(text => text.trim() && text.trim() !== label)
    return context ? sanitize(context.split(" · ").filter(part => part.trim() !== label).join(" · "), 60) : undefined
  }
  for (const node of nodes) {
    // A top-level window is not a content target, but activating it is a real
    // prerequisite when the agent process itself owns the foreground. Keep a
    // single explicit ACTIVATE candidate instead of exposing the window as a
    // generic CLICK target.
    if (node.role === "window" && node.children_count) {
      // Every macOS AX window can be activated through its owning app. The
      // normalized tree may expose this action under a platform-specific
      // spelling, so do not make the activation candidate depend on that
    // spelling surviving normalization.
      display = candidateCriteria(node, slots, indexOf.get(node.ref_id as string) ?? 0)
      stable = candidateIdentity(node)
      add({ operation: "ACTIVATE", headed: false, description: `${describeNode(node)}; bring this application to the foreground before interacting with its content` })
      continue
    }
    if (node.role === "application" && node.children_count) continue
    const ref = node.ref_id!
    const actions = new Set(node.available_actions ?? [])
    const inItem = itemContext(node)
    const descriptor = describeNode(node)
    display = candidateCriteria(node, slots, indexOf.get(node.ref_id as string) ?? 0)
    stable = candidateIdentity(node)
    if (inItem) display.in_item = inItem
    // Local fact: the element's own label occurs verbatim in the goal.
    const ownLabel = (node.name ?? node.description ?? "").trim()
    if (ownLabel.length >= 2 && goal.includes(ownLabel)) display.goal_match = "label appears in the goal"
    const webContent = node.path.some(part => /^web_?area\b/.test(part))
    const offscreen = (node.states ?? []).includes("offscreen")
    if (offscreen && (hasClickAction(actions) || actions.has("SetValue") || actions.has("TypeText") || (actions.has("SetFocus") && node.children_count))) {
      add({ operation: "SCROLL_TO", ref, headed: false, description: `${descriptor}; bring this observed target into the visible viewport before choosing its action` })
      continue
    }
    const passiveText = ["static_text", "label", "text"].includes(node.role.toLowerCase())
    if (actions.has("SetFocus") && !hasClickAction(actions) && !passiveText && !isEditableTextRole(node.role, node) && node.bounds && node.bounds.width > 0 && node.bounds.height > 0 && node.role !== "button" && node.role !== "link") {
      const semanticItem = ["table_cell", "list_item", "row", "group"].includes(node.role.toLowerCase()) && Boolean(node.children_count)
      if (semanticItem && actions.has("Activate")) {
        add({ operation: "ACTIVATE", ref, headed: false, description: `${descriptor}; activate this observed list item through its AX semantic action` })
      } else if (!node.children_count) {
        // A leaf nested in a focus-only list row is not a stable pointer
        // target during list refreshes. Keep physical delivery as a local
        // fallback only after the row has been drilled into.
        if (insideRoot) add({ operation: "CLICK", ref, headed: true, evidence: "geometric", speculative: true, description: `${descriptor}; physical pointer click at this leaf element's observed bounds (no declared action; verify the effect)` })
      } else if (semanticItem) {
        // A focus-only list row is a container, not an action. With a complete
        // tree its actionable descendants are already offered as elements, so
        // there is nothing left to discover by inspecting it; drilling is only
        // meaningful when the observation was truncated and part of the tree is
        // genuinely missing. Physical pointer delivery is offered when
        // repetition structurally proves the node is a list row.
        if (allowDrill) {
          add({ operation: "DRILL", ref, headed: false, description: `${descriptor}; inspect this focus-only container for its actionable children` })
        }
        const identified = Boolean(node.name || node.description || node.descendantSummary)
        if (node.listRow && identified) {
          add({ operation: "FOCUS", ref, headed: false, description: `${descriptor}; focus this list row before submitting the platform default action` })
          add({ operation: "CLICK", ref, headed: true, evidence: "structural", speculative: true, expect: ["no_overlay"], description: `${descriptor}; select this structural list row with one verified physical click` })
          add({ operation: "DOUBLE_CLICK", ref, headed: true, evidence: "structural", speculative: true, expect: ["no_overlay"], description: `${descriptor}; open this structural list row with a verified physical double-click` })
        }
      }
    }
    if (actions.has("SetFocus") && !hasClickAction(actions) && !passiveText && !node.children_count && !isEditableTextRole(node.role, node)) {
      add({ operation: "FOCUS", ref, headed: false, description: `${descriptor}; focus the observed accessibility element without activating it` })
    }
    if (hasClickAction(actions) && !isEditableTextRole(node.role, node)) {
      // Gesture follows shape: a LEAF pressable is a button (single click);
      // an anonymous pressable CONTAINER is a list row or card, whose desktop
      // gesture is a double-click — its inner controls (like, links, more) are
      // separate targets with their own routes. Named containers keep the
      // semantic press. Without this split the model either clicks the row's
      // fragments (and can never open the row) or drowns in wrapper options.
      // A row/card is a wide, short band: an icon button inside a transparent
      // wrapper has the same "anonymous group with a child" shape but a
      // square-ish frame, and its gesture stays a single click. The ratio is
      // shape semantics (wide and short), not a tuned scenario constant.
      const bounds = node.bounds
      const wideBand = Boolean(bounds) && bounds!.width >= bounds!.height * 3 && bounds!.width >= 200
      const rowLike = Boolean(node.children_count) && !node.name && !node.description && !visibleValue(node) && wideBand
      if (rowLike) {
        add({ operation: "DOUBLE_CLICK", ref, headed: true, evidence: "structural", speculative: true, expect: ["no_overlay"], description: `${descriptor}; double-click this row or card to open or play it` })
      } else {
        // One target, one candidate. Delivery is a code decision, not a rival
        // option: two deliveries for the same element split the choice and read
        // as doubt, which is what a decision model measures as low confidence.
        add({ operation: "CLICK", ref, headed: false, description: `${descriptor}; delivery=semantic accessibility press, then exact-window pointer delivery when it produces no visible change` })
      }
      if (webContent && node.role === "group" && !node.name && !node.description && node.listRow) {
        add({ operation: "DOUBLE_CLICK", ref, headed: true, evidence: "structural", speculative: true, expect: ["no_overlay"], description: `${descriptor}; activate this observed list item itself with two rapid verified pointer clicks` })
      }
    }
    // A context menu is the route to an action the app did not expose as a
    // control. Nearly every element in web content advertises one, so offering
    // it beside a primary action multiplies the offer set without adding a
    // reachable outcome. It is offered only where the element is a discrete
    // item a menu could belong to: the app named it, or repetition proved it is
    // a list row. A summary of descendant text does not qualify — almost every
    // container has one.
    const identifiable = Boolean(node.name || node.description || node.listRow)
    if (actions.has("RightClick") && identifiable) {
      add({ operation: "RIGHT_CLICK", ref, headed: false, description: `${descriptor}; open this item's context menu` })
    }
    if (actions.has("Toggle")) {
      add({ operation: "CHECK", ref, description: descriptor })
      add({ operation: "UNCHECK", ref, description: descriptor })
    }
    if (actions.has("Expand")) add({ operation: "EXPAND", ref, description: descriptor })
    if (actions.has("Collapse")) add({ operation: "COLLAPSE", ref, description: descriptor })
    const pane = node.bounds && windowBounds?.width
      ? `; ${((node.bounds.x + node.bounds.width / 2 - windowBounds.x) / windowBounds.width) < 0.4 ? "leading" : "trailing"} pane of this window`
      : ""
    if (actions.has("Scroll") || actions.has("ScrollDownByPage")) {
      add({ operation: "SCROLL_DOWN", ref, description: `${descriptor}${pane}; reveal later content in this scrollable region` })
    }
    if (actions.has("Scroll") || actions.has("ScrollUpByPage")) {
      add({ operation: "SCROLL_UP", ref, description: `${descriptor}${pane}; reveal earlier content in this scrollable region` })
    }
    // Clearing a non-empty field is a standalone generic goal ("empty the
    // search box") and needs no caller-prepared text (AXValue = "").
    if (isEditableTextRole(node.role, node) && actions.has("SetValue") && !(node.states ?? []).includes("secure") && typeof node.value === "string" && node.value.length > 0) {
      add({ operation: "CLEAR", ref, description: `${descriptor}; empty this field` })
    }
    // Keep every eligible editable field as a candidate. Field-purpose
    // disambiguation belongs to the semantic decision layer, not this
    // application-agnostic AX normalization layer.
    if (nextSlot && isEditableTextRole(node.role, node) && !(node.states ?? []).includes("secure")) {
      const purpose = sanitize(nextSlot.description, 180)
      const hasCurrentValue = typeof node.value === "string" && node.value.length > 0
      // Multi-line caller text must never go through physical typing: the
      // embedded newline presses Return and can send an unfinished message.
      // The semantic value route inserts the text verbatim instead.
      const multiline = nextSlot.value.includes("\n")
      // Prefer physical/event-driven typing only when the observed field
      // actually advertises TypeText. Native text areas such as WeChat's
      // composer may expose SetValue alone and must keep that safe semantic
      // route available.
      const eventDrivenField = webContent || (actions.has("TypeText") && ["textfield", "textarea", "searchfield", "textbox", "editabletext"].includes(node.role.toLowerCase().replace(/[\s_-]/g, "")))
      if (actions.has("SetValue") && (!eventDrivenField || multiline)) add({ operation: "SET_VALUE", ref, slotId: nextSlot.id, expect: ["value_equals"], description: `${descriptor}; replace with caller-prepared text for ${purpose}` })
      // Electron controls can expose SetValue while the renderer only reacts
      // to keyboard input events. Offer a headed typing route explicitly;
      // the native driver still validates the live target before delivery.
      if (webContent && actions.has("SetValue") && !multiline) {
        add({ operation: "TYPE_TEXT", ref, slotId: nextSlot.id, headed: true, description: `${descriptor}; enter caller-prepared text for ${purpose}; delivery=exact-window physical keyboard` })
      }
      if (!webContent && !actions.has("SetValue") && !actions.has("TypeText") && actions.has("SetFocus")) {
        add({ operation: "FOCUS", ref, headed: false, description: `${descriptor}; focus this text field before entering text` })
      }
      if (actions.has("TypeText") && !hasCurrentValue && !multiline) {
        add({ operation: "TYPE_TEXT", ref, slotId: nextSlot.id, expect: ["value_equals"], headed: webContent, description: `${descriptor}; enter caller-prepared text for ${purpose}; delivery=${webContent ? "exact-window physical keyboard" : "semantic text input"}` })
      }
    }
    const hasIdentity = Boolean(node.name || node.description || visibleValue(node) || node.native_id?.value)
    // Drilling exists to re-observe a subtree that the walk truncated. On a
    // complete observation every actionable descendant is already an element,
    // so an inspection candidate would only narrow the model's view.
    const alreadyDrillable = candidates.some(candidate => candidate.operation === "DRILL" && candidate.ref === ref)
    if (!alreadyDrillable && allowDrill && node.children_count && node.children_count > 0 && (!hasIdentity || !actions.has("Click"))) {
      add({ operation: "DRILL", ref, description: descriptor })
    }
  }
  display = undefined
  stable = undefined
  // Structural invariant: one candidate per (target, operation). Two routes
  // for the same element is option-level overlap that reads as doubt to a
  // decision model — enforce it here so no branch can double-offer.
  const seen = new Set<string>()
  const unique = candidates.filter(candidate => {
    const key = `${candidate.operation}:${candidate.ref ?? candidate.description}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // Return submits whatever the focused field holds. It is a real option
  // both right after this task typed text and whenever the focused editable
  // field already contains text (e.g. a draft left in a chat composer).
  const focusedDraft = nodes.find(node => isEditableTextRole(node.role, node) && (node.states ?? []).includes("focused") && typeof node.value === "string" && node.value.trim().length > 0)
  if (allowPressEnter || focusedDraft) {
    const where = focusedDraft ? ` in ${describeNode(focusedDraft).split(";")[0]} which currently holds text` : ""
    add({ operation: "PRESS_ENTER", description: `Press Return to submit the text in the focused field${where}.` })
  }
  if (overlay) add({ operation: "DISMISS", description: `Press Escape to close the open ${overlay} without choosing any of its items.` })
  if (insideRoot) add({ operation: "WIDEN", description: "Return from the current drilled region to the whole window." })
  add({ operation: "WAIT", description: "Wait briefly and obtain a fresh accessibility observation without mutating the app." })
  add({ operation: "DONE", description: "Every part of the user's goal is visibly satisfied in the current observation." })
  add({ operation: "BLOCKED", description: "No offered operation can safely make progress toward the goal." })
  return unique
}

/** Structured identity criteria, following the upstream act.mjs describe():
 * structured criteria disambiguate better than a flat sentence, and pointer
 * position is spent only on an element with no name, no description and no
 * value. Operation semantics stay out of these fields. */
function candidateCriteria(node: FlatNode, slots: TextSlot[] = [], index = 0): Record<string, string> {
  const label = node.name ?? node.description
  const derived = !label ? node.descendantSummary : undefined
  const embedded = !label && !derived && node.actionableAncestor
  // One short line per target. The element's full detail belongs in the
  // observation once; repeating it per candidate is what made a dense window
  // impossible to describe inside the request budget.
  const criteria: Record<string, string> = {
    what: `${index ? `[${index}] ` : ""}${node.role}${label ? ` "${sanitize(label, 60)}"` : derived ? ` containing "${sanitize(derived, 46)}"` : embedded ? " embedded control" : ""}`,
  }
  const value = visibleValue(node)
  if (value) criteria.holds = sanitize(value, 60)
  if ((node.siblingCount ?? 0) > 1) criteria.sibling = `${node.siblingOrdinal}/${node.siblingCount}`
  const structure = structuralFacts(node)
  if (structure) criteria.where = structure
  const haystack = `${node.name ?? ""} ${node.description ?? ""} ${value ?? ""}`
  const matchingSlot = slots.find(slot => slot.value.length > 0 && haystack.includes(slot.value))
  if (matchingSlot) criteria.local_match = `prepared text for ${sanitize(matchingSlot.description, 60)}`
  if (!label && !derived && !value && node.bounds) criteria.at = `${Math.round(node.bounds.x)},${Math.round(node.bounds.y)}`
  return criteria
}

/** Re-identification of a target, kept out of the model-facing criteria so that
 * making that view terser cannot destabilise quarantine, the risk cache or
 * affordance memory. Only properties the tree actually exposes are used, so the
 * same element yields the same key across snapshots of one application. */
function candidateIdentity(node: FlatNode): Record<string, string | number> {
  const label = node.name ?? node.description
  const value = visibleValue(node)
  const identity: Record<string, string | number> = { role: node.role }
  if (label) identity.label = sanitize(label, 120)
  else if (node.descendantSummary) identity.contains = sanitize(node.descendantSummary, 120)
  if (value) identity.holds = sanitize(value, 120)
  if (node.listRow) identity.row = `${node.listRow.ordinal}/${node.listRow.count}`
  if (node.cluster) identity.cluster = `${node.cluster.ordinal}/${node.cluster.count}#${node.cluster.sizeRank}`
  if ((node.siblingCount ?? 0) > 1) identity.sibling = `${node.siblingOrdinal}/${node.siblingCount}`
  if ((node.states ?? []).includes("offscreen")) identity.offscreen = 1
  if (!label && !node.descendantSummary && !value && node.bounds) identity.at = `${Math.round(node.bounds.x)},${Math.round(node.bounds.y)}`
  return identity
}

function nextTextSlot(_nodes: FlatNode[], slots: TextSlot[], used: ReadonlySet<string>): TextSlot | undefined {
  // A field that already displays the slot value (left over from an earlier
  // session) has not been submitted by this task. Only slots this task has
  // actually delivered count as consumed; otherwise the field would vanish
  // from the candidate space entirely.
  return slots.find(slot => !used.has(slot.id))
}

function hasSupportedCapability(node: FlatNode): boolean {
  const actions = new Set(node.available_actions ?? [])
  return Boolean(node.children_count) || ["Click", "Activate", "SetFocus", "Toggle", "Expand", "Collapse", "Scroll", "SetValue", "TypeText", "RightClick"].some(action => actions.has(action))
}

function hasPrimaryCapability(node: DesktopNode): boolean {
  const actions = new Set(node.available_actions ?? [])
  return ["Click", "Activate", "SetFocus", "Toggle", "Expand", "Collapse", "Scroll", "SetValue", "TypeText"].some(action => actions.has(action))
}

function hasClickAction(actions: Set<string>): boolean {
  return actions.has("Click") || actions.has("Activate")
}

/** Capabilities that make an element a control rather than decoration. Focus
 * roaming is excluded on purpose: toolkits expose it on nearly every node, so
 * it cannot distinguish a real control from the layout box around it. */
const CONTROL_ACTIONS = ["Click", "Activate", "Toggle", "Expand", "Collapse", "SetValue", "TypeText"]

function hasControlCapability(node: DesktopNode): boolean {
  const actions = new Set(node.available_actions ?? [])
  return CONTROL_ACTIONS.some(action => actions.has(action))
}

/** Refs of nodes that contain a pressable control somewhere below them. Such a
 * node is a layout shell: the control, not the shell, is the target. */
function shellRefs(root: DesktopNode): Set<string> {
  const shells = new Set<string>()
  const visit = (node: DesktopNode): boolean => {
    let contains = false
    for (const child of node.children ?? []) {
      const control = hasControlCapability(child)
      const deeper = visit(child)
      if (control || deeper) contains = true
    }
    if (contains && node.ref_id) shells.add(node.ref_id)
    return contains || hasControlCapability(node)
  }
  visit(root)
  return shells
}

/** An anonymous wrapper whose controls live deeper. Offering it as a target
 * lets it win the choice about half the time and hides the real control; its
 * children are offered directly instead (upstream `offerable()` withholds
 * exactly these). */
function isLayoutShell(node: FlatNode, shells: ReadonlySet<string>): boolean {
  // A container that declares its own press can be the target itself — list
  // rows are opened by double-clicking the row, not one of its controls. Only
  // a NON-pressable anonymous wrapper is pure layout.
  if (hasClickAction(new Set(node.available_actions ?? []))) return false
  if (node.name || node.description || visibleValue(node)) return false
  return Boolean(node.ref_id && shells.has(node.ref_id))
}

/** Anonymous decoration with no action of its own: an image or text leaf that
 * cannot be a target. Its text already travels as observed text. */
function isDecoration(node: FlatNode): boolean {
  return !node.name && !node.description && !visibleValue(node) && !hasControlCapability(node) && !node.children_count
}

/** Observed structure and geometry only; never an inferred purpose. */
function structuralFacts(node: FlatNode): string | undefined {
  const facts: string[] = []
  if (node.listRow) facts.push(`row ${node.listRow.ordinal}/${node.listRow.count}${node.listRow.inListContainer ? " in list" : ""}`)
  if (node.cluster) facts.push(`cluster ${node.cluster.ordinal}/${node.cluster.count}${node.cluster.centered ? " center" : ""} size-rank ${node.cluster.sizeRank}`)
  if (node.cluster && node.bounds && node.bounds.width > 0) facts.push(`${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)}`)
  return facts.length ? facts.join(" ") : undefined
}

function describeNode(node: FlatNode): string {
  const label = node.name ?? node.description
  const derived = !label ? node.descendantSummary : undefined
  const embedded = !label && !derived && node.actionableAncestor
  const parts = [`${node.role}${label ? ` "${sanitize(label, 120)}"` : derived ? ` containing "${sanitize(derived, 90)}"` : embedded ? " embedded control" : ""}`]
  const value = visibleValue(node)
  if (value) parts.push(`holds "${sanitize(value, 120)}"`)
  if (node.states?.length) parts.push(`state=${node.states.join(",")}`)
  const path = node.path.slice(-5).join(" > ")
  if (path && !label && !derived) parts.push(`inside ${sanitize(path, 120)}`)
  if ((node.siblingCount ?? 0) > 1) parts.push(`item ${node.siblingOrdinal} of ${node.siblingCount} among sibling ${node.role} elements with the same capabilities`)
  if (node.children_count) parts.push(`contains ${childrenFact(node)}`)
  const structure = structuralFacts(node)
  if (structure) parts.push(structure)
  if (embedded && node.bounds && node.actionableAncestor?.bounds?.width) {
    const position = Math.round(((node.bounds.x + node.bounds.width / 2 - node.actionableAncestor.bounds.x) / node.actionableAncestor.bounds.width) * 100)
    const placement = position <= 25 ? "leading" : position >= 75 ? "trailing" : "middle"
    parts.push(`${placement} embedded control at horizontal position ${position}% within ${sanitize(node.actionableAncestor.description, 140)}`)
  }
  if (!label && !derived && !value && node.bounds) parts.push(`at ${Math.round(node.bounds.x)},${Math.round(node.bounds.y)}`)
  return parts.join("; ").slice(0, 360)
}

/** "N items not shown" is only true when the observation truncated the
 * children. When they were observed (and listed as their own candidates),
 * saying so stops Jev from scrolling a fully visible list to "reveal" them. */
function childrenFact(node: DesktopNode): string {
  const observed = node.children?.length ?? 0
  const total = node.children_count ?? 0
  if (observed >= total && total > 0) return `${total} items, all observed`
  if (observed > 0) return `${total} items (${observed} observed, ${total - observed} not shown)`
  return `${total} items not shown`
}

function summarizeDescendants(node: DesktopNode): string | undefined {
  const values: string[] = []
  const visit = (current: DesktopNode) => {
    if (values.length >= 4) return
    const value = current.name ?? current.description ?? visibleValue(current)
    // Image sources and asset paths are not user-visible identity.
    const meaningful = value && current.role !== "image" && !/^(?:\/|https?:|data:)|\.(?:jpe?g|png|webp|gif|svg)(?:$|[?~])/i.test(value.trim())
    if (meaningful && !values.includes(value)) values.push(value)
    for (const child of current.children ?? []) visit(child)
  }
  for (const child of node.children ?? []) visit(child)
  return values.length ? values.join(" · ") : undefined
}

function visibleValue(node: DesktopNode): string | undefined {
  if (!node.value || (node.states ?? []).includes("secure") || node.role.toLowerCase() === "securetextfield") return undefined
  if (node.value === node.name || node.value === node.description) return undefined
  return node.value
}

function isEditableTextRole(role: string, node?: DesktopNode): boolean {
  const normalized = role.toLowerCase().replace(/[\s_-]/g, "")
  if (["textfield", "textarea", "searchfield", "textbox", "editabletext"].includes(normalized)) return true
  // An editable combo box (autocomplete input) accepts text like a field.
  return normalized === "combobox" && Boolean(node && (node.states ?? []).includes("editable") && (node.available_actions ?? []).includes("SetValue"))
}

/** OS media-session fact (title/artist/playing). App-agnostic, read-only, and
 * the only reliable playback evidence when transport controls are unlabeled. */
async function readNowPlaying(client: DesktopDriver, options: { timeoutMs: number; signal?: AbortSignal }): Promise<string | undefined> {
  try {
    const data = (await client.run<{ available?: boolean; title?: string; artist?: string; album?: string; playing?: boolean | null }>(["now-playing"], { timeoutMs: Math.min(options.timeoutMs, 5_000), signal: options.signal })).data
    if (!data?.available || !data.title) return undefined
    const state = data.playing === true ? "playing" : data.playing === false ? "paused" : "unknown"
    return `system_now_playing: title="${sanitize(data.title, 120)}"${data.artist ? ` artist="${sanitize(data.artist, 120)}"` : ""} state=${state}`
  } catch {
    return undefined
  }
}

function quotedGoalAnchors(goal: string): string[] {
  return [...goal.matchAll(/[“「『"]([^”」』"]{2,120})[”」』"]/g)].map(match => match[1])
}

/** One line per offered candidate. The structured criteria travel separately
 * as the choice payload, so this text is only the human-readable interface Jev
 * reads; keeping it terse is what lets the whole offer set fit the text budget
 * instead of the offer set being cut to fit the text. */
function compactCandidate(candidate: DesktopCandidate): string {
  const criteria = candidate.criteria ?? {}
  const what = criteria.what ?? candidate.description.split(";")[0]
  const parts = [candidate.operation.toLowerCase(), what]
  if (criteria.holds) parts.push(`holds ${criteria.holds}`)
  if (criteria.where) parts.push(criteria.where)
  if (criteria.in_item) parts.push(`in ${criteria.in_item}`)
  if (criteria.at) parts.push(`at ${criteria.at}`)
  return parts.join(" · ").slice(0, 200)
}

/** One line per element: the model's whole view of what it can act on here, in
 * reading order, with the operations available on it. Every target question
 * repeats only the `[index]` reference from this table, never the detail; that
 * is what keeps a dense window describable inside one request. */
function elementLine(node: FlatNode, index: number, operations: readonly string[]): string {
  const label = node.name ?? node.description
  const derived = !label ? node.descendantSummary : undefined
  const parts = [`[${index}] ${node.role}${label ? ` "${sanitize(label, 60)}"` : derived ? ` containing "${sanitize(derived, 46)}"` : ""}`]
  const value = visibleValue(node)
  if (value) parts.push(`holds "${sanitize(value, 40)}"`)
  if (isEditableTextRole(node.role, node)) parts.push("editable")
  if ((node.states ?? []).includes("offscreen")) parts.push("offscreen")
  if ((node.siblingCount ?? 0) > 1) parts.push(`${node.siblingOrdinal}/${node.siblingCount}`)
  const structure = structuralFacts(node)
  if (structure) parts.push(structure)
  if (!label && !derived && node.bounds) parts.push(`at ${Math.round(node.bounds.x)},${Math.round(node.bounds.y)}`)
  if (operations.length) parts.push(operations.map(operation => operation.toLowerCase()).join(","))
  return parts.join(" · ").slice(0, 200).replace(/[\uD800-\uDFFF]/gu, chunk => (chunk.codePointAt(0) ?? 0) > 0xffff ? chunk : "\uFFFD")
}

function buildContext(
  snapshot: SnapshotData,
  candidates: DesktopCandidate[],
  root: string | undefined,
  stats: { observed: number; pruned: number; offered: number; kept: number },
  media?: string,
  nodes: FlatNode[] = [],
  anchors: string[] = [],
  elements: FlatNode[] = [],
  indexOf: ReadonlyMap<string, number> = new Map(),
): string {
  const operationsByRef = new Map<string, string[]>()
  for (const candidate of candidates) {
    if (!candidate.ref) continue
    const list = operationsByRef.get(candidate.ref) ?? []
    if (!list.includes(candidate.operation)) list.push(candidate.operation)
    operationsByRef.set(candidate.ref, list)
  }
  const header = [
    `app=${snapshot.app}`,
    `window=${snapshot.window.title}`,
    `scope=${root ? "drilled region" : "full local accessibility tree"}`,
    `complete=${snapshot.complete}`,
    // Pruning and the safety net are reported instead of silent, so a control
    // missing from the table is diagnosable from the observation alone.
    `elements=${stats.observed} pruned=${stats.pruned} offered=${stats.offered}${stats.kept < stats.offered ? ` safety_cap_applied=${stats.offered - stats.kept}` : ""}`,
    `candidates=${candidates.filter(candidate => candidate.ref).length}`,
    ...(media ? [media] : []),
  ].join("\n")
  // Elements are never dropped from the table to fit the budget: a table that
  // omits a control is the defect this shape exists to prevent. The screen text
  // shrinks first and an overflow is reported rather than hidden. Only elements
  // that actually carry an operation are listed: an entry the model cannot act
  // on is noise, and its index stays unique even when neighbours are omitted.
  const actionableRefs = new Set([...operationsByRef.keys()])
  const table = elements
    .filter(node => node.ref_id && actionableRefs.has(node.ref_id))
    .map(node => elementLine(node, indexOf.get(node.ref_id as string) ?? 0, operationsByRef.get(node.ref_id as string) ?? []))
    .join("\n")
  const matches = nodes.filter(node => {
    const text = `${node.name ?? ""} ${node.description ?? ""} ${visibleValue(node) ?? ""}`
    return anchors.some(anchor => text.includes(anchor))
  }).slice(0, 12).map(node => `${node.role} ${sanitize(node.name ?? node.description ?? visibleValue(node) ?? "", 120)} in ${sanitize(node.path.join(" > "), 180)}`)
  const evidence = matches.length ? `\nobserved_goal_matches:\n${matches.map((value, index) => `${index + 1}. ${value}`).join("\n")}` : ""
  const room = OBSERVATION_CHARS - header.length - table.length - evidence.length - 4
  const textLines: string[] = []
  if (room > 0) {
    let textUsed = evidence.length
    const textBudget = Math.floor(OBSERVATION_CHARS * CONTEXT_TEXT_SHARE)
    for (const value of collectVisibleText(snapshot.tree).slice(0, MAX_VISIBLE_TEXT)) {
      if (textUsed + value.length + 1 > textBudget) break
      textLines.push(`${textLines.length + 1}. ${value}`)
      textUsed += value.length + 1
    }
  }
  const textBlock = `${evidence}${textLines.length ? `\nobserved_text:\n${textLines.join("\n")}` : ""}`
  const overflow = room > 0 ? "" : ` table_over_budget=${table.length + header.length - OBSERVATION_CHARS}`
  // The table is labelled so the list of what can be acted on is never confused
  // with the text that happens to be on screen.
  return `${header}${overflow}${textBlock}${table ? `\nelements:\n${table}` : ""}`
}

function collectVisibleText(root: DesktopNode): string[] {
  const values: string[] = []
  const visit = (node: DesktopNode) => {
    const role = node.role.toLowerCase()
    const value = visibleValue(node) ?? node.name ?? node.description
    if (value && (role === "static_text" || role === "label" || role === "text") && !values.includes(value)) values.push(sanitize(value, 240))
    for (const child of node.children ?? []) {
      if (values.length >= 64) return
      visit(child)
    }
  }
  visit(root)
  return values
}

/** How likely a node is to be the target of a goal, as an ordinal rank rather
 * than a weight. A scalar made the levels negotiable: independent conditions
 * added up, so a container could accumulate a lower score than an editable
 * field by accident and push the field out of the readable list. Levels are
 * strict predicates here, and no combination of the tie-breakers below can
 * overturn a higher level.
 *
 * Only properties the accessibility tree actually exposes are used, so the same
 * order applies to any application: nothing here names an app, a role set that
 * one toolkit happens to use, or a coordinate. */
function relevanceRank(node: FlatNode, shells: ReadonlySet<string>): number {
  const actions = new Set(node.available_actions ?? [])
  // The only node that can consume the next prepared text is the field itself.
  const editable = isEditableTextRole(node.role, node) && (node.states ?? []).includes("editable")
  // The innermost pressable element is the control, whether or not the app
  // named it. A wrapper that merely contains controls is not a target: it would
  // compete with the control inside it and dilute the choice.
  const control = hasClickAction(actions) && !(node.ref_id && shells.has(node.ref_id))
  const primary = hasPrimaryCapability(node)
  const named = Boolean(node.name || node.description || visibleValue(node))
  // A large unlabelled region is where later inspection finds its controls.
  const structural = ["split_group", "group"].includes(node.role.toLowerCase()) && (node.children_count ?? 0) >= 5
  if (editable) return 0
  if (control && named) return 1
  if (control) return 2
  if (primary && named) return 3
  if (named || structural) return 4
  return 5
}

/** Lexicographic relevance order. Ties are broken by observed facts in
 * priority order, each one a boolean rather than a delta: a node whose text
 * matches the goal or the prepared value first, then what is on screen before
 * what is not, then a scroll region before a plain container, then a named node
 * before an anonymous one, and finally the tree's own order, which is stable
 * and therefore reproducible across runs. */
function compareRelevance(left: FlatNode, right: FlatNode, anchors: string[], shells: ReadonlySet<string>, leftIndex: number, rightIndex: number): number {
  const rank = relevanceRank(left, shells) - relevanceRank(right, shells)
  if (rank !== 0) return rank
  const matches = (node: FlatNode) => {
    const haystack = `${node.name ?? ""} ${node.description ?? ""} ${node.value ?? ""}`
    return anchors.some(value => value.length > 0 && haystack.includes(value))
  }
  const offscreen = (node: FlatNode) => Number((node.states ?? []).includes("offscreen"))
  const scrollable = (node: FlatNode) => Number(!(node.available_actions ?? []).some(action => SCROLL_ACTIONS.includes(action)))
  const anonymous = (node: FlatNode) => Number(!(node.name || node.description || visibleValue(node)))
  return Number(matches(right)) - Number(matches(left))
    || offscreen(left) - offscreen(right)
    || scrollable(left) - scrollable(right)
    || anonymous(left) - anonymous(right)
    || leftIndex - rightIndex
}

const MODAL_OVERLAY_ROLES = new Set(["sheet", "alert", "dialog"])
function isModalOverlay(role: string): boolean {
  return MODAL_OVERLAY_ROLES.has(role)
}

/** Keep the window node (for activation) but only the modal overlay beneath
 * it, so every offered control is actually reachable. */
function scopeToOverlay(snapshot: SnapshotData): SnapshotData {
  const path: DesktopNode[] = []
  const find = (node: DesktopNode): DesktopNode | undefined => {
    if (isModalOverlay(node.role)) return node
    for (const child of node.children ?? []) {
      path.push(node)
      const found = find(child)
      if (found) return found
      path.pop()
    }
    return undefined
  }
  const overlay = find(snapshot.tree)
  if (!overlay) return snapshot
  const rebuild = (index: number): DesktopNode => {
    if (index >= path.length) return overlay
    const node = path[index]
    // children_count stays the real count, so the window still reports that
    // it holds more than the overlay.
    return { ...node, children: [rebuild(index + 1)] }
  }
  return { ...snapshot, tree: rebuild(0) }
}

function findOverlay(root: DesktopNode): string | undefined {
  const queue = [root]
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index]
    if (OVERLAY_ROLES.has(node.role)) return node.role
    queue.push(...(node.children ?? []))
  }
  return undefined
}

/** Clip to `max` UTF-16 code units without ever splitting a surrogate pair,
 * and replace lone surrogates already present in the source. Cutting an emoji
 * in half yields an unpaired surrogate, which is invalid Unicode: the service
 * rejects the whole request because of one broken icon in a video title. */
function sanitize(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim()
  let out = ""
  let used = 0
  for (const chunk of text) {
    if (used + chunk.length > max) break
    const code = chunk.codePointAt(0) ?? 0
    out += code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : chunk
    used += chunk.length
  }
  return out
}
