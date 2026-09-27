#!/usr/bin/env bash
# 生成 Orbit 桌面版（macOS）自签代码签名证书 "Orbit Developer"。
#
# 为什么需要它：ad-hoc 签名（"-"）每次构建的 cdhash 都不同，macOS 的 TCC
# 辅助功能授权按「Bundle ID + 签名 Designated Requirement」匹配，因此应用内
# 更新覆盖 /Applications/Orbit.app 后授权必然失效。改用一张固定的自签证书
# 签名后 DR 稳定，更新不再丢授权；应用内更新走 Tauri updater 解压替换，
# 不经过 Gatekeeper，所以不需要 Apple 信任链（零成本路线）。
#
# 幂等：钥匙串里已有该身份时跳过生成——不要删掉旧证书重新生成，那会再次
# 改变 DR，所有同事的辅助功能授权又会丢一次。
set -euo pipefail

CN="Orbit Developer"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/work"
P12="$OUT_DIR/orbit-signing.p12"
P12_B64="$OUT_DIR/orbit-signing.p12.base64"
PASS_FILE="$OUT_DIR/orbit-signing.password"
CERT_PEM="$OUT_DIR/orbit-signing.cert.pem"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

command -v openssl >/dev/null || { echo "缺少 openssl" >&2; exit 1; }
mkdir -p "$OUT_DIR"

have_identity() {
  security find-identity -p codesigning 2>/dev/null | grep -q "\"$CN\""
}

if have_identity; then
  echo "✔ 钥匙串里已有 \"$CN\"，跳过生成。"
else
  echo "→ 生成自签代码签名证书 \"$CN\"（20 年有效期，仅本机使用）……"
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  cat > "$tmpdir/ext.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Orbit Developer
O = Orbit
C = CN
[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
    -config "$tmpdir/ext.cnf" \
    -keyout "$tmpdir/key.pem" -out "$tmpdir/cert.pem" 2>/dev/null

  pass="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24)"
  printf '%s' "$pass" > "$PASS_FILE"
  chmod 600 "$PASS_FILE"

  # macOS `security import` 不认 OpenSSL 3 默认的 AES/PBKDF2 P12，
  # 必须显式使用传统 PBE 算法。
  openssl pkcs12 -export -out "$P12" \
    -inkey "$tmpdir/key.pem" -in "$tmpdir/cert.pem" \
    -password "pass:$pass" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1

  echo "→ 导入 login keychain 并授予 codesign 访问权……"
  security import "$P12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign

  # 让本机信任该证书；仅影响本机 `security find-identity -v` / Gatekeeper
  # 的评估体验，构建签名（codesign -s）不依赖它，失败可忽略。
  security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$tmpdir/cert.pem" 2>/dev/null \
    || echo "（提示）本机信任设置未写入，不影响构建与更新流程。"

  cp "$tmpdir/cert.pem" "$CERT_PEM"
  chmod 600 "$P12"
fi

base64 -i "$P12" -o "$P12_B64"

echo
echo "✔ 完成。签名身份：$CN"
security find-identity -p codesigning 2>/dev/null | grep "\"$CN\"" || true
echo
echo "后续步骤："
echo "  1) 本机构建：直接 bun run tauri:build，scripts/tauri.mjs 会自动启用该身份。"
echo "  2) CI 构建：在 GitHub 仓库 Settings → Secrets 配置："
echo "       ORBIT_MACOS_SIGNING_P12_BASE64  = work/orbit-signing.p12.base64 的内容"
echo "       ORBIT_MACOS_SIGNING_P12_PASSWORD = work/orbit-signing.password 的内容"
echo "     work/ 与 *.p12/*.pem 已在 .gitignore 中，不会提交。"
echo "  3) 注意：证书只此一份。换新证书 = 授权要求全部同事重新勾选一次辅助功能。"