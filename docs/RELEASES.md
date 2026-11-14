# Desktop releases

Pushing a `v*` tag starts the `Release Orbit` GitHub Actions workflow. It
publishes Apple Silicon and Intel macOS, Linux x86_64, Windows, and Android ARM64
artifacts, then uploads `latest.json` for the desktop updater. The workflow
creates one draft before parallel platform jobs start and checks every package
and updater platform before publishing it.

## v1.0.41

A voice call no longer starts its own Pi.

ElevenLabs still listens and speaks. The local engine only forwards the transcript and streams the words back. Work goes to the session that was on screen when the microphone opened, through the same send path the composer already uses. It does not open a session, and it does not follow a tab switch mid-call.

Jev still picks the lane — speak, dispatch, watch, confirm, or stop. An unsure answer stays spoken and is not dispatched. When that session finishes, fails, or needs a confirmation, the sentence is spoken even if nobody is talking. If the call has already ended, the same voice is synthesized locally. A call with no live session says so and does not invent one.

The bundled Pi runtime is 1.5.2.

## v1.0.40

Hot paths stop repeating work that has not changed.

The changes panel no longer reparses every tool call on each streamed token.
A patch is parsed once and reused until that call's write or diff actually
changes. Git status, while the window is visible, stays at five seconds only
while the tree is moving; two unchanged polls stretch it to ten, and a hidden
window stops polling. A long spoken-length reply — past eight thousand
characters in the active message — leaves the animation frame and flushes at
thirty times a second. Short replies still flush every frame.

A voice call no longer keeps two Pi processes warm while nobody is talking.
They start with the call and go away when it ends. The unused engine-creation
script and the leftover Rime error type are gone; the engine is pointed by
`up.sh` alone.

## v1.0.39

A voice call no longer treats every utterance as a job for Pi.

Jev answers one question before anything is woken: does this sentence need the
working agent? Only a sure yes starts the process that has tools. Anything else
— a low score, a timeout, a missing key — is spoken by a second Pi that has no
tools. That reply is generated in the language the user just used. There is no
phrase list, and the engine is not pinned to a language.

Talking over an answer aborts the current turn and then sends the new line,
instead of waiting for the tools already running to finish. Captions follow the
streaming parts, and the orb follows the speaker's volume.

`up.sh` still re-points the engine that already exists. It writes the
low-latency profile — realtime transcription, flash speech, eager turns —
without inventing keywords or locking Chinese. It also no longer mistakes
Cloudflare's API host for the tunnel address.

## v1.0.38

Voice calls: a service you can check, and that says why it is silent.

The call page is back to the shape it had before the ElevenLabs refactor — the orb
at the top, a start button underneath, and the reply rendered as a real message in
its own scrolling pane at full width. The plumbing under that page changed; the page
should not have changed with it, and now it does not.

Before it opens the microphone, the page asks the local engine for `GET /health`. A
dead engine used to look exactly like a quiet assistant: the WebRTC session connects,
VAD lights the orb, and nothing ever answers. Two failures now say themselves instead
— "the service is not running, run `up.sh`", or "the service is serving `seng_A` while
the app dials `seng_B`". Settings → Voice shows the same status: engine id, resident
size, calls served, uptime.

Transcripts longer than 1200 characters are treated as the room talking — a video or a
podcast the microphone heard — and dropped with one log line, rather than handed to Pi
as an instruction. Background voice detection is enabled on the engine as well. And a
new utterance arriving mid-answer now goes in as `steer`, so talking over the reply no
longer produces "Agent is already processing" as a chat bubble.

`up.sh` re-points the engine that already exists instead of creating a new one. A
changed tunnel address used to mean a new `seng_…` and a settings edit; now the id
survives and the file the app reads records both. The script also takes the key from
`auth.json` and finds `cloudflared` where it actually lives.

The reason the last part of this release is about plumbing: that engine process had
grown to 49 GB and been killed by the kernel, which left the tunnel answering 502 and
the app showing nothing at all. It now logs with timestamps, exits on its own at 4 GB
instead of dragging the machine into swap, disposes a call's Pi process when the socket
drops without a close message, and stops a response stream from queueing text nobody
will read.

## v1.0.37

A one-component release: the indicator that says a session is working.

It used to be a braille dot pattern — `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, a state index stepped from an
80ms interval. Braille made sense on a terminal grid, where the dots occupy a
fixed cell of a fixed font. In a proportional UI at 12px it does not: every frame
has a different ink coverage, so the mark reads as corrupted text rather than as
something moving, and the advance width drifts between frames, so the row shifts
by a pixel while it animates. What those ten frames share is only the meaning
"still running"; the shape was noise.

The spinner is now a ring with fixed geometry — a dim full circle under a bright
quarter arc, rotated by CSS. The shape never changes, so only rotation carries
the state, which holds at any size and does not depend on a monospace fallback
being present.

Deleting the frame table deleted the mechanism with it. The component kept the
frame index in state and ticked it from an interval, so every visible spinner
re-rendered twelve times a second for as long as anything was running; a project
row and a session card and a pane header all did this at once. The ring needs no
JavaScript and the component is now a pure function.

Size had also leaked into the call sites: four places each passed their own
`w-3` or `w-3.5`, plus `text-2xs leading-none`, to fit the glyph into their row.
The ring owns its size (`size-3`, inline-flex), and the call sites choose only
the colour. The one visible change beyond the shape is in the pane header, where
the mark grew from 10px to 12px; the ring's open centre keeps it from outweighing
the 8px status dot it sits next to.

## v1.0.36

A voice release that removes more than it adds. The voice page used to be a
self-built call loop: microphone capture in an AudioWorklet, silence splitting,
PCM scheduling into Web Audio, partial-transcript merging across streams, an
intent router running in a side Pi session, and a priority queue for reading task
events aloud. Two thousand lines of that, plus a Rime transport with sixteen
commands, existed to do what a voice platform already does.

A call is now three things: ElevenLabs owns the audio path, Pi owns the answer,
the app draws the orb. `src-tauri/src/rime.rs` and the whole `resources/voice`
extension are gone, along with the frontend capture, playback, routing and
announcement modules and their tests — 6,000 lines out, 1,000 in. The page keeps
one class: it fetches a short-lived WebRTC token, starts a session, and reports
state, transcript, mute and barge-in from the SDK. No audio code is left in the
webview.

Pi answers from `tools/speech-engine`, a small server ElevenLabs connects to from
the cloud. Each call gets its own `pi --mode rpc` process — history and task state
isolated, disposed on hang-up — and the newest transcript is forwarded while the
answer streams back out. Transcripts that contain no letters or digits are
dropped rather than sent: a microphone macOS never authorised produces `...`, and
answering that only makes Pi invent work.

Credentials did not move into the page. The API key stays in `auth.json`
(provider `elevenlabs`), the Speech Engine id in `eleven.json`, and the frontend
receives a token with a short life. Settings → 语音 keeps two fields and a plan
check that reports the remaining characters on the free tier.

Two limits worth stating plainly, because both are visible in use. `sendResponse`
is only valid inside an `onTranscript` handler, so the agent cannot speak after
the caller stops talking: the task announcement queue is not "unfinished", it has
no equivalent in this protocol. And a call acts on its own Pi session, so
watching or steering another session from a call needs a bridge into the desktop
RPC that does not exist yet. `docs/VOICE_ARCHITECTURE.md` records both.

## v1.0.35

A visual release: the app has one palette now, and three places that were empty
or ambiguous got an answer.

Colour, radius, type size and duration moved into `src/styles/tokens.css`, in
three layers — a raw ramp, the names components use (`surface-*`, `ink-1..3`,
`line`, `fill*`, `accent*`, positive/negative/warning), and aliases so every
pre-existing rule keeps resolving while it is migrated. Before this, colour was
derived ad hoc: `text-content/45` here, `border-content/10` there, a sidebar
mixed with black by hand, status colours pulled from Tailwind's palette, and
nine text sizes between 10 and 14px. Two screens built a month apart read as two
products. They now share four surfaces, three text roles, one hairline and one
scale; `docs/TOKENS.md` records the layers, the alias table and the rule that a
new colour has to earn a semantic role.

The default tint is 墨蓝 — hue 255, chroma 16%, canvas lightness 8% — and the
three values move as one palette, because each surface is an offset from the
canvas. Anyone still holding the old written default (240 / 0 / 9) is moved to
the new one; anyone who chose their own tint keeps it exactly. Light mode is
mirrored and deliberately brighter: canvas at 0.985 OKLCH, cards at pure white,
ink starting at 0.21, so contrast separates the layers instead of a grey veil.
Two contrast fixes ride along: accent-as-text is mixed with the body colour
(amber at 1.9:1 on light becomes 5.2:1), and text on an accent fill is picked
from the fill's luminance — a cobalt button at 66% lightness takes near-black
ink at 5.5:1 instead of white at 3.4:1.

An answer now shows where it read. A fetch or a highlights read is a page the
turn opened; a search is not, because its results are candidates the agent never
read. Those pages appear under the settled reply as a stack of site favicons and
`N 个来源`, hover or click opens the list, and a row opens in the browser panel
beside the conversation (or the system browser with a modifier). The address
comes from the page's own frontmatter, so a redirect shows where it landed, and
the list is capped at twelve. A turn that read only local files shows nothing.

A new browser tab is a start page instead of the app's logo: the four commands
you would otherwise hunt through menus for, drawn with their own keycaps, and
the last eight pages you visited — read from `localStorage`, recorded only once
a tab has a live page, so a URL that failed to load is never offered back. The
tab strip matches: it sits a step below the page with one hairline along its
bottom edge, the active tab paints over that line as the same sheet as the
content, and the `+` moved into the strip where the tab list ends.

The rail no longer asks "where am I" twice. The `ProjectSwitcher` title row is
gone; the project list is the only switch. The counts that made sense beside it
went too — section badges, session-group totals, a multi-root project's corner
number (its paths stay in the row's title) — and an empty project list is a
dashed folder-plus tile rather than the sentence 「还没有项目」.

## v1.0.34

A smoothness release for the whole machine, not just this window. The reported
symptom was specific: leave the app alone for a while, then click a tab or switch
session, and the entire computer stops for ten-odd seconds at something like ten
frames a second. Two things compounded. Every decorative surface was drawing
whether or not anyone could see it — the voice page's WebGL orb at 60fps forever,
the empty-session galaxy re-stroking a 6px grid over the whole canvas 25 times a
second — and the window was translucent with macOS vibrancy, which means the
compositor blended the whole window with the desktop on every one of those
frames. That cost lands in `WindowServer`, so it is the machine that stutters, not
the app. On top of that, screenshots in a session were kept as base64 in the
renderer for the life of the session (a computer-use run is easily hundreds of
megabytes), and image previews were cached 120 at a time with no byte budget.

`docs/PERF.md` §6 records the whole audit, but the two changes that matter are:

**The window is opaque by default.** `orbit.bodyGlass` now defaults to `false`,
so no `NSVisualEffect` view is installed and the compositor takes the opaque
path. Settings → 外观 → 透明度 → 窗口玻璃 turns the old look back on, and once it
is on nothing else differs: same vibrancy, same sidebar opacity, same blur
radius. Light themes were already opaque and stay that way. Users who never touch
the setting will simply see a solid window after updating.

**Nothing renders while it is not on screen.** The orb's `react-three-fiber` loop
pauses when the voice page is hidden (the WebGL context is kept, so going back
does not flash), the waveform stops its animation frame when there is no audio and
caches its canvas size, and the galaxy backdrop paints once into an offscreen grid
layer, stops when the element is off-screen, unfocused, in reduced motion or
degraded, and no longer measures the DOM on every pointer move. Its `pointermove`
handler used to call `getBoundingClientRect()`, which is a forced layout at up to
120Hz.

Memory and switching got the same treatment. History and live images are now
materialised to files in the app's media cache and streamed through the asset
protocol (one command for history, one pass in the Rust stdout pump for live
events), so a screenshot is no longer duplicated as base64 in the IPC payload and
the JS heap; the preview cache is byte-budgeted instead of count-budgeted, and
media older than an hour is the only thing the pruner may drop. Session history
loads are single-flight, hover prefetch waits for hover intent and runs one at a
time, and a long transcript now paints a skeleton for one frame and renders the
rest inside `startTransition`, so the tab strip answers immediately instead of
waiting for hundreds of markdown parses. The transcript's bottom fade moved from
the scrolling element to a static wrapper, and git polling backs off to ten
seconds when a checkout has not changed.

Finally, the app can now be asked what it is doing. **⌘⇧P** opens a live panel with
frame rate, frame time and p95, jank/stall/freeze counts, engine long tasks, the
JS heap, DOM node count, and the duration and dropped frames of the last few
actions (tab switch, session open, history load, prefetch, panel paint).
`__orbitPerf.report()` in the console gives the same thing as text. If the app
ever does measure sustained low frame rates, one freeze longer than three
seconds, or three stalls inside thirty seconds, it degrades itself: decorative
animations stop, vibrancy is dropped, the window becomes opaque, and a toast says
why and that restarting restores the original look.

## v1.0.33

A performance release for the chat surface, measured against t3code rather than
guessed at. The comparison and what is still open live in `docs/PERF.md`.

Long sessions no longer keep every turn in the DOM. Past 80 groups (about 40
exchanges) the transcript mounts the most recent 40 and puts a "显示更早的 40 段"
button at the top; expanding restores `scrollTop` by the height delta, so the
reader's view does not move. The window is decided once per mount or per session
switch, which means history never disappears from under someone reading it, and
sessions under the threshold render exactly as before. `PromptOutline` already
derived from the DOM and documents that it stays correct when the list is paged.
This is the conservative version of what t3code's virtualised timeline buys: not
per-row windowing (chat rows vary too much in height to swap in and out safely),
but fewer than a hundred rows instead of several hundred.

Two performance escape hatches turned out never to have been connected.
`perf-tier.ts` wrote `data-perf` while the stylesheet gated on
`[data-perf-tier="low"]`, so nothing the low-end tier claimed to do had ever
happened; the tier now really stops the shimmer, the thinking pulse, the tool
spinner and the typing dots, freezes the empty-session galaxy to one static
frame, and drops macOS vibrancy — which requires a non-opaque window — back to an
opaque one. `html[data-page-visible="false"] *` had existed for several releases
with nothing writing the attribute, so a backgrounded window kept compositing
every decorative animation; visibility is now published on `<html>`. A regression
guard fails the build if a stylesheet gate ever loses its writer again.

The chat surface also stops doing per-frame work that was not per-frame:
`TerminalDock`, `PromptOutline` and the jump-to-bottom control are memoised
(their props were already stable), and the markdown plugin array no longer gets a
new identity on every streaming token — `source` left the dependency list in
favour of the boolean it was only used to compute.

File paths, `@` mentions and links now follow the accent colour. They used the
theme's own link blue, so a yellow accent left every path chip, every `@file`
mention and every markdown link blue — the chat read as two applications at
once. `PathChip`'s own comment says the chip is drawn in "the theme's accent";
this makes that true. The accent is not used raw, because it is picked as a
surface colour: `#f59e0b` as text on the light theme is 1.9:1. Each use is mixed
with the body colour instead (32% for chips, 55% for mentions and the composer's
`@` tokens, and a per-theme mix for `--link-color`), which keeps the hue and puts
the result back in the readable range — verified at 5.2:1 for amber on light and
10.7:1 on dark. With no custom accent nothing changes at all.

A menu opened from a control inside a dialog painted underneath the dialog. It
portals to `document.body`, so its layer was compared with the whole app (80)
instead of with the surface it came from (90): an open select looked clipped,
with only the part past the dialog's bottom edge visible and the footer drawn
over it. The surface that raises the bar now publishes a `PopoverLayerOffset`
and `Popover` adds it, so a flyout above its own parent menu keeps working at any
depth; `ModalPanel` and the mobile drawer are the two surfaces that publish one.

The model menu now explains an empty or failed catalog instead of rendering
nothing. Pi's `get_state.model` is optional, so a worker that reported no model
left the picker filtering by a provider that matched nothing, with no way to ask
again. An empty provider pool falls back to the whole catalog, the empty state
says whether it is still fetching, failed (with the message) or empty, and both
of the last two get a retry; opening the menu refetches when the catalog is
missing.

The phone now knows the desktop's home directory, and 「主目录」 is a scope there
rather than a project named after the account. The Host publishes `home` in its
snapshot, the phone adopts it, filters it out of the project registry, decides
home-vs-project from the path, and offers a 主目录 row in the project list; a
phone with no projects lands there instead of erroring. Older Hosts keep the old
behaviour.

Computer Use can now reach targets the accessibility tree exposes without an
action, which is where WebView list rows used to end a run as `blocked`. Three
narrow, post-verified routes: geometric candidates for rows whose label is named
by the goal (capped at three, always escalated, one extra capture per screen),
pointer coordinates converted through the window origin and screenshot scale
instead of sending raw screen coordinates, and a clipboard paste after an
accessibility write was ignored (Chromium answers those with success and changes
nothing). A wait that changed nothing twice withholds `reobserve`, and a `done`
refused twice withholds `done`, so the chooser has to act or say it is blocked —
a live run had spent eleven decisions repeating `done`. A readable web tree with
no advertised action is named in the context as Chromium's ~2s accessibility
activation debounce, and the driver's `delivery`/`retry` pair is cross-checked so
contradictory fields report `unknown` instead of the convenient one.

Two structural candidates are documented but deliberately unchanged, because
they change how the app looks or ships: the `transparent: true` window with
native vibrancy (t3code's Electron window is opaque), and the `mask-image` on the
transcript scroller, which in WebKit is a common source of scroll jank for the
sake of a 2.5rem bottom fade. Both are one-line experiments with a procedure in
`docs/PERF.md`.

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
