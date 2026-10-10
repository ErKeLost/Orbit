#!/usr/bin/env node
/**
 * Verify the Android build locally, before a 25-minute CI round trip.
 *
 * `bun run check` and `cargo check` both compile for the *host*, so a change that
 * only breaks the Android target is invisible until the release job fails — which
 * is exactly what happened when `mobile_background::init` was defined inside
 * `#[cfg(target_os = "android")]` but re-exported nowhere: two workflows failed,
 * one of them after 25 minutes, on a one-line mistake.
 *
 * Two halves, because they fail differently:
 *
 * 1. `cargo check --target aarch64-linux-android` for the Rust that is compiled
 *    under a `cfg` the host never sees.
 * 2. `:app:compileArmDebugKotlin` for the hand-written Kotlin, which no other
 *    command in this repository touches.
 *
 * Usage: `node scripts/check-android.mjs [--rust-only]`
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const target = "aarch64-linux-android";
const rustOnly = process.argv.includes("--rust-only");

/**
 * The NDK's clang is versioned (`aarch64-linux-android24-clang`) and `cc-rs`
 * looks for an unversioned name, so both `CC` and the PATH have to be set for
 * the C dependencies' build scripts.
 */
function findNdk() {
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.NDK_HOME,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, "ndk"),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, "ndk"),
    join(homedir(), "Library/Android/sdk/ndk"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    // Either an SDK's `ndk/` directory of versions, or one version directly.
    if (existsSync(join(candidate, "toolchains"))) {
      const tools = join(candidate, "toolchains/llvm/prebuilt");
      const host = existsSync(tools) ? readdirSync(tools)[0] : undefined;
      if (host) return join(tools, host);
      continue;
    }
    const versions = readdirSync(candidate).sort();
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    const tools = join(candidate, latest, "toolchains/llvm/prebuilt");
    if (!existsSync(tools)) continue;
    const host = readdirSync(tools)[0];
    if (host) return join(tools, host);
  }
  return null;
}

function run(label, command, args, options = {}) {
  process.stdout.write(`\n▸ ${label}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败`);
    process.exit(result.status ?? 1);
  }
}

const ndk = findNdk();
if (!ndk) {
  console.error(
    "找不到 Android NDK。设置 ANDROID_NDK_HOME，或把 NDK 装到 ~/Library/Android/sdk/ndk/。\n" +
    "需要的版本见 docs/MOBILE.md 的 Android toolchain 一节。",
  );
  process.exit(1);
}
const clang = join(ndk, "bin", `${target}24-clang`);
if (!existsSync(clang)) {
  console.error(`NDK 里没有 ${clang}；这个 NDK 版本可能太旧或太新。`);
  process.exit(1);
}

run("Rust：aarch64-linux-android 类型检查", "cargo", ["check", "--offline", "--target", target], {
  cwd: join(root, "src-tauri"),
  env: {
    ...process.env,
    PATH: `${join(ndk, "bin")}:${process.env.PATH}`,
    [`CC_${target.replaceAll("-", "_")}`]: clang,
    [`AR_${target.replaceAll("-", "_")}`]: join(ndk, "bin", "llvm-ar"),
    [`CARGO_TARGET_${target.replaceAll("-", "_").toUpperCase()}_LINKER`]: clang,
  },
});

if (rustOnly) {
  process.stdout.write("\n✓ Rust 通过（--rust-only，未编译 Kotlin）\n");
  process.exit(0);
}

// The Kotlin is hand-written under `gen/android`, which is generated once and
// then owned by this repository; nothing else compiles it.
run("Kotlin：compileArmDebugKotlin", "./gradlew", [":app:compileArmDebugKotlin"], {
  cwd: join(root, "src-tauri/gen/android"),
  env: {
    ...process.env,
    ANDROID_HOME: process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk"),
    ANDROID_NDK_HOME: ndk.split("/toolchains/")[0],
  },
});

process.stdout.write("\n✓ Android 构建通过\n");
