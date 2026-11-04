#!/usr/bin/env bash
# Install the freshly bundled .deb and require the app to stay alive.
#
# 1.0.24 shipped a Linux binary that segfaulted before opening a window: the
# CEF runtime initialised GTK4 while `tauri` still links GTK3, so
# `gtk_init_check` resolved to libgtk-3 and died in glib's option parser.
# Nothing downstream noticed, because no step ever launched the package.
#
# The previous inline version of this check globbed
# `bundle/deb/*.deb` into an array and handed a *relative* element to apt-get.
# apt-get only treats an argument as a local package when it is an existing
# absolute path (or starts with `./`), so v1.0.32 shipped a run where it went
# looking for a package literally named
# `src-tauri/target/release/bundle/deb` and failed with "E: Unable to locate
# package", while the earlier `./src-tauri/.../*.deb` form had worked. Resolve
# the artifact once, absolutely, and fail loudly when there is none.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deb_dir="$repo_root/src-tauri/target/release/bundle/deb"

deb="$(find "$deb_dir" -maxdepth 1 -name '*.deb' -print -quit 2>/dev/null || true)"
if [ -z "$deb" ] || [ ! -s "$deb" ]; then
  echo "No usable .deb under $deb_dir" >&2
  ls -la "$deb_dir" >&2 2>&1 || echo "(directory does not exist)" >&2
  exit 1
fi
# apt-get only treats an argument as a local package when it is an existing
# absolute path; a relative one falls through to package-name lookup.
deb="$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")"
test -f "$deb"
echo "Verifying $(basename "$deb") ($(stat -c %s "$deb") bytes, $deb)"

# List the archive once. Piping `dpkg-deb -c` into `grep -q` closes the pipe
# early and floods the log with "tar: stdout: write error" SIGPIPE noise.
contents="$(mktemp)"
dpkg-deb -c "$deb" > "$contents"

for file in provider-auth.js index.js terminal.js cli.js; do
  if ! grep -q "pi-runtime/${file}" "$contents"; then
    echo "Linux package is missing pi-runtime/${file}" >&2
    grep pi-runtime "$contents" | head -40 >&2 || true
    exit 1
  fi
done

sudo apt-get install -y "$deb"
test -f /usr/lib/Orbit/resources/pi-runtime/provider-auth.js || {
  echo "Installed package did not place provider-auth.js" >&2
  ls -la /usr/lib/Orbit/resources/pi-runtime >&2 || true
  exit 1
}

dbus-run-session -- xvfb-run -a /usr/bin/orbit > /tmp/orbit-start.log 2>&1 &
app=$!
for _ in $(seq 1 15); do
  sleep 1
  if ! kill -0 "$app" 2>/dev/null; then break; fi
done
if ! kill -0 "$app" 2>/dev/null; then
  echo "Orbit exited during startup:" >&2
  cat /tmp/orbit-start.log >&2
  exit 1
fi
kill "$app" 2>/dev/null || true
echo "Orbit stayed up for 15s"
