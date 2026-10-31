/** Shared, data-only contract. No credentials, Node or UI dependencies. */
export const VOICE_CAPABILITIES = {
  dispatch_task: { description: "Request additional work. It does not explicitly replace existing work; the scheduler decides immediate versus queued delivery from current execution state.", effect: "task.write", target: true },
  steer_task: { description: "Explicitly replace, redirect or amend the instructions of work already running.", effect: "task.write", target: true },
  queue_task: { description: "Request additional work with an explicit dependency on completion of existing work.", effect: "task.write", target: true },
  query_progress: { description: "Request observed execution state, progress, results or completion status.", effect: "observation.read", target: true },
  analyze_session: { description: "Request interpretation or explanation of observed work, without changing its execution.", effect: "observation.read", target: true },
  watch_task: { description: "Request continued observation or lifecycle notifications for existing work, without modifying, resuming or redispatching it.", effect: "observation.read", target: true },
  lookup: { description: "Request an answer that needs fresh external evidence, a search, a website, a file or another tool. Questions themselves authorize read-only retrieval; use this even without an imperative verb. Do not answer changing facts from model memory.", effect: "information.read", target: true },
  general_question: { description: "Request stable general knowledge, advice or discussion that can be answered without external evidence or tools.", effect: "conversation.read", target: false },
  chat: { description: "Social conversation, acknowledgement or encouragement. Reaffirming an already active instruction adds no new work unless the caller changes its scope or requests a new action.", effect: "conversation.read", target: false },
  reply_confirmation: { description: "Provide a decision or value for the specific pending interaction already explained to the caller.", effect: "task.write", target: true },
  control_voice: { description: "Change voice playback or end the call. Stopping playback leaves tasks running. Ending the call also cancels the session created by that call; sessions merely observed remain independent.", effect: "voice.write", target: false },
  control_task: { description: "Explicitly cancel the execution of a task, independently of voice playback.", effect: "task.write", target: true },
  change_focus: { description: "Change the session being observed or discussed, without changing its execution.", effect: "focus.write", target: true },
  clarify: { description: "The caller's requested effect or its required target cannot be resolved from available context.", effect: "conversation.read", target: false },
} as const
export type VoiceIntent = keyof typeof VOICE_CAPABILITIES
export const VOICE_INTENTS = Object.fromEntries(Object.entries(VOICE_CAPABILITIES).map(([id, capability]) => [id, capability.description])) as Record<VoiceIntent, string>
export type VoiceTarget = { id: string; sessionFile: string; title: string; running: boolean; waiting: boolean }
export type VoiceHistory = { role: "user" | "assistant"; text: string }
export type PendingVoiceRequest = { text: string; question: string; attempts: number }
export type ClarificationReason = "unclear_request" | "incomplete_request" | "uncertain_intent" | "uncertain_authorization" | "uncertain_target" | "unannounced_confirmation" | "invalid_decision"
export type VoiceRouteInput = {
  text: string
  originalText?: string
  focused: string
  targets: VoiceTarget[]
  history: VoiceHistory[]
  focusedTask?: { sessionFile: string; state: string; goal: string; latestReply: string; activeTools: string[] }
  pendingRequest?: PendingVoiceRequest
  confirmation?: { id: string; question: string; announced: boolean; method?: "confirm" | "select" | "input" | "editor"; options?: string[] }
}
export type VoiceDecision = {
  intent: VoiceIntent
  target: string
  confidence: number
  targetConfidence: number
  mutation: number
  compound: number
  model: string
  latencyMs: number
  workKind?: "action" | "lookup"
  deliveryConfidence?: number
  voiceControl?: "stop_speech" | "end_call" | "none"
  confirmationResponse?: { id: string; action: "confirm" | "reject" | "cancel" | "select" | "text"; optionIndex?: number; confidence: number }
  actionability?: number
  continuesRequest?: boolean
  clarificationReason?: ClarificationReason
  candidateIntent?: VoiceIntent
}
export type VoiceServiceEvent = {
  id: string
  type: "decision" | "delta" | "done" | "error" | "plan"
  text?: string
  decision?: VoiceDecision
  actions?: { text: string }[]
}
export const VOICE_STATUS = "gui-voice"
export const MUTATING_INTENTS = new Set<VoiceIntent>((Object.keys(VOICE_CAPABILITIES) as VoiceIntent[]).filter(id => VOICE_CAPABILITIES[id].effect === "task.write"))
export const EXECUTING_INTENTS = new Set<VoiceIntent>([...MUTATING_INTENTS, "lookup"])
const WORK_REQUEST_INTENTS = new Set<VoiceIntent>(["dispatch_task", "steer_task", "queue_task", "lookup"])
export function validatedDecision(value: VoiceDecision, input: VoiceRouteInput): VoiceDecision {
  const clarify = (clarificationReason: ClarificationReason): VoiceDecision => ({ ...value, candidateIntent: value.intent === "clarify" ? value.candidateIntent : value.intent, intent: "clarify", clarificationReason })
  const validIntent = Object.hasOwn(VOICE_INTENTS, value.intent)
  const target = input.targets.find(item => item.id === value.target)
  const numbers = [value.confidence, value.targetConfidence, value.mutation, value.compound, ...(value.deliveryConfidence === undefined ? [] : [value.deliveryConfidence])]
  if (!validIntent || numbers.some(n => !Number.isFinite(n) || n < 0 || n > 1) || (value.actionability !== undefined && (!Number.isFinite(value.actionability) || value.actionability < 0 || value.actionability > 1))) return clarify("invalid_decision")
  if (value.confidence < 0.55) return clarify("uncertain_intent")
  // A short dialog answer or cancellation has its own bound object. It does
  // not need to describe a new task; confirmation identity is checked below.
  if (WORK_REQUEST_INTENTS.has(value.intent) && (value.actionability ?? 0) < 0.75) return clarify("incomplete_request")
  if (MUTATING_INTENTS.has(value.intent)) {
    // Initial conservative gates; tune against the voice routing evaluation set.
    const newWork = value.intent === "dispatch_task" || value.intent === "queue_task"
    if (!target || value.targetConfidence < (newWork ? 0.65 : 0.8)) return clarify("uncertain_target")
    // Authorization is a separate semantic head. Overlapping task labels may
    // split intent confidence even when a complete new request is explicit.
    if (value.intent === "reply_confirmation") {
      if (!input.confirmation?.announced || target.id !== input.focused) return clarify("unannounced_confirmation")
      // This head answers the concrete interaction the caller actually heard.
      // A generic new-work authorization head has no authority over that answer.
      const response = value.confirmationResponse
      if (!response || response.id !== input.confirmation.id || !Number.isFinite(response.confidence) || response.confidence < 0.85 || value.confidence < 0.85) return clarify("uncertain_authorization")
    } else if (value.mutation < (newWork ? 0.7 : 0.8) || (!newWork && value.confidence < 0.8) || (value.intent === "steer_task" && (value.deliveryConfidence ?? value.confidence) < 0.8)) return clarify("uncertain_authorization")
  }
  if (VOICE_CAPABILITIES[value.intent].target && (!target || value.targetConfidence < 0.65)) return clarify("uncertain_target")
  return value.intent === "clarify" ? clarify(value.clarificationReason ?? "unclear_request") : value
}
