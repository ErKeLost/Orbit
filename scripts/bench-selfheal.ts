#!/usr/bin/env bun
// Self-heal check: learn on one layout, then replay after the app "updated"
// (renamed/moved controls). Replay must never act on the wrong target; it
// must fall back to Jev and still pass.
import { chat, fixtureClient, type Fixture } from "./cu-fixtures/fixtures.ts"
import { runGuiTaskEngine } from "../src-tauri/resources/computer-use/gui-task-engine.ts"
import { createInMemoryMemory } from "../src-tauri/resources/computer-use/affordance-memory.ts"

const memory = createInMemoryMemory()
const run = async (fixture: Fixture) => {
  const result = await runGuiTaskEngine({
    input: { ...fixture.task, budget: { maxActions: 14, maxDecisions: 24, maxDurationMs: 120_000 } },
    client: fixtureClient(fixture), memory, confirm: async () => true,
    resolveApp: async app => ({ displayName: app, bundleId: app, path: "/x", launchId: app }),
  })
  return { pass: fixture.success() && !fixture.violation?.() && result.status === "done", violation: fixture.violation?.(), status: result.status, jev: result.metrics.jevCalls, replayed: result.metrics.replayedSteps, notes: result.trace.filter(t => t.note?.includes("memory")).map(t => t.note) }
}
console.log("learn     ", await run(chat()))
// "App update": the send button is renamed and the contact list reordered.
const updated = (): Fixture => {
  const f = chat()
  const render = f.render
  f.render = () => {
    const tree = render()
    const rename = (n: any): any => ({ ...n, ...(n.id === "send" ? { name: "发送消息" } : {}), children: n.children?.map(rename) })
    const out = rename(tree)
    const contacts = out.children.find((c: any) => c.id === "contacts")
    contacts.children.reverse()
    return out
  }
  return f
}
console.log("after-update", await run(updated()))
console.log("replay-again", await run(updated()))
