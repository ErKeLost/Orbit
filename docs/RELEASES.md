# Desktop releases

Pushing a `v*` tag starts the `Release Orbit` GitHub Actions workflow. It
publishes Apple Silicon and Intel macOS, Linux x86_64, Windows, and Android ARM64
artifacts, then uploads `latest.json` for the desktop updater. The workflow
creates one draft before parallel platform jobs start and checks every package
and updater platform before publishing it.

## v1.0.32

A performance release, with two correctness fixes found while measuring.

Providers no longer imports the `@lobehub/icons` barrel: that entry point is
1.9 MB across 351 providers and evaluating it cost ~300 ms of main thread and
~140 MB of RSS every time the page mounted. Brand marks come from ~30 direct
component imports instead, so the provider page's chunk went from 1.4 MB
(260 KB gzip) to 124 KB (25 KB gzip) and no longer drags the barrel in at all.
The model catalog is cached per provider for five minutes with in-flight
deduplication, the login-state helper (one `node` process, 240–270 ms of CPU per
call) is cached for five minutes instead of ten seconds, and clicking a provider
renders its saved models immediately instead of disabling the whole sidebar
while a subprocess answers. The model list pages at 60 rows with memoised rows
and a deferred search, and `ProviderSettings` is split into
`ProviderBrowser` / `ProviderEditorDialog` / `ProviderModelList` with the
activate/save chains moved into `provider-actions.ts`.

Entering Settings no longer mounts a hidden `CommandsPanel` — the overlay panels
were falling through `panelComponent`'s default branch, so every visit loaded
that chunk, asked Pi for the command list, and rendered it invisibly.

The chat surface stops re-rendering during streaming where it did not need to:
the composer subscribed to the whole `messages` array (new identity every ~32 ms)
just to derive a turn key, `ChatPane` and `WorkspaceRoots` subscribed to the
whole `statuses` record (replaced every 5 s by `gui-runtime`, which carries the
entire system prompt), and the empty-session galaxy kept a 25 fps loop alive at
0×0. Idle polling backs off as well: `/gui-observe` goes from 5 s to 20 s and the
`get_state` / session-stats polls from 2 s to 10 s while no turn is running;
turn state itself is event-driven, so this only removes spinning.

Markdown links and media follow the t3code rules more closely: a link that lands
on a file is drawn as a file-type chip that opens the editor (with `#L12` line
ranges kept), a bare folder name such as `src` resolves to a chip only when a
directory listing confirms it, `![…](…)` dispatches on extension to `<video>`, an
audio player, or a PDF surface instead of always producing a broken image, and
web links carry their site's favicon when it is already cached locally.

Two ways an `.svg` could misrepresent its bytes are closed. Dragging an SVG into
the composer works (the Rust image MIME table was missing `svg`, while the notes
path always accepted it), and an oversized vector is no longer rasterised into a
`.svg`-named JPEG: SVGs skip re-encoding, and a re-encode that changes format
renames the file to match. A ```` ```svg ```` fence now becomes a blob URL rather
than a `data:image/svg+xml;utf8,…` URL, which was both an invalid charset
parameter and the app's only self-made XML document.

Links can no longer replace the app's webview. Only `http(s):` and `mailto:` were
intercepted, so a markdown link to `data:`, `blob:`, `file:`, `asset:`, or
`orbitartifact:` navigated the whole window to that document — and an
XML-typed target that fails to parse shows the engine's own parsing error page
(`error on line 1 at column 2: StartTag: invalid element name`) with no way back.
Those anchors now render as non-clickable text and the capture-phase handler
refuses the navigation.

## v1.0.31

Chat markdown is rendered by `react-markdown` on a pipeline ported from t3code
(the `t3code` submodule); `@lobehub/streamdown` is gone. The reader-visible
differences: GitHub alerts (`> [!NOTE]`, `[!WARNING]`, …) draw a colored note
instead of a literal marker, headings carry `#anchor` ids and an in-page jump
scrolls instead of navigating the hash route, tables get their own scroll shell
and a copy action, and a list continuation line that CommonMark would have
turned into an indented code block stays prose. Inline code keeps its chip and
file-path behavior, and fenced code still goes through Orbit's own Shiki frame
with mermaid, Graphviz, ECharts, and Vega rendering.

While a response streams, completed fenced blocks are parsed once and cached, so
a long answer with code no longer re-parses the whole document for every token.
Word-by-word smoothing is removed: text arrives at token granularity and each
new block fades in once. Formulas still load KaTeX lazily on the first reply that
contains math.

The port lives in `src/shared/lib/markdown/` (pipeline, incremental parser, LaTeX
delimiters) and `src/components/markdown/` (component map, table shell, fragment
anchors), with its look in `src/styles/markdown.css` and its theme tokens mapped
to Orbit's `--color-content` set.

## v1.0.30

Providers now separates local Pi process configuration from model endpoints and
accounts. Configure the Pi executable, literal launch arguments, and environment
variables on this computer, check the runtime, then save or reconnect the current
workspace. Sensitive variables are stored separately and return only a redacted
state to the UI; saving an unchanged secret preserves its value. The same
configuration reaches new Pi processes, account helpers, and the native terminal.

The bundled Pi runtime is upgraded to 1.5.0. Its nine OAuth login methods are
available in Orbit, including browser callbacks, device codes, cancellation, and
sign-out. Existing OAuth credentials cannot be overwritten by an API-key save.
Native model defaults no longer require placeholder custom model entries.

Magpie gateways can be connected from Providers. Models retain their native
Responses, Anthropic Messages, or Chat Completions transport, supported effort
levels, and adaptive thinking where required. Allowance cards show cached quota
readings from Magpie. Magpie remains separately installed and owns its accounts
and routing groups. These new settings and account controls are local-only.

See [PROVIDERS.md](PROVIDERS.md) for configuration and verification details.

## v1.0.29

The Debian package no longer depends on `nodejs (>= 22.19.0)`. Orbit runs the
Node it bundles, and on Debian the dependency made the package uninstallable on
any system without Node.js 22.19 — Ubuntu 24.04 ships 18, so
`apt-get install ./Orbit_*.deb` failed with unmet dependencies. That is what the
packaged-start check in the release job hit after the AppImage stopped blocking
the job. RPM was already free of it.

## v1.0.28

Same app as v1.0.27; the release pipeline is what changed. Three releases in a
row (1.0.25, 1.0.26, 1.0.27) built macOS, Windows, Android, and Linux deb/rpm,
then died inside the Linux AppImage bundling: `quick-sharun` fetched its own
tooling and then stalled for the rest of the 90-minute job budget, so the job was
cancelled and `Publish release` never ran. Those drafts are still unpublished.

The Linux job now bundles `deb,rpm` and nothing else, and the AppImage is a
separate step with a 20-minute bound that may fail without failing the job. The
manifest normalization and verification accept a release without the AppImage:
its updater entry is simply absent, so AppImage installs keep updating from the
last release that carried one, and a release that does produce the bundle adds
the entry back. Publishing is no longer decided by one flaky packager.

## v1.0.27

Fixes opening a session on the phone. The desktop shell names connections
`<cwd>#<uuid>` because it starts those Pi processes itself; the phone reused the
same id, which the Host does not know, so `connection.attach` failed with
「桌面连接不存在或已经关闭」. The symptom was a skeleton screen with two red
banners and a composer that could neither send nor pick a model, while the
project and session lists stayed correct because they never touch a connection.

Every phone entry that opens a connection now resolves the desktop's own id
first (snapshot → `connection.resolve` → `project.open` → wait), attaches that,
and rebinds the tab to it. The phone branch of `startConnection` also honours the
requested `sessionPath`, so tapping a session switches the worker to it instead
of showing whatever that connection had open last.

## v1.0.26

A project can hold more than one root again. Picking several folders in the
project picker now makes **one** project whose first folder is the home and whose
remaining folders are attached roots, instead of registering one project per
folder. The editor adds and removes roots, project rows report how many they
have, and the composer lists the attached ones. Attached roots contribute their
`AGENTS.md` / `.claude` context and their `.pi/skills` / `.agents/skills` to the
session, and the system prompt lists every root's absolute path. Roots are
resolved on connect and on every session or project switch; the phone receives
them in the published project registry.

The left rail lists projects again, under the navigation and above sessions:
click a row to switch, right-click for rename / logo / roots / remove, drag to
reorder, and use the `+` menu to open a folder or work outside one. The title
switcher stays — the list answers "where else can I go", the title answers
"where am I".

## v1.0.24

Desktop browser pages now use native Chromium child views inside Tauri, controlled
by Pi through a page-scoped CDP/Playwright relay. No screenshot stream renders the
browser panel or its in-app picture-in-picture view. Chinese and multiline input,
cross-origin frames, cancellation, Profile Cookie readback, and reconnecting an
executor to its existing page are covered by the live browser integration check.

Browser pages retain their native state when the panel is hidden or the frontend
reloads. Imported Profiles affect new pages and preserve existing page contexts.
The release includes the Chromium framework and helper processes, increasing the
installer size. The Tauri CEF runtime is experimental. Native popup windows are
not yet included in Orbit's session tab directory; picture-in-picture remains
inside the Orbit window. See [BROWSER_USE.md](BROWSER_USE.md) for current limits.

## macOS architectures

Both Apple Silicon and Intel macOS builds include native Chromium (CEF 151).
Both require macOS 13 or newer; macOS 11 and 12 are no longer supported.

The Intel job runs on an **Intel runner** (`macos-15-intel`) instead of
cross-compiling from the arm64 one. `scripts/sync-node-runtime.mjs` bundles the
Node for `process.arch`, so an arm64 host would put an arm64 Node inside an Intel
app. `scripts/sync-worker.mjs` is already target-aware
(`TAURI_ENV_TARGET`), so `ax_control` follows the triple either way.

The Intel bundle was suspended for two releases after `bundle_dmg.sh` failed on
the Intel runner. The logs were not kept, so it was never established whether
the DMG step failed or the job's 45-minute timeout arrived first — the compile
alone ran 43 minutes there. The matrix now gives that job 75 minutes and nothing
else changed. If the DMG still fails, the next step is to build only
`--bundles app` on Intel and produce the DMG with `hdiutil` in a separate step,
skipping the Finder layout AppleScript.

The same target is checked on every push by the `Intel target` job in `ci.yml`,
which runs `bun run check:intel` (`scripts/check-intel.mjs`) natively on
`macos-15-intel`. Without it, `bun run check` and a host `cargo check` compile
for whatever the runner is, and an Intel-only error would first appear inside
the 43-minute Release job.

The packaged-app check (worker signature, worker startup, deep bundle signature)
is gated on `startsWith(matrix.name, 'macOS')` and builds its path from
`matrix.rust_targets` — it must run for **every** macOS job, because the
Accessibility grant is attached to the ad-hoc-signed worker inside the bundle.
When this job was Apple-Silicon-only, that check hardcoded the `aarch64` path.

`bundle.macOS.minimumSystemVersion` is `13.0`, matching the minimum declared
by the bundled CEF framework.

## macOS signing (current release configuration)

The macOS app uses ad-hoc signing (`signingIdentity: "-"` in
`src-tauri/tauri.conf.json` and `APPLE_SIGNING_IDENTITY=-` in
`scripts/tauri.mjs`). The `Orbit Developer` certificate generated by
`bun run signing:setup` may exist in a local keychain, but the current release
workflow does not select it. Do not change the app's signing identity as part
of a worker fix: switching identities changes its Accessibility requirement.

The `ax_control` desktop worker is a separate executable, built for the target
architecture and copied into the
app's Resources directory. Rust gives it an ad-hoc linker signature. Keep that
signature when staging the worker; signing the outer `.app` does not sign
executables inside Resources. `scripts/sync-worker.mjs` verifies the staged
worker signature and runs a protocol probe. The macOS release job repeats both
checks against the packaged `.app` before the draft release can be published.

The app is not notarized. First installation may need a one-time manual
approval (right-click → Open, or System Settings → Privacy & Security → Open
Anyway).

Accessibility is granted to the **Orbit Agent** runtime
(`~/Library/Application Support/ai.pi.gui/runtime/Orbit Agent.app`,
`ai.pi.gui.agent`), not to Orbit itself. Orbit starts Pi through
`orbit --orbit-disclaim-exec` (`src-tauri/src/disclaim.rs`), which execs the
Agent with a disclaimed TCC responsibility, so macOS checks the Agent's
signature. The Agent is rebuilt only when the bundled Node changes, so its
grant survives Orbit updates even though Orbit's ad-hoc code hash changes every
release. The Tauri updater's minisign key
(`TAURI_SIGNING_PRIVATE_KEY`) is separate from macOS code signing.

## Linux runtime

Linux desktop runs on the platform WebKitGTK runtime (WRY), not CEF. `tauri`
still links GTK3 unconditionally through `muda` and `webkit2gtk`, while the CEF
runtime initialises GTK4 through `winit`. With both GTK major versions mapped,
`gtk_init_check` resolves to `libgtk-3.so.0` and the GTK4 call path crashes in
`g_option_context_parse` before the first window. v1.0.24 shipped that
combination and every Linux launch dumped core. `lib::run` therefore selects the
runtime per platform (`src-tauri/src/lib.rs`), and the release job installs the
built package and requires it to stay alive for 15 seconds.

The native Chromium browser (and the CEF-specific `browser_view` commands) is
unavailable on Linux until the CEF runtime can run there without pulling GTK3
into the same process.

## Linux and Android signing

Linux publishes an AppImage, a Debian package, and an RPM package. The native
CEF desktop runtime requires GTK 4.14 or newer; Linux builds use Ubuntu 24.04. Release
artifacts include Node.js via `scripts/sync-node-runtime.mjs`, and neither
package names an external Node.js dependency any more: the `nodejs >= 22.19.0`
string was encoded as a literal capability name on Fedora, and on Debian it made
the package uninstallable on any distribution without Node.js 22.19 (Ubuntu
24.04 ships 18) — which is exactly what the packaged-start check hit. The app
runs the Node it bundles.

Fedora KDE Plasma users can install the `.rpm` or run the AppImage. The pinned
Tauri updater supports AppImage, DEB, and RPM updates. RPM installation runs
`rpm -U` with graphical administrator authorization through `pkexec`; it does
not resolve new dependencies like `dnf` does. An installation failure prevents
relaunch. Signed RPM assets and their format-specific updater entries must be
published along with the other Linux assets.

The updater checks GitHub Releases at application startup in production builds.
When a newer version is available, it offers to download, install, and relaunch
the app. This uses Tauri's official `tauri-plugin-updater` flow and requires the
release assets and `latest.json` to be signed with the configured public key. The
signing private key is stored only in the GitHub repository secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

The Android ARM64 APK is uploaded as `orbit-android-arm64-<tag>.apk`. It is a
signed Tauri mobile client and uses the desktop Orbit Host for Pi execution over
a token-authenticated trusted-LAN/Tailscale WebSocket. It is not a standalone
Pi runtime.

The official Tauri updater is desktop-only. Orbit's Android client checks the
latest GitHub release, downloads the matching signed ARM64 APK, and opens the
system installer. Android still requires user confirmation. Releases must retain
the same package identifier and signing key.

To release a version, keep `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` aligned, commit the version bump, then push its tag:

```sh
git tag v0.1.5
git push origin v0.1.5
```

## Retrying Linux packaging

`Repair Linux release packages` rebuilds an existing draft release from its
immutable tag. This handles packaging-only failures without changing a published
tag or rebuilding platforms that already succeeded. It checks the version and
draft state before uploading. The CEF AppImage deployment shim is pinned to the
same mirror as its bundler because the upstream rolling URL returns 404. After
repairing a failed release, run the normalization and asset-verification steps of
`release.yml` before publishing the draft.
