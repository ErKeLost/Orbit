/** The shell sees only executable paths and arguments. Private environment
 * values are loaded inside Node, never interpolated into Terminal history. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [settingsDir, cwd, program, ...args] = process.argv.slice(2);
const read = (name: string): Record<string, unknown> => {
  const path = join(settingsDir, name);
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
  catch { throw new Error("Pi 运行配置无法读取，请在 Orbit 设置中重新保存"); }
};
const settings = read("runtime.json") as { environment?: { name: string; value: string; sensitive: boolean }[] };
const secrets = read("runtime-secrets.json");
const env = { ...process.env };
for (const variable of settings.environment ?? []) {
  const value = variable.sensitive ? secrets[variable.name] : variable.value;
  if (typeof value !== "string") throw new Error(`环境变量 ${variable.name} 需要重新设置`);
  env[variable.name] = value;
}
const child = spawn(program, args, { cwd, env, stdio: "inherit", shell: false });
child.on("error", () => { console.error("无法启动配置的 Pi 可执行文件"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
