/** Opt-in live evaluation. Calls the configured Jev/Clef service; never dispatches work. */
import { decideVoice } from "../src-tauri/resources/voice/service.ts"
import type { VoiceIntent, VoiceRouteInput } from "../src-tauri/resources/voice/contract.ts"

const idle: Omit<VoiceRouteInput, "text"> = {
  focused: "voice", targets: [{ id: "voice", sessionFile: "/eval/voice", title: "语音会话", running: false, waiting: false }], history: [],
  focusedTask: { sessionFile: "/eval/voice", state: "idle", goal: "", latestReply: "", activeTools: [] },
}
const running: typeof idle = {
  ...idle, targets: [{ ...idle.targets[0]!, title: "修复登录", running: true }],
  focusedTask: { sessionFile: "/eval/voice", state: "running", goal: "修复登录问题", latestReply: "", activeTools: ["read"] },
}
type Case = { input: VoiceRouteInput; expected: VoiceIntent[] }
const cases: Case[] = []
const add = (text: string, expected: VoiceIntent | VoiceIntent[], context = idle) => cases.push({ input: { ...context, text }, expected: Array.isArray(expected) ? expected : [expected] })
add("打开浏览器", "dispatch_task")
add("开百度", "dispatch_task")
add("查北京今天的天气预报", "lookup")
add("这个仓库有哪些待办事项？", "lookup")
add("天气为什么会变冷", "general_question")
add("你好，今天心情不错", ["general_question", "chat"])
add("开始一个任务", "clarify")
add("打开浏览器", "dispatch_task", running)
add("现在做到哪了", "query_progress", running)
add("为什么选择这个修复方案？", "analyze_session", running)
add("继续做，完成告诉我", "watch_task", running)
add("别修登录了，改修支付问题", "steer_task", running)
add("别做这个了，改查上海天气", "steer_task", running)
add("做完以后补测试", "queue_task", running)
add("等这个结束后查北京天气", "queue_task", running)
add("停止当前任务", "control_task", running)
add("别念了，任务继续", "control_voice", running)
add("不要挂断，我只是让你别念了", "control_voice", running)
add("结束语音通话，任务继续", "control_voice", running)
add("先不要打开浏览器", ["clarify", "general_question", "chat"], idle)
add("可以", ["clarify", "general_question", "chat"], idle)
add("北京", "lookup", { ...idle, focusedTask: { sessionFile: "/eval/voice", state: "settled", goal: "查天气预报", latestReply: "你想查询哪个城市？", activeTools: [] } })
const confirmation = { ...running, confirmation: { id: "confirm", method: "confirm" as const, question: "确认提交这份表单吗？", announced: true } }
add("可以", "reply_confirmation", confirmation)
add("不要提交", "reply_confirmation", confirmation)


add("Weather.", "lookup", {...idle, history:[{role:"user",text:"Help me check beijing Wiser"},{role:"assistant",text:"What specifically would you like checked about Beijing Wiser—such as its weather, a company listing, or something in the current session?"}],pendingRequest:{text:"Help me check beijing Wiser",question:"What specifically would you like checked about Beijing Wiser—such as its weather, a company listing, or something in the current session?",attempts:1}})
add("Hi!", ["general_question", "chat"])

const repeats = Math.min(10, Math.max(1, Number(process.argv[2]) || 1))
const results: { text: string; expected: VoiceIntent[]; intent?: VoiceIntent; pass: boolean; ms?: number; reason?: string; error?: string }[] = []
for (let repeat = 0; repeat < repeats; repeat++) {
  for (let offset = 0; offset < cases.length; offset += 3) {
    await Promise.all(cases.slice(offset, offset + 3).map(async ({ input, expected }) => {
      try {
        const decision = await decideVoice(input, AbortSignal.timeout(14000))
        const result = { text: input.text, expected, intent: decision.intent, pass: expected.includes(decision.intent), ms: Math.round(decision.latencyMs), reason: decision.clarificationReason }
        results.push(result)
        console.log(JSON.stringify({ repeat: repeat + 1, ...result, ...(result.pass ? {} : { decision }) }))
      } catch (error) {
        const result = { text: input.text, expected, pass: false, error: error instanceof Error ? error.message : String(error) }
        results.push(result); console.log(JSON.stringify(result))
      }
    }))
  }
}
const latencies = results.flatMap(result => result.ms === undefined ? [] : [result.ms]).sort((a, b) => a - b)
const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)]
console.log(JSON.stringify({ total: results.length, passed: results.filter(result => result.pass).length, failed: results.filter(result => !result.pass).length, routingP50Ms: percentile(0.5), routingP95Ms: percentile(0.95) }))
if (results.some(result => !result.pass)) process.exitCode = 1
