#!/usr/bin/env bun
// Computer Use benchmark: drives the real engine (dev ax_control worker + live
// Jev) over a fixed task list and reports success, latency and Jev calls.
//
// Usage:
//   bun scripts/bench-gui-task.ts scripts/bench-tasks.example.json [--runs 2] [--no-memory] [--out bench.json]
//
// Run it twice (or with --runs 2) to measure Affordance Memory: run 1 learns,
// run 2 should replay with ~1 Jev call. Tasks must be safe and idempotent.
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createXa11yClient } from "../src-tauri/resources/computer-use/xa11y-client.ts"
import { runGuiTaskEngine } from "../src-tauri/resources/computer-use/gui-task-engine.ts"
import { createFileMemory } from "../src-tauri/resources/computer-use/affordance-memory.ts"
import type { GuiTaskInput, GuiTaskResult } from "../src-tauri/resources/computer-use/gui-task-contract.ts"

type BenchTask = Omit<GuiTaskInput, "budget"> & { name: string; budget?: GuiTaskInput["budget"]; expect?: GuiTaskResult["status"] }

const args = process.argv.slice(2)
const file = args.find(arg => !arg.startsWith("--"))
if (!file) {
  console.error("usage: bun scripts/bench-gui-task.ts <tasks.json> [--runs N] [--no-memory] [--out file]")
  process.exit(64)
}
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const runs = Math.max(1, Number(flag("--runs") ?? 1))
const useMemory = !args.includes("--no-memory")
const out = flag("--out")
const tasks = JSON.parse(await readFile(file, "utf8")) as BenchTask[]
// Isolated memory per benchmark invocation, so results are reproducible.
const memoryDir = await mkdtemp(join(tmpdir(), "orbit-bench-mem-"))
const memory = useMemory ? createFileMemory(join(memoryDir, "memory.json")) : undefined

type Row = { task: string; run: number; status: string; ok: boolean; ms: number; jev: number; replayed: number; actions: number; settleMs: number; observationMs: number; decisionMs: number; actionMs: number }
const rows: Row[] = []
try {
  for (let run = 1; run <= runs; run++) {
    for (const task of tasks) {
      const client = await createXa11yClient()
      try {
        const result = await runGuiTaskEngine({
          input: { ...task, budget: task.budget ?? { maxActions: 12, maxDecisions: 20, maxDurationMs: 120_000 } },
          client,
          memory,
          confirm: async () => false,
        })
        const m = result.metrics
        rows.push({ task: task.name, run, status: result.status, ok: result.status === (task.expect ?? "done"), ms: m.elapsedMs, jev: m.jevCalls, replayed: m.replayedSteps, actions: result.actions, settleMs: Math.round(m.settleMs), observationMs: Math.round(m.observationMs), decisionMs: Math.round(m.decisionMs), actionMs: Math.round(m.actionMs) })
        console.error(`[run ${run}] ${task.name}: ${result.status} ${m.elapsedMs}ms jev=${m.jevCalls} replayed=${m.replayedSteps}`)
      } finally {
        await client.dispose().catch(() => undefined)
      }
    }
  }
} finally {
  await rm(memoryDir, { recursive: true, force: true })
}

console.table(rows)
for (let run = 1; run <= runs; run++) {
  const subset = rows.filter(row => row.run === run)
  const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
  console.log(`run ${run}: success ${subset.filter(r => r.ok).length}/${subset.length}  median ${median(subset.map(r => r.ms))}ms  jev/task ${(subset.reduce((a, r) => a + r.jev, 0) / Math.max(1, subset.length)).toFixed(2)}  replayed ${subset.reduce((a, r) => a + r.replayed, 0)}`)
}
if (out) await writeFile(out, JSON.stringify({ at: new Date().toISOString(), memory: useMemory, rows }, null, 2))
