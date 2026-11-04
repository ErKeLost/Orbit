import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "node_modules/@earendil-works/pi-coding-agent");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const output = resolve(root, "src-tauri/resources/pi-runtime");
const bun = process.env.ORBIT_BUN_PATH
  || (process.env.BUN_INSTALL ? resolve(process.env.BUN_INSTALL, "bin", process.platform === "win32" ? "bun.exe" : "bun") : "bun");
const marker = resolve(output, "package.json");
const current = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
const buildFormat = 6;
const runtimeSource = resolve(root, "scripts/pi-runtime");
const sourceHash = createHash("sha256");
for (const file of readdirSync(runtimeSource).sort()) {
  sourceHash.update(file).update(readFileSync(resolve(runtimeSource, file)));
}
const sourceDigest = sourceHash.digest("hex");

/** The sandbox compiles this wasm at runtime; it must sit where the bundled
 * runtime's createRequire can resolve `quickjs-wasi/quickjs.wasm`. */
const quickjsPackage = resolve(root, "node_modules/quickjs-wasi");

/** Fail the build if the bundled runtime cannot actually start a codemode script. */
function verifyCodemode() {
  const check = spawnSync(process.execPath, [resolve(root, "scripts/check-codemode.mjs"), output], { cwd: root, stdio: "inherit" });
  if (check.error) console.error(`无法运行 codemode 校验: ${check.error.message}`);
  if (check.status !== 0) process.exit(check.status ?? 1);
}

const nodeRuntime = spawnSync(process.execPath, [resolve(root, "scripts/sync-node-runtime.mjs")], { cwd: root, stdio: "inherit" });
if (nodeRuntime.status !== 0) process.exit(nodeRuntime.status ?? 1);

const computerUse = spawnSync(process.execPath, [resolve(root, "scripts/sync-computer-use.mjs")], { cwd: root, stdio: "inherit" });
if (computerUse.status !== 0) process.exit(computerUse.status ?? 1);

// Playwright controls the CEF page via a native CDP relay; it launches no browser.
for (const name of ["playwright-core", "ws"]) {
  const destination = resolve(root, "src-tauri/resources/node_modules", name);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(resolve(root, "node_modules", name), destination, { recursive: true, dereference: true });
}
if (current?.version === packageJson.version && current?.buildFormat === buildFormat && current?.sourceDigest === sourceDigest && existsSync(resolve(output, "cli.js")) && existsSync(resolve(output, "index.js")) && existsSync(resolve(output, "provider-auth.js")) && existsSync(resolve(output, "terminal.js")) && existsSync(resolve(output, "codemode-worker.js"))) {
  verifyCodemode();
  process.exit(0);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const result = spawnSync(bun, [
  "build",
  resolve(root, "scripts/pi-runtime/cli.ts"),
  resolve(root, "scripts/pi-runtime/index.ts"),
  resolve(root, "scripts/pi-runtime/provider-auth.ts"),
  resolve(root, "scripts/pi-runtime/terminal.ts"),
  "--target=node",
  "--format=esm",
  "--splitting",
  `--outdir=${output}`,
  "--external=@silvia-odwyer/photon-node",
  "--define=PI_BUNDLED_NODE=true",
  "--sourcemap=none",
], { cwd: root, stdio: "inherit" });

if (result.error) console.error(`无法启动 Bun 打包 Pi runtime: ${result.error.message}`);
if (result.status !== 0) process.exit(result.status ?? 1);

// Separate self-contained build so the output lands as `codemode-worker.js` at
// the runtime root (Bun names entrypoints relative to the working directory).
const workerBuild = spawnSync(bun, [
  "build",
  "codemode-worker.ts",
  "--target=node",
  "--format=esm",
  `--outdir=${output}`,
  "--define=PI_BUNDLED_NODE=true",
  "--sourcemap=none",
], { cwd: resolve(root, "scripts"), stdio: "inherit" });

if (workerBuild.error) console.error(`无法启动 Bun 打包 codemode worker: ${workerBuild.error.message}`);
if (workerBuild.status !== 0) process.exit(workerBuild.status ?? 1);

const themeSource = resolve(packageRoot, "dist/modes/interactive/theme");
const themeTarget = resolve(output, "dist/modes/interactive/theme");
mkdirSync(dirname(themeTarget), { recursive: true });
cpSync(themeSource, themeTarget, { recursive: true });

for (const relative of ["dist/core/export-html", "dist/modes/interactive/assets"]) {
  const source = resolve(packageRoot, relative);
  if (!existsSync(source)) continue;
  const target = resolve(output, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

const photonSource = resolve(root, "node_modules/@silvia-odwyer/photon-node");
const photonTarget = resolve(output, "node_modules/@silvia-odwyer/photon-node");
mkdirSync(dirname(photonTarget), { recursive: true });
cpSync(photonSource, photonTarget, { recursive: true });

// Ship the QuickJS wasm plus the package manifest (its `exports` map is what
// make `createRequire(...).resolve("quickjs-wasi/quickjs.wasm")` work). The
// package's JS and native extensions are bundled into the worker, so they are
// not copied.
const quickjsTarget = resolve(output, "node_modules/quickjs-wasi");
mkdirSync(quickjsTarget, { recursive: true });
cpSync(resolve(quickjsPackage, "package.json"), resolve(quickjsTarget, "package.json"));
cpSync(resolve(quickjsPackage, "quickjs.wasm"), resolve(quickjsTarget, "quickjs.wasm"));

verifyCodemode();

writeFileSync(marker, `${JSON.stringify({ name: "orbit-pi-runtime", private: true, type: "module", version: packageJson.version, buildFormat, sourceDigest }, null, 2)}\n`);
