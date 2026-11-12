#!/usr/bin/env bash
# 一条命令起语音通话的 Pi 服务端。
#
# 顺序是固定的：起隧道 → 把隧道的 wss 地址写回**已有的** Engine → 起服务。
# 地址每次重跑都会变，但 Engine ID 不变，所以应用里的设置不用再动一次。
set -euo pipefail
cd "$(dirname "$0")"

LOG_DIR="${LOG_DIR:-$HOME/Library/Logs/Orbit}"
mkdir -p "$LOG_DIR"
PORT="${PORT:-3001}"
WS_PATH="${WS_PATH:-/ws}"
CF="${CLOUDFLARED:-}"
if [ -z "$CF" ]; then
  for candidate in "$(command -v cloudflared 2>/dev/null || true)" /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared "$HOME/bin/cloudflared" /tmp/cloudflared; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { CF="$candidate"; break; }
  done
fi
[ -n "$CF" ] || { echo "找不到 cloudflared：brew install cloudflared"; exit 1; }
export PI_CWD="${PI_CWD:-$(cd ../.. && pwd)}"

# 密钥在 Pi 的 auth.json 里已经有了，除非显式覆盖，否则直接用它。
if [ -z "${ELEVENLABS_API_KEY:-}" ]; then
  ELEVENLABS_API_KEY=$(python3 - <<'PY'
import json, os
try:
    print(json.load(open(os.path.expanduser("~/.pi/agent/auth.json")))["elevenlabs"]["key"])
except Exception:
    print("")
PY
)
fi
[ -n "${ELEVENLABS_API_KEY:-}" ] || { echo "没有 ElevenLabs API Key：在「设置 → 语音」里填，或导出 ELEVENLABS_API_KEY"; exit 1; }
export ELEVENLABS_API_KEY

"$CF" tunnel --url "http://localhost:${PORT}" --no-autoupdate >"$LOG_DIR/speech-engine-tunnel.log" 2>&1 &
TUNNEL=$!
trap 'kill $TUNNEL 2>/dev/null || true; kill ${SERVER:-} 2>/dev/null || true' EXIT INT TERM

TUNNEL_LOG="$LOG_DIR/speech-engine-tunnel.log"
for _ in $(seq 1 60); do
  # 只认隧道横幅里那一条。错误行里也会出现 https://api.trycloudflare.com/tunnel，
  # 以前 head -1 抓到过它，于是把 Engine 指到了 Cloudflare 的 API 域名上。
  PUBLIC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" \
    | grep -vE '^https://(api|www)\.trycloudflare\.com$' | head -1 || true)
  [ -n "${PUBLIC_URL:-}" ] && break
  kill -0 "$TUNNEL" 2>/dev/null || { echo "隧道进程退出了："; tail -5 "$TUNNEL_LOG"; exit 1; }
  sleep 1
done
[ -n "${PUBLIC_URL:-}" ] || { echo "隧道没有起来，看 $TUNNEL_LOG"; exit 1; }
echo "public: $PUBLIC_URL"

# repoint 会把 { engineId, wsUrl } 写进 ~/.pi/agent/eleven.json；已有 Engine 原地改地址，
# 没有才新建一个 seng_…。
REPORT=$(PUBLIC_URL="$PUBLIC_URL" bun run src/repoint.ts)
echo "$REPORT"
ENGINE=$(printf '%s\n' "$REPORT" | sed -n 's/^engine: //p' | head -1)
[ -n "$ENGINE" ] || { echo "没有拿到 Engine ID"; exit 1; }

echo "服务端日志：$LOG_DIR/speech-engine.log"
env SPEECH_ENGINE_ID="$ENGINE" PORT="$PORT" WS_PATH="$WS_PATH" bun run src/server.ts 2>&1 | tee -a "$LOG_DIR/speech-engine.log"
