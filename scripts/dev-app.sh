#!/usr/bin/env bash
# 把 debug 版 Orbit 装进一个真的 .app，再 `open` 它。
#
# 为什么需要这一步：`tauri dev` 直接跑 `target/debug/orbit` 这个裸二进制。麦克风这类
# 隐私接口由 TCC 管，TCC 只看**真实 app bundle** 里的 Info.plist；裸二进制没有 bundle，
# 于是第一次 getUserMedia 就被系统 SIGABRT 掉（崩溃报告里是 `Namespace TCC`），
# JS 层连 catch 的机会都没有。把 plist 用 `__TEXT,__info_plist` 链进二进制也**不足以**
# 骗过 TCC —— 试过，还是崩。
#
# 所以这里做一个最小 bundle：Info.plist 写用途声明，Resources 指回 target/debug/resources
# （Tauri 用 BaseDirectory::Resource 找 Pi runtime，那套路径不变），二进制是同一份 debug 构建，
# devUrl 仍然是 http://localhost:5173，所以前端照旧走 vite 的 HMR。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/src-tauri/target/debug/orbit"
RES="$ROOT/src-tauri/target/debug/resources"
APP="$ROOT/src-tauri/target/debug/Orbit Dev.app"

if [[ ! -x "$BIN" ]]; then
  echo "没有找到 $BIN，先跑一次 cargo build（或 bun run tauri:dev）" >&2
  exit 1
fi

mkdir -p "$APP/Contents/MacOS"

# 用途声明与 src-tauri/Info.plist 保持一致：打包版里 Tauri 会把那份合并进来，
# 这里手写一份是为了让 dev 也走同一条 TCC 判定。
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleExecutable</key>
  <string>orbit</string>
  <key>CFBundleIdentifier</key>
  <string>ai.pi.gui</string>
  <key>CFBundleName</key>
  <string>Orbit Dev</string>
  <key>CFBundleDisplayName</key>
  <string>Orbit Dev</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.18</string>
  <key>CFBundleVersion</key>
  <string>1.0.18</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Orbit 需要访问麦克风，用于语音 Agent 的对话与语音转写。录音仅用于识别与合成。</string>
</dict>
</plist>
PLIST

cp -f "$BIN" "$APP/Contents/MacOS/orbit"
# Tauri 的 resource base 是 `Contents/Resources`，而代码里取的是 `<base>/resources`，
# 所以里面要有一个叫 resources 的链接，指回 target/debug/resources（Pi runtime、
# node_modules、gui-extension 都在那儿）。直接链接 Contents/Resources 会多套一层。
# 上一版可能把 Contents/Resources 本身做成了链接（rm -rf 只拆链接，不跟进目标目录）。
rm -rf "$APP/Contents/Resources"
mkdir -p "$APP/Contents/Resources"
ln -sfn "$RES" "$APP/Contents/Resources/resources"

# ad-hoc 签名，让 TCC 有一条稳定的身份记录（每次重编都会变，所以会重新问一次权限）。
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

open -n "$APP"
echo "已启动 $(basename "$APP")（devUrl: http://localhost:5173）"
