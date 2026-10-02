/**
 * Verifies the codemode sandbox can actually start from a bundled Pi runtime.
 *
 * Pi's `bundled-node` mode expects two artifacts that a plain `bun build` does
 * not emit by itself:
 *   - `codemode-worker.js` next to the runtime chunks
 *   - `quickjs-wasi/quickjs.wasm` resolvable from the runtime directory
 *
 * This runs one real script through the bundled worker and wasm, so a missing
 * or stale artifact fails the build instead of failing at runtime. Pass a
 * runtime directory as the first argument to check an isolated copy (the smoke
 * test does this); it defaults to the resources runtime.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(process.argv[2] ?? resolve(root, "src-tauri/resources/pi-runtime"));
const worker = resolve(runtime, "codemode-worker.js");
const wasm = resolve(runtime, "node_modules/quickjs-wasi/quickjs.wasm");

assert.ok(existsSync(worker), `codemode worker entry is missing: ${worker}`);
assert.ok(existsSync(wasm), `quickjs wasm is missing: ${wasm}`);

const sandbox = new CodemodeSandbox({
  tools: [{ name: "echo", description: "Echo the arguments back", execute: (args) => args }],
  workerUrl: pathToFileURL(worker),
  wasm: await loadQuickJSWasm(wasm),
  timeoutMs: 20_000,
});

try {
  const result = await sandbox.execute(`
    const value = await tools.echo({ n: 41 });
    text("sandbox ok");
    return value.n + 1;
  `);
  assert.ok(result.ok, `codemode sandbox failed: ${result.ok ? "" : JSON.stringify(result.error)}`);
  assert.equal(result.value, 42, "sandbox return value");
  assert.ok(result.output.some((item) => item.type === "text" && item.text === "sandbox ok"), "sandbox text output");
  assert.equal(result.calls.length, 1, "sandbox records the tool call");
  console.log(`codemode sandbox ok (${result.calls.length} tool call, ${result.calls[0].durationMs}ms)`);
} finally {
  await sandbox.close();
}
