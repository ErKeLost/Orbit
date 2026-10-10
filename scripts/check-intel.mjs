#!/usr/bin/env node
/**
 * Verify the Intel macOS build locally, before a CI round trip.
 *
 * `bun run check` and a plain `cargo check` both compile for the *host*. On an
 * Apple Silicon machine that means nothing in this repository compiles the
 * shipped `x86_64-apple-darwin` target until the release job does — the same
 * blind spot `check-android.mjs` exists for, found in the most expensive place
 * possible. The 45-minute Release job is not where a type error should surface.
 *
 * Two binaries, because the release ships two. `ax_control` is a separate
 * executable behind the `ax-control` feature, is built for the target by
 * `scripts/sync-worker.mjs`, and is what the Accessibility grant is attached to.
 *
 * Usage: `node scripts/check-intel.mjs`
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = "x86_64-apple-darwin";

if (process.platform !== "darwin") {
  console.error(`check-intel 只在 macOS 上有意义：目标 ${target} 需要 Xcode 的 SDK。`);
  process.exit(1);
}

const targets = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
if (!targets.stdout?.split("\n").includes(target)) {
  console.error(`未安装 ${target} 的标准库。先执行：\n\n  rustup target add ${target}\n`);
  process.exit(1);
}

process.stdout.write(`\n▸ Rust：${target} 类型检查（orbit + ax_control）\n`);
const check = spawnSync(
  "cargo",
  [
    "check",
    "--manifest-path", resolve(root, "src-tauri/Cargo.toml"),
    "--target", target,
    "--bin", "orbit",
    "--bin", "ax_control",
    "--features", "ax-control",
  ],
  { stdio: "inherit" },
);

if (check.status !== 0) {
  console.error("\n✗ Intel macOS 构建失败\n");
  process.exit(check.status ?? 1);
}
process.stdout.write("\n✓ Intel macOS 构建通过\n");
