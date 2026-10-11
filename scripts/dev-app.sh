#!/bin/bash
# 以独立 .app 的身份启动 dev 二进制。
#
# 为什么存在：`tauri dev` 跑的是裸二进制（target/debug/orbit），麦克风权限（TCC）
# 检查的是「责任进程」的 Info.plist。当这个二进制由别的 GUI 应用（比如生产版
# Orbit，或我这个 agent 的会话）代启时，责任进程是对方——它没有
# NSMicrophoneUsageDescription，第一次 getUserMedia 就被 macOS 直接 SIGABRT。
# 包一层 bundle 再 `open`，LaunchServices 把它当成独立应用，权限框才会正常弹，
# 允许一次以后一直有效。
#
# 用法：先有 vite 在跑（bun run dev / tauri:dev 都行），然后：
#   scripts/dev-app.sh          # 构建 bundle 并启动
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$root/src-tauri/target/debug/orbit"
app="$root/src-tauri/target/debug/ODev.app"

[ -x "$bin" ] || { echo "没有 dev 二进制：先跑一次 bun run tauri:dev（或 cargo build）" >&2; exit 1; }

mkdir -p "$app/Contents/MacOS"
# 硬链接而不是复制：120MB 的二进制不用拷第二份，而且 cargo 重编后旧链接仍指向
# 旧 inode，重跑本脚本即刷新。
ln -f "$bin" "$app/Contents/MacOS/orbit"
# tauri dev 的资源目录按 exe 同级的 resources/ 解析；bundle 里补一条相对路径。
ln -sfn ../../../../resources "$app/Contents/MacOS/resources"
ln -sfn ../../../resources "$app/Contents/Resources"

if [ ! -f "$app/Contents/Info.plist" ]; then
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleName</key>
    <string>Orbit Dev</string>
    <key>CFBundleDisplayName</key>
    <string>Orbit Dev</string>
    <key>CFBundleIdentifier</key>
    <string>ai.pi.gui.dev</string>
    <key>CFBundleExecutable</key>
    <string>orbit</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>NSMicrophoneUsageDescription</key>
    <string>Orbit 需要访问麦克风，把你说的话转写成文字填入输入框。录音仅用于语音转写。</string>
  </dict>
</plist>
PLIST
fi

open "$app"
echo "已启动 $app（麦克风权限首次会弹框，点允许）"
