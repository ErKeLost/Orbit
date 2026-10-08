#!/usr/bin/env bash
set -euo pipefail

# One-shot Orbit Relay deploy for a Debian/Ubuntu Alibaba Cloud ECS.
# Usage:  sudo ./deploy.sh <domain> <host-key>
#   <domain>   bare hostname, e.g. relay.example.com (must point at this ECS)
#   <host-key> 32-256 chars of [A-Za-z0-9_-], the desktop's relay identity

DOMAIN="${1:?usage: deploy.sh <domain> <host-key>}"
HOST_KEY="${2:?usage: deploy.sh <domain> <host-key>}"

if [[ "$DOMAIN" == *://* || "$DOMAIN" == */* ]]; then
  echo "domain must be bare (relay.example.com), not a URL" >&2
  exit 1
fi
if [[ ! "$HOST_KEY" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
  echo "host key must be 32-256 chars of [A-Za-z0-9_-]" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo ./deploy.sh ..." >&2
  exit 1
fi

APP_DIR=/opt/orbit-relay
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- runtime: bun ---------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi

# --- TLS front: caddy -----------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# --- app files ------------------------------------------------------------
mkdir -p "$APP_DIR"
cp "$SRC_DIR/server.mjs" "$APP_DIR/server.mjs"
cp "$SRC_DIR/orbit-relay.service" /etc/systemd/system/orbit-relay.service

# Caddy terminates TLS and sets X-Real-IP authoritatively; the relay only
# trusts that header for rate limiting.
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  encode zstd gzip
  header_up X-Real-IP {remote_host}
  reverse_proxy 127.0.0.1:8787
}
EOF

cat > /etc/orbit-relay.env <<EOF
ORBIT_RELAY_HOST_KEY=${HOST_KEY}
EOF
chmod 600 /etc/orbit-relay.env

# --- run ------------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now orbit-relay
systemctl enable --now caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

sleep 2
echo "--- orbit-relay status ---"
systemctl --no-pager --lines=6 status orbit-relay || true
echo "--- health check ---"
curl -fsS "https://${DOMAIN}/health" && echo || {
  echo "health check failed — confirm the A/AAAA record for ${DOMAIN} points at this machine"
  exit 1
}
echo
echo "OK. Relay URL: wss://${DOMAIN}"
echo "Host Key:     ${HOST_KEY}"
