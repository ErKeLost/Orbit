import { createHash } from "node:crypto"
import type { AgentDesktopClient, DesktopBounds, DesktopNode, SnapshotData } from "./agent-desktop-client.ts"
import type { DesktopCandidate, DesktopObservation, TextSlot } from "./gui-task-contract.ts"

// TypeSafe Choice accepts 255 options, but that is a protocol ceiling rather
// than a useful context budget. Keep the first observation small enough for
// staged Jev decisions; local ranking keeps caller-provided anchors near the
// front before this cap is applied.
const MAX_OBSERVED_ELEMENTS = 64
const MAX_CONTEXT_CANDIDATES = 48
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
  client: AgentDesktopClient,
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
    if (surface && client.backend !== "xa11y") {
      snapshot = (await client.run<SnapshotData>([...base, "--surface", surface, "--skeleton"], options)).data!
    } else if (surface && isModalOverlay(surface)) {
      // A modal sheet/alert blocks the window behind it: offering controls
      // under it invites clicks that silently do nothing. Scope candidates to
      // the overlay subtree (the xa11y worker has no --surface mode).
      snapshot = scopeToOverlay(snapshot)
    }
  }

  const nodes = flatten(snapshot.tree)
    .filter(node => node.ref_id && !(node.states ?? []).some(state => state === "disabled" || state === "hidden"))
  const actionableNodes = nodes.filter(hasSupportedCapability)
  // Keep the bounded candidate surface fast, but prioritize locally supplied
  // semantic anchors when the observed element visibly contains one. This is
  // generic relevance ordering, not an application-specific rule.
  const anchorValues = [...input.textSlots.map((slot: TextSlot) => slot.value), ...quotedGoalAnchors(input.goal ?? "")].filter(value => value.length > 0)
  const offeredNodes = actionableNodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => nodePriority(a.node, anchorValues) - nodePriority(b.node, anchorValues) || a.index - b.index)
    .slice(0, MAX_OBSERVED_ELEMENTS)
    .map(item => item.node)
  const windowBounds = snapshot.tree.children?.find(node => node.role === "window")?.bounds
  const menu = client.backend === "xa11y" && !input.root && findOverlay(snapshot.tree) === undefined
    ? await readMenuBar(client, snapshot.window.title, options)
    : []
  let candidates = buildCandidates(offeredNodes, input.textSlots, input.usedSlotIds, Boolean(input.root), input.allowPressEnter, !snapshot.complete, windowBounds, findOverlay(snapshot.tree), client.backend, input.goal ?? "")
  candidates = addMenuCandidates(candidates, menu, input.goal ?? "")
  // Text slots add mutation candidates; they must never hide navigation or
  // activation candidates. The semantic layer decides whether a field is the
  // intended target after the user has identified the right surface.
  // The OS media fact is read once per real observation, never inside the
  // post-action settle polls (skipMedia); attachMedia completes those later.
  const mediaSkipped = client.backend === "xa11y" && Boolean(input.skipMedia)
  const media = client.backend === "xa11y" && !input.skipMedia ? await readNowPlaying(client, options) : undefined
  const context = buildContext(snapshot, candidates, input.root, actionableNodes.length > offeredNodes.length, media, nodes, anchorValues)
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
const menuCache = new WeakMap<AgentDesktopClient, { title: string; at: number; items: MenuItem[] }>()

/** The application menu bar, cached per client for a few seconds and per
 * window title (enabled states follow the focused window's context). */
async function readMenuBar(client: AgentDesktopClient, title: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<MenuItem[]> {
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
export function invalidateMenuCache(client: AgentDesktopClient): void {
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
  const context = media ? observation.context.replace(/(candidate_context_count=\d+)/, `$1\n${media}`) : observation.context
  return { ...rest, context, ...(media ? { media } : {}), fingerprint: combineFingerprint(observation.treeFingerprint, media) }
}

export async function readMediaFact(client: AgentDesktopClient, options: { timeoutMs: number; signal?: AbortSignal }): Promise<string | undefined> {
  return client.backend === "xa11y" ? readNowPlaying(client, options) : undefined
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
  visit(root, [])
  return result
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

function buildCandidates(nodes: FlatNode[], slots: TextSlot[], used: ReadonlySet<string>, insideRoot: boolean, allowPressEnter: boolean, allowDrill: boolean, windowBounds?: DesktopBounds, overlay?: string, backend?: string, goal = ""): DesktopCandidate[] {
  const candidates: DesktopCandidate[] = []
  const nextSlot = nextTextSlot(nodes, slots, used)
  let identity: Record<string, string> | undefined
  const add = (candidate: Omit<DesktopCandidate, "id">) => {
    candidates.push({ ...candidate, ...(identity ? { criteria: identity } : {}), id: `candidate-${candidates.length + 1}` })
  }
  // Wrapper elements whose label belongs to a specific named control inside
  // them are inert targets: pressing the wrapper does nothing, and offering it
  // lets the wrapper win the choice about half the time (upstream offerable()
  // withholds exactly these). Withhold wrapper clicks when a same-named
  // button/link advertises the action itself.
  const specificLabels = new Set<string>()
  for (const node of nodes) {
    const label = (node.name ?? node.description ?? "").trim()
    if (label && (node.role === "button" || node.role === "link") && hasClickAction(new Set(node.available_actions ?? []))) specificLabels.add(label)
  }
  const isWrapperOfSpecific = (node: FlatNode) => {
    if (node.role !== "group" && node.role !== "link") return false
    const own = (node.name ?? node.description ?? "").trim()
    if (own && specificLabels.has(own)) return true
    const parts = (node.descendantSummary ?? "").split(" · ").map(part => part.trim())
    return parts.some(part => part && specificLabels.has(part))
  }
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
    return context ? sanitize(context.split(" · ").filter(part => part.trim() !== label).join(" · "), 140) : undefined
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
      identity = candidateCriteria(node, slots)
      add({ operation: "ACTIVATE", headed: false, description: `${describeNode(node)}; bring this application to the foreground before interacting with its content` })
      continue
    }
    if (node.role === "application" && node.children_count) continue
    const ref = node.ref_id!
    const actions = new Set(node.available_actions ?? [])
    const wrapperOfSpecific = isWrapperOfSpecific(node)
    const inItem = itemContext(node)
    const descriptor = inItem ? `${describeNode(node)}; inside item "${inItem}"` : describeNode(node)
    identity = candidateCriteria(node, slots)
    if (inItem) identity.in_item = inItem
    // Local fact: the element's own label occurs verbatim in the goal. It
    // orders truncated target lists; choosing stays with Jev.
    const ownLabel = (node.name ?? node.description ?? "").trim()
    if (ownLabel.length >= 2 && goal.includes(ownLabel)) identity.goal_match = "label appears in the goal"
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
        // A focus-only list row is a container, not an action. Drill into its
        // descendants to find the actual link/button before resorting to
        // physical pointer delivery.
        // A focus-only container declares no activation. Physical pointer
        // delivery is offered only when repetition structurally proves it is
        // a list row; any other container (toolbar, player bar, panel) must
        // be drilled so the actual leaf control is targeted.
        add({ operation: "DRILL", ref, headed: false, description: `${descriptor}; inspect this focus-only container for its actionable children` })
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
    if (hasClickAction(actions) && !isEditableTextRole(node.role, node) && !wrapperOfSpecific) {
      if (webContent) {
        // Web content exposes a semantic press that often works (and never
        // misses the window), so offer it first; the physical pointer stays
        // available for cases where the semantic press has no visible effect.
        add({ operation: "CLICK", ref, headed: false, description: `${descriptor}; delivery=semantic accessibility press; try this before pointer delivery` })
        add({ operation: "CLICK", ref, headed: true, description: `${descriptor}; delivery=exact-window physical pointer; use when the semantic press shows no visible effect` })
      } else {
        add({ operation: "CLICK", ref, headed: false, description: `${descriptor}; delivery=semantic accessibility` })
      }
      if (webContent && node.role === "group" && !node.name && !node.description && node.listRow) {
        add({ operation: "DOUBLE_CLICK", ref, headed: true, evidence: "structural", speculative: true, expect: ["no_overlay"], description: `${descriptor}; activate this observed list item itself with two rapid verified pointer clicks` })
      }
    }
    // A declared context-menu capability is the generic "more actions on this
    // item" route; the opened menu's items become candidates in the next
    // observation. Agent-desktop backend only: it owns the right-click delivery.
    if (backend === "agent-desktop" && actions.has("RightClick")) {
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
    // search box") and needs no caller-prepared text.
    if (backend === "agent-desktop" && isEditableTextRole(node.role, node) && actions.has("SetValue") && !(node.states ?? []).includes("secure") && typeof node.value === "string" && node.value.length > 0) {
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
    const structuralRegion = ["split_group", "group", "web_area"].includes(node.role.toLowerCase()) && (node.children_count ?? 0) >= 5
    const alreadyDrillable = candidates.some(candidate => candidate.operation === "DRILL" && candidate.ref === ref)
    if (!alreadyDrillable && (allowDrill || structuralRegion) && node.children_count && node.children_count > 0 && (!hasIdentity || !actions.has("Click"))) {
      add({ operation: "DRILL", ref, description: descriptor })
    }
  }
  identity = undefined
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
  return candidates
}

/** Structured identity criteria, following the upstream act.mjs describe():
 * structured criteria disambiguate better than a flat sentence, and pointer
 * position is spent only on an element with no name, no description and no
 * value. Operation semantics stay out of these fields. */
function candidateCriteria(node: FlatNode, slots: TextSlot[] = []): Record<string, string> {
  const label = node.name ?? node.description
  const derived = !label ? node.descendantSummary : undefined
  const embedded = !label && !derived && node.actionableAncestor
  const criteria: Record<string, string> = {
    what: `${node.role}${label ? ` "${sanitize(label, 120)}"` : derived ? ` containing "${sanitize(derived, 90)}"` : embedded ? " embedded control" : ""}`,
  }
  const path = node.path.slice(-5).join(" > ")
  if (path) criteria.where = sanitize(path, 160)
  const value = visibleValue(node)
  if (value) criteria.holds = sanitize(value, 120)
  if (node.states?.length) criteria.state = node.states.join(", ")
  if ((node.siblingCount ?? 0) > 1) criteria.sibling = `item ${node.siblingOrdinal} of ${node.siblingCount} among sibling ${node.role} elements with the same capabilities`
  if (node.children_count) criteria.contains = childrenFact(node)
  const structure = structuralFacts(node)
  if (structure) criteria.structure = structure
  criteria.supports = node.available_actions?.length ? node.available_actions.join(", ") : "no declared action"
  const haystack = `${node.name ?? ""} ${node.description ?? ""} ${value ?? ""}`
  const matchingSlot = slots.find(slot => slot.value.length > 0 && haystack.includes(slot.value))
  if (matchingSlot) criteria.local_match = `contains caller-prepared text for ${sanitize(matchingSlot.description, 120)}`
  if (/群聊|群消息|群[，,：:]/u.test(haystack)) criteria.group_marker = "group chat marker is visible"
  if (!label && !derived && !value && node.bounds) criteria.at = `${Math.round(node.bounds.x)},${Math.round(node.bounds.y)}`
  return criteria
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

/** Observed structure and geometry only; never an inferred purpose. */
function structuralFacts(node: FlatNode): string | undefined {
  const facts: string[] = []
  if (node.listRow) facts.push(`row ${node.listRow.ordinal} of ${node.listRow.count} repeated same-shaped rows${node.listRow.inListContainer ? " in a list/scroll container" : ""}`)
  if (node.cluster) facts.push(`control ${node.cluster.ordinal} of ${node.cluster.count} in a horizontal control cluster; size rank ${node.cluster.sizeRank}${node.cluster.centered ? "; at the cluster center" : ""}`)
  if (node.cluster && node.bounds && node.bounds.width > 0) facts.push(`size ${Math.round(node.bounds.width)}x${Math.round(node.bounds.height)}`)
  return facts.length ? facts.join("; ") : undefined
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
async function readNowPlaying(client: AgentDesktopClient, options: { timeoutMs: number; signal?: AbortSignal }): Promise<string | undefined> {
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

function buildContext(snapshot: SnapshotData, candidates: DesktopCandidate[], root?: string, truncated = false, media?: string, nodes: FlatNode[] = [], anchors: string[] = []): string {
  const descriptions = [...new Set(candidates.filter(candidate => candidate.ref).map(candidate => candidate.description))]
    .slice(0, MAX_CONTEXT_CANDIDATES)
  const lines = descriptions.map((description, index) => `${index + 1}. ${description}`)
  const header = [
    `app=${snapshot.app}`,
    `window=${snapshot.window.title}`,
    `scope=${root ? "drilled region" : "full local accessibility tree"}`,
    `complete=${snapshot.complete}`,
    `candidate_space_truncated=${truncated}`,
    `candidate_context_count=${descriptions.length}`,
    ...(media ? [media] : []),
  ].join("\n")
  const visibleText = collectVisibleText(snapshot.tree).slice(0, 32)
  // Relevant AX evidence may be beyond the first 32 static-text leaves or
  // the 48 candidate descriptions. Preserve its container path (not just an
  // isolated message leaf) so Jev can judge whether two facts share a view.
  const matches = nodes.filter(node => {
    const text = `${node.name ?? ""} ${node.description ?? ""} ${visibleValue(node) ?? ""}`
    return anchors.some(anchor => text.includes(anchor))
  }).slice(0, 12).map(node => `${node.role} ${sanitize(node.name ?? node.description ?? visibleValue(node) ?? "", 120)} in ${sanitize(node.path.join(" > "), 180)}`)
  const evidence = matches.length ? `\nobserved_goal_matches:\n${matches.map((value, index) => `${index + 1}. ${value}`).join("\n")}` : ""
  const textBlock = `${evidence}${visibleText.length ? `\nobserved_text:\n${visibleText.map((value, index) => `${index + 1}. ${value}`).join("\n")}` : ""}`
  const body = lines.length <= 40 ? lines.join("\n") : `${lines.slice(0, 20).join("\n")}\n... ${lines.length - 40} candidates omitted ...\n${lines.slice(-20).join("\n")}`
  const remaining = 16_000 - header.length - textBlock.length - 2
  if (body.length + textBlock.length <= remaining) return `${header}${textBlock}\n${body}`
  const marker = "\n... middle candidates omitted ...\n"
  const side = Math.floor((remaining - marker.length) / 2)
  return `${header}\n${body.slice(0, side)}${marker}${body.slice(-side)}`
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

function nodePriority(node: FlatNode, anchors: string[]): number {
  const haystack = `${node.name ?? ""} ${node.description ?? ""} ${node.value ?? ""}`
  const anchorMatch = anchors.some(value => value.length > 0 && haystack.includes(value))
  // Editable fields are the only nodes that can consume the next local text
  // slot. Keep them ahead of repeated chat rows and other anchor matches so a
  // dense conversation cannot evict the composer from the bounded surface.
  const editable = isEditableTextRole(node.role, node) && (node.states ?? []).includes("editable")
  // Skeleton observations represent dense panes as anonymous structural
  // containers. Preserve large regions so a later DRILL can expose controls
  // that are intentionally absent from the shallow tree.
  const structural = ["split_group", "group"].includes(node.role.toLowerCase()) && (node.children_count ?? 0) >= 5
  // Scroll regions are navigation controls, not just wrappers. A dense list
  // can otherwise evict the history scroller from the 64-node offer set.
  const scrollable = (node.available_actions ?? []).some(action => ["Scroll", "ScrollUpByPage", "ScrollDownByPage"].includes(action))
  const offscreen = (node.states ?? []).includes("offscreen")
  const labeled = Boolean(node.name || node.description || visibleValue(node))
  const wrapper = node.role === "group" && Boolean(node.children_count)
  return (editable ? -250 : 0) + (scrollable ? -210 : 0) + (structural ? -180 : 0) + (anchorMatch ? -100 : 0) + (offscreen ? 30 : 0) + (labeled ? 0 : 10) + (wrapper ? 5 : 0)
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

function sanitize(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max)
}
