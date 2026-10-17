import type { CuaCandidate } from "../cua/types.ts"

/**
 * Which candidates the chooser is allowed to see.
 *
 * The chooser picks, but it never widens its own authority: risky labels are
 * withheld unless the goal names them, read-only runs lose every mutating
 * operation, and a target the loop has already disproved is withheld.
 */

/** Labels that name a hard-to-undo action. A goal that says the word opts in. */
const RISKY = /(删除|移除|清空|发送|提交|支付|付款|购买|下单|退出|注销|关闭|卸载|格式化|重置|delete|remove|clear|send|submit|pay|purchase|buy|checkout|quit|uninstall|format|reset|erase|discard|sign\s*out|log\s*out)/i

export const MAX_EXECUTABLE_CANDIDATES = 24
/** The only operations a read-only run may perform. */
const READ_ONLY_OPERATIONS = new Set(["scroll", "done", "reobserve", "abstain"])

export function isRisky(label: string | undefined): boolean {
  return Boolean(label && RISKY.test(label))
}

/** The goal opts into a risky action only by naming it. */
export function goalAllowsRisk(goal: string): boolean {
  return RISKY.test(goal)
}

export type PolicyContext = {
  readOnly: boolean
  goal: string
  /** Stable identities already disproved this run. */
  quarantined: ReadonlySet<string>
  /** Candidate ids already chosen on this exact screen. */
  triedHere: ReadonlySet<string>
  /** Identities chosen too often in a row; the repeat brake. */
  repeatedTargets: ReadonlySet<string>
}

export function applyPolicy(candidates: readonly CuaCandidate[], context: PolicyContext): CuaCandidate[] {
  const riskAllowed = goalAllowsRisk(context.goal)
  return candidates.filter(candidate => {
    // A read-only task can never click, type, submit or open a menu, whatever
    // the observation offered: the caller asked to look, not to change.
    if (context.readOnly && !READ_ONLY_OPERATIONS.has(candidate.operation)) return false
    if (candidate.risky && !riskAllowed) return false
    if (candidate.identity && context.quarantined.has(candidate.identity)) return false
    if (candidate.identity && context.repeatedTargets.has(candidate.identity)) return false
    if (!candidate.slotId && context.triedHere.has(candidate.id) && candidate.operation !== "reobserve") return false
    return true
  })
}

/**
 * Keep the offer set bounded and deterministic. Reserved candidates are always
 * last. Anything past the cap is dropped rather than silently truncated inside
 * the request, so the chooser's probability distribution covers what it saw.
 *
 * Scroll candidates are never themselves dropped: they are the only way to
 * reveal what the cap hid, so keeping them is what makes a bounded offer set
 * recoverable instead of a dead end. They are placed after the kept controls so
 * the chooser still sees the concrete targets first.
 */
export function boundCandidates(candidates: readonly CuaCandidate[]): { offered: CuaCandidate[]; dropped: number } {
  const executable = candidates.filter(candidate => !candidate.tool ? false : true)
  const reserved = candidates.filter(candidate => !candidate.tool)
  if (executable.length <= MAX_EXECUTABLE_CANDIDATES) return { offered: [...executable, ...reserved], dropped: 0 }
  const scrolls = executable.filter(candidate => candidate.operation === "scroll")
  const others = executable.filter(candidate => candidate.operation !== "scroll")
  const room = Math.max(0, MAX_EXECUTABLE_CANDIDATES - scrolls.length)
  const kept = [...others.slice(0, room), ...scrolls]
  return { offered: [...kept, ...reserved], dropped: executable.length - kept.length }
}
