import { describe, expect, test } from "vitest"
import { decisionFromAnswers, VOICE_ROUTING_THRESHOLDS } from "../../../../src-tauri/resources/voice/router.ts"
import type { VoiceRouteInput } from "../../../../src-tauri/resources/voice/contract.ts"

const input = (text: string, taskState = "idle", extra: Partial<VoiceRouteInput> = {}): VoiceRouteInput => ({
  text,
  focused: "voice-session",
  targets: [{ id: "voice-session", sessionFile: "/session.jsonl", title: "Current session", running: taskState === "running", waiting: false }],
  history: [],
  focusedTask: {
    sessionFile: "/session.jsonl",
    state: taskState,
    goal: taskState === "idle" ? "" : "Restart the collector",
    latestReply: taskState === "idle" ? "" : "The collector is still running.",
    activeTools: [],
  },
  ...extra,
})

type Answers = Parameters<typeof decisionFromAnswers>[0]

/** Heads omitted from the object are absent in the response, not zero. */
function route(text: string, answers: Partial<Answers>, taskState = "idle", extra: Partial<VoiceRouteInput> = {}) {
  return decisionFromAnswers(answers as Answers, input(text, taskState, extra), "fixture", 1)
}

const social = (score: number | undefined) => score === undefined ? {} : { commonConversationOnly: { noul: score } }
const actionability = (score: number | undefined) => score === undefined ? {} : { actionability: { noul: score } }
const mutation = (score: number | undefined) => score === undefined ? {} : { mutation: { noul: score } }

describe("voice routing: ordered gates", () => {
  test("a greeting stays in the voice lane even when the social head is unsure", () => {
    // Regression: "你好？" used to become a Pi lookup because 0.5 < 0.7.
    for (const score of [0.5, 0.62, undefined]) {
      expect(route("你好？", { effect: { choice: "respond", confidence: 0.88 }, ...social(score) }).intent).toBe("general_question")
      expect(route("Ah.", { effect: { choice: "respond", confidence: 0.9 }, ...social(score) }).intent).toBe("general_question")
    }
  })

  test("only the primary head may send work to Pi", () => {
    expect(route("你好？", { effect: { choice: "respond", confidence: 0.9 }, ...social(0.1) }).intent).toBe("general_question")
    expect(route("谢谢", { effect: { choice: "respond", confidence: 0.9 }, ...social(0.2) }).intent).toBe("general_question")
  })

  test("a missing head never dispatches a turn", () => {
    const decision = route("嗯", { effect: { choice: "clarify", confidence: 0.6 } })
    expect(decision.intent).toBe("clarify")
    expect(decision.clarificationReason).toBe("unclear_request")
  })

  test("progress questions read observed state instead of asking Pi", () => {
    const decision = route("现在做到哪了", {
      effect: { choice: "execute", confidence: 0.9 },
      observation: { choice: "progress", confidence: 0.9 },
      asksFocusedProgress: { noul: 0.93 },
      workKind: { choice: "action", confidence: 0.9 },
      ...actionability(0.9),
      ...mutation(0.9),
    }, "running")
    expect(decision.intent).toBe("query_progress")
    expect(decision.target).toBe("voice-session")
  })

  test("explanations of observed work stay on the voice lane, not a Pi lookup", () => {
    const decision = route("为什么这么改", {
      effect: { choice: "execute", confidence: 0.85 },
      observation: { choice: "analysis", confidence: 0.9 },
    }, "settled")
    expect(decision.intent).toBe("analyze_session")
  })

  test("reaffirming unchanged work only observes it", () => {
    const decision = route("继续做，完成告诉我", {
      effect: { choice: "execute", confidence: 0.9 },
      delivery: { choice: "unchanged", confidence: 0.9 },
      notify: { noul: 0.9 },
    }, "running")
    expect(decision.intent).toBe("watch_task")
  })
})

describe("voice routing: dispatch requires positive evidence", () => {
  test("a complete action request dispatches once", () => {
    const decision = route("重启采集器", {
      effect: { choice: "execute", confidence: 0.9 },
      workKind: { choice: "action", confidence: 0.9 },
      delivery: { choice: "additional", confidence: 0.9 },
      ...mutation(0.92),
      ...actionability(0.95),
    })
    expect(decision).toMatchObject({ intent: "dispatch_task", workKind: "action", target: "voice-session" })
  })

  test("an action without authorization asks instead of dispatching or chatting", () => {
    const decision = route("把那个弄一下", {
      effect: { choice: "execute", confidence: 0.9 },
      workKind: { choice: "action", confidence: 0.8 },
      delivery: { choice: "additional", confidence: 0.9 },
      ...actionability(0.8),
    })
    expect(decision.intent).toBe("clarify")
    expect(decision.clarificationReason).toBe("uncertain_authorization")
  })

  test("an informational request needs evidence to reach Pi", () => {
    expect(route("北京现在天气怎么样？", {
      effect: { choice: "execute", confidence: 0.9 },
      workKind: { choice: "lookup", confidence: 0.9 },
      delivery: { choice: "additional", confidence: 0.9 },
      ...actionability(0.9),
    }).intent).toBe("lookup")

    expect(route("北京现在天气怎么样？", {
      effect: { choice: "execute", confidence: 0.9 },
      workKind: { choice: "lookup", confidence: 0.9 },
      delivery: { choice: "additional", confidence: 0.9 },
    }).intent).toBe("clarify")
  })

  test("an execution turn without an outcome is clarified, not dispatched", () => {
    const decision = route("开始一个任务", { effect: { choice: "execute", confidence: 0.9 } })
    expect(decision.intent).toBe("clarify")
  })

  test("a question the voice model should not answer from memory asks once", () => {
    const decision = route("What should I do next?", {
      effect: { choice: "respond", confidence: 0.75 },
      ...social(0.3),
      ...actionability(0.8),
    })
    expect(decision.intent).toBe("clarify")
    expect(decision.clarificationReason).toBe("uncertain_intent")
  })
})

describe("voice routing: control and confirmations", () => {
  test("stopping speech never becomes a task", () => {
    expect(route("别念了", {
      effect: { choice: "voice_control", confidence: 0.95 },
      voiceControl: { choice: "stop_speech", confidence: 0.95 },
    })).toMatchObject({ intent: "control_voice", voiceControl: "stop_speech" })
  })

  test("an announced confirmation is answered through the gateway", () => {
    const decision = route("可以", {
      effect: { choice: "confirmation", confidence: 0.9 },
      confirmationAnswer: { choice: "confirm", confidence: 0.95 },
    }, "idle", { confirmation: { id: "dialog-1", question: "Delete the file?", announced: true, method: "confirm" } })
    expect(decision.intent).toBe("reply_confirmation")
    expect(decision.confirmationResponse).toMatchObject({ id: "dialog-1", action: "confirm" })
  })

  test("an unannounced confirmation cannot be answered", () => {
    const decision = route("可以", {
      effect: { choice: "confirmation", confidence: 0.9 },
      confirmationAnswer: { choice: "confirm", confidence: 0.95 },
    }, "idle", { confirmation: { id: "dialog-1", question: "Delete the file?", announced: false, method: "confirm" } })
    expect(decision.intent).toBe("clarify")
  })

  test("thresholds document the gates instead of a single social cutoff", () => {
    expect(VOICE_ROUTING_THRESHOLDS.action.actionability).toBe(0.75)
    expect(VOICE_ROUTING_THRESHOLDS.lookup.actionability).toBe(0.45)
  })
})
