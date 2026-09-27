#!/usr/bin/env bun
// Jev-in-the-loop benchmark on simulated apps. The real engine, candidate
// compiler and live Jev run; only the OS is simulated. Success comes from each
// fixture's own state, never from Jev's DONE.
//
//   bun scripts/bench-fixtures.ts [--runs 3] [--only calculator,chat] [--memory] [--out file.json]
import { writeFile } from "node:fs/promises"
import { ALL_FIXTURES, fixtureClient } from "./cu-fixtures/fixtures.ts"
import { runGuiTaskEngine } from "../src-tauri/resources/computer-use/gui-task-engine.ts"
import { createInMemoryMemory } from "../src-tauri/resources/computer-use/affordance-memory.ts"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const runs = Math.max(1, Number(flag("--runs") ?? 1))
const only = flag("--only")?.split(",")
const verbose = args.includes("--verbose")
const memory = args.includes("--memory") ? createInMemoryMemory() : undefined
const lookahead = Number(flag("--lookahead") ?? 0)
const names = Object.keys(ALL_FIXTURES).filter(name => !only || only.includes(name))

type Row = { fixture: string; run: number; pass: boolean; status: string; ms: number; jev: number; replayed: number; ahead: number; actions: number; decisionMs: number; violation?: string; steps: string }
const rows: Row[] = []
for (let run = 1; run <= runs; run++) {
  for (const name of names) {
    const fixture = ALL_FIXTURES[name]()
    const log: string[] = []
    const result = await runGuiTaskEngine({
      input: { ...fixture.task, budget: fixture.task.budget ?? { maxActions: 14, maxDecisions: 24, maxDurationMs: 180_000 }, ...(lookahead ? { lookahead } : {}) },
      client: fixtureClient(fixture, log),
      resolveApp: async app => ({ displayName: app, bundleId: `fixture.${app}`, path: `/Applications/${app}.app`, launchId: `fixture.${app}` }),
      memory,
      // Benchmarks never approve irreversible steps automatically.
      confirm: async () => true,
    })
    const violation = fixture.violation?.()
    const pass = fixture.task.readOnly
      ? result.status === "done" && log.length === 0
      : fixture.success() && !violation && result.status === "done"
    const m = result.metrics
    rows.push({ fixture: name, run, pass, status: result.status, ms: m.elapsedMs, jev: m.jevCalls, replayed: m.replayedSteps, ahead: m.lookaheadSteps, actions: result.actions, decisionMs: Math.round(m.decisionMs), ...(violation ? { violation } : {}), steps: result.trace.filter(t => t.operation).map(t => `${t.source === "memory" ? "M:" : t.source === "lookahead" ? "L:" : ""}${t.operation}${t.verdict ? `!${t.verdict}` : ""}`).join(" ") })
    console.error(`[${run}] ${pass ? "PASS" : "FAIL"} ${name}: ${result.status} ${m.elapsedMs}ms jev=${m.jevCalls} actions=${result.actions}${violation ? ` VIOLATION=${violation}` : ""}`)
    if (verbose || !pass) {
      for (const t of result.trace) console.error(`    ${t.step} ${t.source ?? ""} ${t.operation ?? ""} ${t.confidence?.toFixed(2) ?? ""} ${(t.candidate ?? "").slice(0, 110)} → ${t.outcome ?? ""} ${t.verdict ?? ""} ${t.note ? `(${t.note.slice(0, 160)})` : ""}`)
      console.error(`    actions: ${log.join(" | ")}`)
    }
  }
}
console.table(rows.map(({ steps: _steps, ...row }) => row))
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
for (let run = 1; run <= runs; run++) {
  const subset = rows.filter(row => row.run === run)
  console.log(`run ${run}: pass ${subset.filter(r => r.pass).length}/${subset.length}  median ${median(subset.map(r => r.ms))}ms  jev/task ${(subset.reduce((a, r) => a + r.jev, 0) / Math.max(1, subset.length)).toFixed(2)}  actions/task ${(subset.reduce((a, r) => a + r.actions, 0) / Math.max(1, subset.length)).toFixed(2)}`)
}
const out = flag("--out")
if (out) await writeFile(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2))
