#!/usr/bin/env bash
# 一条命令起语音通话的 Pi 服务端。
#
# 隧道 URL 每次都会变，而 Speech Engine 资源里存的是绝对 ws_url，
# 所以顺序是固定的：起服务 → 隧道 → 建 engine（拿到新的 seng_）→ 把 id 写进 Pi 配置。
set -euo pipefail
cd "$(dirname "$0")"

: "${ELEVENLABS_API_KEY:?需要 ELEVENLABS_API_KEY}"
export PI_CWD="${PI_CWD:-$(cd ../.. && pwd)}"
PORT="${PORT:-3001}"
CF="${CLOUDFLARED:-cloudflared}"

command -v "$CF" >/dev/null || { echo "找不到 $CF：brew install cloudflared"; exit 1; }

bun run src/server.ts >/tmp/speech-engine.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

"$CF" tunnel --url "http://localhost:${PORT}" --no-autoupdate >/tmp/speech-engine-tunnel.log 2>&1 &
TUNNEL=$!
trap 'kill $SERVER $TUNNEL 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  PUBLIC_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/speech-engine-tunnel.log | head -1 || true)
  [ -n "${PUBLIC_URL:-}" ] && break
  sleep 1
done
[ -n "${PUBLIC_URL:-}" ] || { echo "隧道没有起来，看 /tmp/speech-engine-tunnel.log"; exit 1; }

ENGINE=$(PUBLIC_URL="$PUBLIC_URL" bun run src/create-engine.ts | sed -n 's/^engine: //p')
kill $SERVER 2>/dev/null || true
sleep 1

# 桌面应用读的是这个文件；也可以用「设置 → 语音」改。
python3 - "$ENGINE" <<'PY'
import json, os, sys
path = os.path.expanduser("~/.pi/agent/eleven.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({"engineId": sys.argv[1]}, open(path, "w"), indent=2)
PY

echo "engine: $ENGINE"
echo "public: $PUBLIC_URL"
exec env SPEECH_ENGINE_ID="$ENGINE" bun run src/server.ts
