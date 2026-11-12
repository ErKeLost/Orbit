/**
 * One utterance, one lane.
 *
 * Jev answers a single yes/no: does this need the working agent?
 * Code applies the bar. It does not match phrases or store replies.
 */
export type GateAnswer = { noul?: number }

export type Turn =
  | { kind: "drop" }
  | { kind: "speak"; text: string }
  | { kind: "pi"; text: string }

export const AGENT_CONFIDENCE = 0.75

/** `needsAgent` is Jev's probability that the utterance needs tools or continued work. Missing means no. */
export function compose(said: string, needsAgent: number | null, agentBar = AGENT_CONFIDENCE): Turn {
  if (typeof needsAgent === "number" && needsAgent >= agentBar) return { kind: "pi", text: said }
  return { kind: "speak", text: said }
}
