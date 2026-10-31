import { describe, expect, test } from "bun:test"
import { validatedDecision, type VoiceDecision, type VoiceRouteInput } from "../src-tauri/resources/voice/contract"
import { taskView, eventFact, progressReply } from "../src/features/voice/model/task-view"
import { emptyTranscript } from "../src/lib/protocol/types"
import type { Snapshot } from "../src/lib/rpc-core"
import { decisionFromAnswers } from "../src-tauri/resources/voice/router"

const input: VoiceRouteInput = { text: "做到哪了", focused: "a", targets: [{ id: "a", sessionFile: "/a", title: "A", running: true, waiting: false }], history: [] }
const decision = (patch: Partial<VoiceDecision> = {}): VoiceDecision => ({ intent: "query_progress", target: "a", confidence: 0.99, targetConfidence: 0.99, mutation: 0.01, actionability: 0.99, compound: 0, model: "fixture", latencyMs: 1, ...patch })
describe("voice route execution boundary", () => {
  test("a confident progress question remains read-only", () => expect(validatedDecision(decision(), input).intent).toBe("query_progress"))
  test("fresh information uses Pi without requiring authorization for a mutation", () => expect(validatedDecision(decision({intent:"lookup",mutation:0}),input).intent).toBe("lookup"))
  test("new work uses explicit authorization evidence while control operations retain their stricter gate", () => {
    expect(validatedDecision(decision({intent:"dispatch_task",confidence:0.61,mutation:0.95}),input).intent).toBe("dispatch_task")
    expect(validatedDecision(decision({intent:"control_task",confidence:0.61,mutation:0.95}),input).intent).toBe("clarify")
  })
  test("unspecified work cannot be sent to an executor", () => {
    expect(validatedDecision(decision({intent:"dispatch_task",mutation:0.99,actionability:0.02}),input)).toMatchObject({intent:"clarify",clarificationReason:"incomplete_request"})
    expect(validatedDecision(decision({intent:"dispatch_task",mutation:0.99,actionability:undefined}),input).intent).toBe("clarify")
  })
  test("a task classification without explicit mutation evidence cannot write", () => expect(validatedDecision(decision({ intent: "dispatch_task" }), input).intent).toBe("clarify"))
  test("a target outside the supplied directory cannot receive a task", () => expect(validatedDecision(decision({ intent: "dispatch_task", mutation: 0.99, target: "invented" }), input).intent).toBe("clarify"))
  test("ambiguous targeting never cancels work", () => expect(validatedDecision(decision({ intent: "control_task", mutation: 0.99, targetConfidence: 0.6 }), input).intent).toBe("clarify"))
  test("approval requires an actually announced confirmation in the focused session", () => {
    const d = decision({ intent: "reply_confirmation", mutation: 0.99, confirmationResponse: { id: "c", action: "confirm", confidence: 0.99 } })
    expect(validatedDecision(d, input).intent).toBe("clarify")
    expect(validatedDecision(d, { ...input, confirmation: { id: "c", question: "Run?", announced: false } }).intent).toBe("clarify")
    expect(validatedDecision(d, { ...input, confirmation: { id: "c", question: "Run?", announced: true } }).intent).toBe("reply_confirmation")
  })
  test("a dialog answer and cancellation do not need to describe a new task", () => {
    const approval = decision({ intent: "reply_confirmation", mutation: 0.1, actionability: 0.1, confirmationResponse: { id: "c", action: "confirm", confidence: 0.99 } })
    expect(validatedDecision(approval, { ...input, confirmation: { id: "c", question: "Run?", announced: true } }).intent).toBe("reply_confirmation")
    expect(validatedDecision(approval, input)).toMatchObject({ intent: "clarify", clarificationReason: "unannounced_confirmation" })
    expect(validatedDecision(decision({ intent: "control_task", mutation: 0.99, actionability: 0.1 }), input).intent).toBe("control_task")
    expect(validatedDecision({ ...approval, confirmationResponse: { id: "old", action: "confirm", confidence: 0.99 } }, { ...input, confirmation: { id: "c", question: "Run?", announced: true } }).intent).toBe("clarify")
    expect(validatedDecision({ ...approval, confirmationResponse: { id: "c", action: "confirm", confidence: 0.5 } }, { ...input, confirmation: { id: "c", question: "Run?", announced: true } }).intent).toBe("clarify")
  })
  test("malformed probabilities and unknown intents cannot execute", () => {
    expect(validatedDecision(decision({ mutation: NaN }), input).intent).toBe("clarify")
    expect(validatedDecision(decision({ intent: "execute_everything" as never }), input).intent).toBe("clarify")
  })
})

describe("Jev responsibility boundaries", () => {
  const answers = (effect: string) => ({effect:{choice:effect,confidence:0.99},target:{choice:"a",confidence:0.99},workKind:{choice:"action",confidence:0.99},delivery:{choice:"additional",confidence:0.99},observation:{choice:"progress",confidence:0.99},mutation:{noul:0.99},actionability:{noul:0.99},compound:{noul:0}})
  test("a task delivery head cannot turn a conversation into execution", () => {
    const result = decisionFromAnswers({...answers("respond"),observation:{choice:"conversation",confidence:0.99},delivery:{choice:"redirect",confidence:0.99}},input,"fixture",1)
    expect(result.intent).toBe("general_question")
  })
  test("supplying a missing location continues retrieval without becoming an approval", () => {
    const continuation = {...input,text:"北京",pendingRequest:{text:"查天气预报",question:"查哪个城市？",attempts:1}}
    const result = decisionFromAnswers({...answers("execute"),workKind:{choice:"lookup",confidence:0.99},mutation:{noul:0.05},requestRelation:{choice:"clarification_reply",confidence:0.99},confirmationAnswer:{choice:"confirm",confidence:0.99}},continuation,"fixture",1)
    expect(result).toMatchObject({intent:"lookup",continuesRequest:true})
    expect(result.confirmationResponse).toBeUndefined()
  })
  test("a model cannot invent an unannounced tool interaction", () => {
    expect(decisionFromAnswers(answers("confirmation"),input,"fixture",1).intent).toBe("clarify")
  })
  test("speech control and task cancellation stay independent", () => {
    expect(decisionFromAnswers({...answers("voice_control"),voiceControl:{choice:"stop_speech",confidence:0.99}},input,"fixture",1)).toMatchObject({intent:"control_voice",voiceControl:"stop_speech"})
    expect(decisionFromAnswers({...answers("task_control"),voiceControl:{choice:"stop_speech",confidence:0.99}},input,"fixture",1).intent).toBe("control_task")
  })
  test("reaffirming unchanged work can only establish observation", () => {
    const result = decisionFromAnswers({ ...answers("execute"), effect: { choice: "execute", confidence: 0.4 }, delivery: { choice: "unchanged", confidence: 0.99 }, actionability: { noul: 0.1 } }, input, "fixture", 1)
    expect(result).toMatchObject({ intent: "watch_task", mutation: 0.99 })
  })
  test("retrieval and task changes share an executor without losing delivery semantics", () => {
    const lookup = { ...answers("execute"), workKind: { choice: "lookup", confidence: 0.99 } }
    expect(decisionFromAnswers(lookup, input, "fixture", 1)).toMatchObject({ intent: "lookup", workKind: "lookup" })
    expect(decisionFromAnswers({ ...lookup, delivery: { choice: "redirect", confidence: 0.99 } }, input, "fixture", 1)).toMatchObject({ intent: "steer_task", workKind: "lookup" })
    expect(decisionFromAnswers({ ...lookup, delivery: { choice: "deferred", confidence: 0.99 } }, input, "fixture", 1)).toMatchObject({ intent: "queue_task", workKind: "lookup" })
  })
  test("each head only provides evidence for its own responsibility", () => {
    expect(decisionFromAnswers({ ...answers("execute"), delivery: { choice: "deferred", confidence: 0.6 } }, input, "fixture", 1)).toMatchObject({ intent: "queue_task", confidence: 0.99, deliveryConfidence: 0.6 })
    expect(decisionFromAnswers({ ...answers("execute"), delivery: { choice: "redirect", confidence: 0.6 } }, input, "fixture", 1)).toMatchObject({ intent: "clarify", candidateIntent: "steer_task" })
    expect(decisionFromAnswers({ ...answers("respond"), observation: { choice: "progress", confidence: 0.6 }, notify: { noul: 0.9 } }, input, "fixture", 1).intent).toBe("watch_task")
    expect(decisionFromAnswers({ ...answers("respond"), observation: { choice: "conversation", confidence: 0.99 }, delivery: { choice: "redirect", confidence: 0.99 } }, input, "fixture", 1).intent).toBe("general_question")
  })
  test("a grounded reply to Pi's question preserves the original retrieval request", () => {
    const context = { ...input, text: "北京", focusedTask: { sessionFile: "/a", state: "settled", goal: "查天气", latestReply: "哪个城市？", activeTools: [] } }
    const reply = { ...answers("execute"), effect: { choice: "execute", confidence: 0.4 }, workKind: { choice: "lookup", confidence: 0.99 }, continuesTask: { noul: 0.98 } }
    expect(decisionFromAnswers(reply, context, "fixture", 1).intent).toBe("lookup")
    expect(decisionFromAnswers(reply, input, "fixture", 1).intent).toBe("clarify")
    expect(decisionFromAnswers({ ...reply, effect: { choice: "respond", confidence: 0.99 }, observation: { choice: "conversation", confidence: 0.99 } }, context, "fixture", 1).intent).toBe("general_question")
  })
  test("missing execution heads cannot silently default to a write", () => {
    expect(decisionFromAnswers({ ...answers("execute"), workKind: { choice: "invented", confidence: 0.99 } }, input, "fixture", 1).intent).toBe("clarify")
    expect(decisionFromAnswers({ ...answers("execute"), delivery: { choice: "invented", confidence: 0.99 } }, input, "fixture", 1).intent).toBe("clarify")
  })
})

describe("task evidence", () => {
  const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => ({ transcript: emptyTranscript(), state: { sessionFile: "/a", sessionName: "A" } as Snapshot["state"], connection: "online", error: null, draft: "", dialogs: [], notices: [], statuses: {}, widgets: {}, agents: null, telemetry: {} as Snapshot["telemetry"], ...patch })
  test("a running task stays running while it has no new model text", () => {
    const view = taskView(snapshot({ transcript: { ...emptyTranscript(), running: true, tools: { t: { name: "browser_task", running: true } } } }))
    expect(view.state).toBe("running")
    expect(progressReply(view, "en")).toContain("running")
    expect(progressReply(view, "en")).not.toContain("finished")
  })
  test("confirmation, failure and cancellation remain distinct", () => {
    expect(taskView(snapshot({ dialogs: [{ type: "extension_ui_request", id: "c", method: "confirm", title: "Run", message: "Run tests?" }] })).state).toBe("waiting_input")
    expect(taskView(snapshot({ transcript: { ...emptyTranscript(), error: "failed" } })).state).toBe("failed")
    expect(taskView(snapshot({ transcript: { ...emptyTranscript(), aborted: true } })).state).toBe("cancelled")
  })
  test("browser step updates become bounded evidence; thinking is excluded", () => {
    const source = { connectionId: "a", sessionFile: "/a", sequence: 4, observedAt: 100, event: { type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "Verified search results" }] } } }
    expect(eventFact(source)?.text).toBe("Verified search results")
    expect(eventFact({ ...source, event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private" } } })).toBeNull()
  })
  test("a settled turn is not proof of task completion", () => {
    const view=taskView(snapshot({transcript:{...emptyTranscript(),messages:[{id:"u",message:{role:"user",content:"Weather."}},{id:"a",message:{role:"assistant",content:"Which city?"}}] as never}}))
    expect(view.state).toBe("settled")
    expect(view.latestReply).toBe("Which city?")
    expect(progressReply(view,"en")).not.toMatch(/completed|finished/u)
  })
  test("a new request cannot inherit a previous round's result or clarification", () => {
    const view = taskView(snapshot({ transcript: { ...emptyTranscript(), messages: [
      { id: "old-request", message: { role: "user", content: "Check weather" } },
      { id: "old-reply", message: { role: "assistant", content: "Which city?" } },
      { id: "new-request", message: { role: "user", content: "Open the browser" } },
    ] } }))
    expect(view).toMatchObject({ goal: "Open the browser", latestReply: "", state: "idle" })
  })
})
