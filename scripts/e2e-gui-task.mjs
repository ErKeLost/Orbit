#!/usr/bin/env node
// Dev E2E: natural-language prompt -> dev Pi RPC -> gui_task -> Jev -> dev ax_control.
// Usage: node scripts/e2e-gui-task.mjs "在汽水音乐中搜索 石齐白的蓝 并播放" [timeoutSec]
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const prompt = process.argv[2];
const timeoutSec = Number(process.argv[3] || 300);
if (!prompt) {
  console.error("usage: node scripts/e2e-gui-task.mjs <prompt> [timeoutSec]");
  process.exit(64);
}
const root = process.cwd();
const b = spawnSync(process.execPath, [resolve(root, "scripts/bundle-pi.mjs")], { cwd: root, stdio: "inherit" });
if (b.status !== 0) process.exit(b.status ?? 1);

const iso = mkdtempSync(resolve(tmpdir(), "orbit-e2e-"));
const res = resolve(iso, "resources");
mkdirSync(res, { recursive: true });
for (const n of ["pi-runtime", "subagents", "computer-use", "browser-use", "node_modules", "node-runtime"])
  cpSync(resolve(root, "src-tauri/resources", n), resolve(res, n), { recursive: true });
for (const n of ["gui-extension.ts", "search-tools.ts", "web-search.ts", "context-payload.ts", "workspace.ts"])
  cpSync(resolve(root, "src-tauri/resources", n), resolve(res, n));
cpSync(resolve(root, "src-tauri/target/debug/ax_control"), resolve(iso, "ax_control"));

const cli = resolve(res, "pi-runtime/cli.js");
const ext = resolve(res, "gui-extension.ts");
const node = resolve(res, "node-runtime", process.platform === "win32" ? "node.exe" : "node");
const env = {
  ...process.env,
  NODE_PATH: resolve(res, "node_modules"),
  ORBIT_PI_CLI_PATH: cli,
  ORBIT_PI_NODE_PATH: node,
  ORBIT_XA11Y_WORKER: resolve(iso, "ax_control"),
  JITI_FS_CACHE: "false",
};
const child = spawn(node, [cli, "--mode", "rpc", "--no-session", "--extension", ext], {
  cwd: root, env, stdio: ["pipe", "pipe", "pipe"],
});
let buf = "", seq = 0;
const pending = new Map();
const tools = [];
const req = (c) => new Promise((ok, no) => {
  const id = String(++seq);
  pending.set(id, { ok, no });
  child.stdin.write(JSON.stringify({ ...c, id }) + "\n");
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (x) => {
  buf += x;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(e.method)) {
      // Plays the user: approve confirmations only when E2E_CONFIRM=yes.
      const approve = process.env.E2E_CONFIRM === "yes"
      console.log(`?? ${e.method}: ${e.title ?? ""} | ${String(e.message ?? "").replace(/\n/g, " / ")} -> ${approve ? "CONFIRM" : "DECLINE"}`)
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: e.id, ...(e.method === "confirm" ? { confirmed: approve } : { cancelled: true }) }) + "\n")
    }
    if (e.type === "tool_execution_start") console.log(`>> ${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 400)}`);
    if (e.type === "tool_execution_update" && e.toolName === "gui_task") {
      const event = e.partialResult?.details?.event ?? e.result?.details?.event;
      if (event?.type === "decided" || event?.type === "acted") {
        console.log(`.. ${event.type} ${String(event.payload?.operation ?? "")} ${String(event.payload?.candidate ?? "").slice(0, 160)} ${String(event.payload?.outcome ?? "")}`);
      }
    }
    if (e.type === "tool_execution_end") {
      const text = e.result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
      tools.push({ tool: e.toolName, isError: e.isError, text });
      console.log(`<< ${e.toolName}${e.isError ? " (error)" : ""}\n${text.slice(0, 4000)}\n`);
    }
    if (e.type === "response" && pending.has(e.id)) {
      const p = pending.get(e.id); pending.delete(e.id);
      e.success ? p.ok(e.data) : p.no(new Error(e.error));
    }
    if (e.type === "agent_settled" && pending.has("settled")) { pending.get("settled").ok(); pending.delete("settled"); }
  }
});
child.stderr.on("data", (x) => process.stderr.write(String(x)));

const finish = (code) => {
  const out = resolve(root, "work", `e2e-${Date.now()}.json`);
  try { mkdirSync(resolve(root, "work"), { recursive: true }); writeFileSync(out, JSON.stringify({ prompt, tools }, null, 2)); console.log(`trace: ${out}`); } catch {}
  child.stdin.end(); if (child.exitCode === null) child.kill();
  rmSync(iso, { recursive: true, force: true });
  process.exit(code);
};
const t = setTimeout(() => { console.log("TIMEOUT"); finish(2); }, timeoutSec * 1000);
try {
  await req({ type: "prompt", message: '/gui-computer-use-mode {"enabled":true}' });
  const settled = new Promise((ok, no) => pending.set("settled", { ok, no }));
  await req({ type: "prompt", message: prompt });
  await settled;
  const last = await req({ type: "get_last_assistant_text" });
  console.log("FINAL:", last?.text ?? "");
  const gui = tools.filter((x) => x.tool === "gui_task");
  const done = gui.length > 0 && /^\[done\]/i.test(gui.at(-1).text);
  console.log(`GUI_TASK_CALLS=${gui.length} LAST_DONE=${done}`);
  clearTimeout(t);
  finish(done ? 0 : 1);
} catch (e) {
  console.error("ERROR", String(e)); clearTimeout(t); finish(1);
}
