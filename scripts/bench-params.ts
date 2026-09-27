#!/usr/bin/env bun
// Parameterized memory: learn a task once, then run the same task shape with
// a different item. Expect replay with ~1 Jev call and zero violations.
import { chat, longList, fixtureClient, type Fixture } from "./cu-fixtures/fixtures.ts"
import { runGuiTaskEngine } from "../src-tauri/resources/computer-use/gui-task-engine.ts"
import { createInMemoryMemory } from "../src-tauri/resources/computer-use/affordance-memory.ts"

const memory = createInMemoryMemory()
let failures = 0
async function run(label: string, fixture: Fixture) {
  const result = await runGuiTaskEngine({
    input: { ...fixture.task, budget: { maxActions: 14, maxDecisions: 24, maxDurationMs: 120_000 } },
    client: fixtureClient(fixture), memory, confirm: async () => true,
    resolveApp: async app => ({ displayName: app, bundleId: app, path: "/x", launchId: app }),
  })
  const violation = fixture.violation?.()
  const pass = fixture.success() && !violation && result.status === "done"
  if (!pass) failures++
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: ${result.status} jev=${result.metrics.jevCalls} replayed=${result.metrics.replayedSteps} ${violation ?? ""} ${result.trace.filter(t => t.note?.includes("memory")).map(t => t.note).join(" ")}`)
}
await run("chat learn 李四", chat("李四"))
await run("chat param 王五", chat("王五"))
await run("chat param 产品工作群", chat("产品工作群"))
await run("contacts learn 赵六", longList("赵六"))
await run("contacts param 联系人 05", longList("联系人 05"))
await run("contacts param 联系人 38", longList("联系人 38"))
process.exit(failures ? 1 : 0)
