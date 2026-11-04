/** Packaged OAuth smoke checks. Uses only synthetic credentials and blocks
 * every network request while loading each bundled provider's login flow. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = resolve(process.argv[2] || "src-tauri/resources/pi-runtime");
const fixture = mkdtempSync(join(tmpdir(), "orbit-provider-check-"));
try {
  const runtimeDir = join(fixture, "runtime");
  cpSync(source, runtimeDir, { recursive: true });
  const agentDir = join(fixture, "agent");
  mkdirSync(agentDir);
  const authPath = join(agentDir, "auth.json");
  const credentials = {
    anthropic: { type: "oauth", access: "synthetic-access-secret", refresh: "synthetic-refresh-secret", expires: 1 },
    unrelated: { type: "api_key", key: "synthetic-key-secret" },
  };
  writeFileSync(authPath, JSON.stringify(credentials));
  function run(operation, provider) {
    const result = spawnSync(process.execPath, [join(runtimeDir, "provider-auth.js"), operation, agentDir, ...(provider ? [provider] : [])], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 35_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(!result.stdout.includes("synthetic-access-secret") && !result.stdout.includes("synthetic-refresh-secret") && !result.stdout.includes("synthetic-key-secret"), "no credential values cross the process boundary");
    return JSON.parse(result.stdout.trim());
  }
  const snapshot = run("list").data;
  const expected = ["anthropic", "openai", "openai-codex", "github-copilot", "kimi-coding", "openrouter", "meta", "xai", "radius"];
  assert.deepEqual(snapshot.auth.map(item => item.id).sort(), expected.sort());
  assert(snapshot.auth.find(item => item.id === "anthropic").oauth);
  assert(snapshot.profiles.find(item => item.id === "anthropic").models.length > 0);
  assert(run("catalog-stored", "anthropic").data.data.length > 0, "native default selection can validate against the offline catalog");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), credentials, "status reads never refresh expired tokens");
  run("logout", "anthropic");
  assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), { unrelated: credentials.unrelated });

  const { ModelRuntime } = await import(pathToFileURL(join(runtimeDir, "index.js")).href);
  const runtime = await ModelRuntime.create({ authPath, modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
  const sentinel = new Error("offline-flow-check");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw sentinel; };
  try {
    for (const providerId of expected) {
      const controller = new AbortController();
      controller.abort(sentinel);
      await assert.rejects(runtime.getProvider(providerId).auth.oauth.login({
        signal: controller.signal,
        prompt: async () => { throw sentinel; },
        notify: () => {},
      }, { getDeviceId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), error => {
        assert(!/module|cannot find|resolve|ENOENT/i.test(error.message), `${providerId} flow must be embedded: ${error.message}`);
        return true;
      });
    }
  } finally { globalThis.fetch = originalFetch; }
  const localSettings = join(fixture, "local-settings");
  mkdirSync(localSettings);
  writeFileSync(join(localSettings, "runtime.json"), JSON.stringify({ environment: [{ name: "PI_TEST_SECRET", value: "", sensitive: true, valueRedacted: true }] }));
  writeFileSync(join(localSettings, "runtime-secrets.json"), JSON.stringify({ PI_TEST_SECRET: "terminal-test-secret" }));
  const terminal = spawnSync(process.execPath, [join(runtimeDir, "terminal.js"), localSettings, fixture, process.execPath, "-e", "require('node:assert/strict').equal(process.env.PI_TEST_SECRET, 'terminal-test-secret'); console.log('environment-applied')"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.equal(terminal.stdout.trim(), "environment-applied");
  console.log("provider auth ok: 9 bundled OAuth flows, redacted discovery, read-only status, isolated logout and private terminal environment");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
