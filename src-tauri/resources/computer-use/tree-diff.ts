import type { DesktopCandidate, DesktopNode } from "./gui-task-contract.ts"

/** Structured difference between two accessibility observations. The engine
 * turns this into a bounded `diff:` fact for Jev's recentActions so progress
 * is judged from what actually changed, not from a changed=true boolean. */
export type TreeDiff = {
  added: string[]
  removed: string[]
  valueChanges: { label: string; from: string; to: string }[]
  focusMovedTo?: string
}

const MAX_ITEMS = 8
const MAX_VALUE_CHANGES = 4

type FlatElement = { role: string; label: string; value?: string; focused: boolean }

function collectElements(root: DesktopNode): FlatElement[] {
  const elements: FlatElement[] = []
  if (!root || typeof root !== "object") return elements
  const visit = (node: DesktopNode) => {
    if (!node || typeof node !== "object") return
    const label = node.name ?? node.description
    if (node.role.toLowerCase() !== "window") {
      elements.push({
        role: node.role.toLowerCase(),
        label: label ?? "",
        value: typeof node.value === "string" ? node.value : undefined,
        focused: (node.states ?? []).includes("focused"),
      })
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return elements
}

function clip(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max)
}

function elementText(element: FlatElement): string {
  return element.label ? `${element.role} "${clip(element.label, 80)}"` : element.role
}

export function diffTrees(before: DesktopNode, after: DesktopNode): TreeDiff {
  const beforeElements = collectElements(before)
  const afterElements = collectElements(after)
  const multiset = (elements: FlatElement[]) => {
    // Added/removed compare identity only (role+label): a changed value is
    // reported once as a value change, not also as a removal plus addition.
    const counts = new Map<string, number>()
    for (const element of elements) counts.set(`${element.role}|${element.label}`, (counts.get(`${element.role}|${element.label}`) ?? 0) + 1)
    return counts
  }
  const beforeCounts = multiset(beforeElements)
  const afterCounts = multiset(afterElements)
  const added: string[] = []
  const removed: string[] = []
  for (const [key, count] of afterCounts) {
    const delta = count - (beforeCounts.get(key) ?? 0)
    for (let index = 0; index < delta && added.length < MAX_ITEMS; index++) {
      const [role, label] = key.split("|")
      added.push(label ? `${role} "${clip(label, 80)}"` : role)
    }
  }
  for (const [key, count] of beforeCounts) {
    const delta = count - (afterCounts.get(key) ?? 0)
    for (let index = 0; index < delta && removed.length < MAX_ITEMS; index++) {
      const [role, label] = key.split("|")
      removed.push(label ? `${role} "${clip(label, 80)}"` : role)
    }
  }
  // Nodes present in both trees whose value changed; matched by role+label so
  // typed text, cleared fields and updated counters surface as facts.
  const groupBy = (elements: FlatElement[]) => {
    const groups = new Map<string, FlatElement[]>()
    for (const element of elements) {
      const key = `${element.role}|${element.label}`
      groups.set(key, [...(groups.get(key) ?? []), element])
    }
    return groups
  }
  const valueChanges: TreeDiff["valueChanges"] = []
  const afterGroups = groupBy(afterElements.filter(element => element.value !== undefined))
  for (const [key, afterGroup] of afterGroups) {
    if (valueChanges.length >= MAX_VALUE_CHANGES) break
    const beforeGroup = groupBy(beforeElements.filter(element => element.value !== undefined)).get(key) ?? []
    for (const element of afterGroup) {
      const match = beforeGroup.find(candidate => candidate.value !== element.value)
      if (!match) continue
      const role = key.split("|")[0]
      valueChanges.push({ label: element.label ? `${role} "${clip(element.label, 60)}"` : role, from: clip(match.value ?? "", 60), to: clip(element.value ?? "", 60) })
      beforeGroup.splice(beforeGroup.indexOf(match), 1)
      if (valueChanges.length >= MAX_VALUE_CHANGES) break
    }
  }
  // Newly focused element (the previously focused one, if any, is implied).
  const beforeFocusKeys = new Set(beforeElements.filter(element => element.focused).map(element => `${element.role}|${element.label}`))
  const newFocus = afterElements.find(element => element.focused && !beforeFocusKeys.has(`${element.role}|${element.label}`))
  return { added, removed, valueChanges, ...(newFocus ? { focusMovedTo: elementText(newFocus) } : {}) }
}

/** One-line bounded summary for Jev's recentActions. Empty diff means the
 * accessibility tree is byte-identical even though the fingerprint moved. */
export function describeDiff(diff: TreeDiff): string {
  const parts: string[] = []
  for (const item of diff.added) parts.push(`+${item}`)
  for (const item of diff.removed) parts.push(`-${item}`)
  for (const change of diff.valueChanges) parts.push(`~${change.label}: "${change.from}" -> "${change.to}"`)
  if (diff.focusMovedTo) parts.push(`focus-> ${diff.focusMovedTo}`)
  if (!parts.length) return "no structural, value or focus change"
  return clip(parts.join("; "), 300)
}

/**
 * Re-identify a candidate's target inside a successor observation by its
 * structured criteria, because snapshot refs are scoped to one snapshot.
 * Match by role+label, or role+observed coordinates for anonymous targets.
 * Unresolvable identities return undefined: unverifiable is safer than a
 * wrong guess when deciding whether an action achieved its expectation.
 */
export function findNodeByIdentity(tree: DesktopNode, candidate: DesktopCandidate): DesktopNode | undefined {
  const criteria = candidate.criteria ?? {}
  const what = criteria.what ?? candidate.description.split(";")[0] ?? ""
  const role = what.split(/\s+/)[0]?.toLowerCase().replace(/[\s_-]/g, "")
  const label = what.match(/"([^"]*)"/)?.[1]
  const at = criteria.at?.split(",").map(Number)
  let found: DesktopNode | undefined
  const normalize = (role: string) => role.toLowerCase().replace(/[\s_-]/g, "")
  const visit = (node: DesktopNode) => {
    if (found) return
    if (role && normalize(node.role) === role) {
      const nodeLabel = node.name ?? node.description
      if (label && nodeLabel === label) found = node
      else if (!label && at && node.bounds && Math.abs(node.bounds.x - at[0]) <= 2 && Math.abs(node.bounds.y - at[1]) <= 2) found = node
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return found
}
