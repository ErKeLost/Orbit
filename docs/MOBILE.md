# Orbit mobile architecture

Orbit uses one React application for desktop and mobile. The Android package is
not a second chat client. It renders the same transcript, thinking, tool, and
sub-agent components from structured Pi RPC events.

The phone can also *watch and drive* the desktop screen, as a **floating window
over the conversation** rather than a destination. A button in the title bar
opens it; the chat is never replaced, remounted, or reconnected by it. The
window is draggable, has three sizes, remembers where you put it, and sits above
the composer by default so the session stays usable.

Tap the window to enlarge: that is where pointer input is enabled. A thumbnail
is fine to watch and useless to aim at, so the small window is watch-only and
enlarging is the explicit "operate it now" gesture. There is no key bar — this
is a chat session with a window onto the computer, not a VNC client — but text
typed in the enlarged view goes to the computer's focused field.

By default the window follows **the application being operated** rather than
mirroring the whole desktop, because that is what computer use acts on: the
agent must bring its target to the front, so the frontmost application and the
operated one are the same question. Settings → 屏幕 switches it to a whole
display, and the picker above the picture switches back.

**All screen settings live in Settings → 屏幕** — source, quality, codec, cursor,
and the desktop's permission plus live numbers. The floating window holds no
configuration of its own beyond size and position.

Drawing is skipped while the window is hidden; decoding continues, because
pausing an inter-frame codec is corruption rather than a saving.

That is a separate, opt-in channel with its own connection: the transcript stays
structured JSON on the control socket, and only the screen carries pixels. See
[SCREEN.md](SCREEN.md). Nothing about the control protocol changes when screen
preview is off, which is the default.

Touching the preview injects real input on the computer — pointer, scroll, a
key or chord from the key bar, and literal text through "在 Mac 上输入" — using
the same injection path and the same accessibility grant as `gui_task`. The
computer is the executor for every action; the phone sends normalized
coordinates and never learns about Retina scaling or display arrangement.

## Back, and the keyboard

The Android back gesture is decided by the page, not by the WebView's history.
Wry's default is `canGoBack() ? goBack() : onBackPressed()`, which for a
single-page shell is always the second branch: back left the app from anywhere,
including with the drawer open or a file on screen. `MainActivity` therefore
leaves `handleBackNavigation` off, and `src/lib/back-gesture.ts` keeps the stack
of surfaces that claim a press — the drawer, the file pane, the screen window —
newest first. Only a press nobody claims leaves the app. A surface that has moved
on declines instead of swallowing the press, and one that throws is skipped
rather than allowed to make back do nothing at all.

An Android WebView is never resized for the on-screen keyboard on its own. The
activity draws edge-to-edge (`MainActivity.enableEdgeToEdge`) and Android 15+
stopped resizing the window when the IME appears, so a 100%-tall shell keeps its
full height and the composer sits *under* the keyboard.

`MainActivity.onWebViewCreate` pads the WebView's parent — the activity's
content frame, which is where wry's `setContentView` puts it — by the IME inset.
That is what resizes the WebView, so the page's layout viewport becomes the area
the user can actually see and no JavaScript has to know where the keyboard is.
Only the IME inset is applied: the system bars stay with `env(safe-area-inset-*)`
in CSS, and padding both would double the gap whenever the keyboard is closed.

`src/lib/keyboard-inset.ts` publishes the same number as `--keyboard-inset` for
shells that resize the *visual* viewport instead (iOS, the `?preview=mobile`
browser preview). The two cannot overlap: once the native half has shrunk the
WebView, the web half measures a shrunken viewport and reports 0.
`tests/keyboard-inset.test.ts` pins that arithmetic, including the threshold that
keeps browser chrome from being mistaken for a keyboard.

## Runtime boundary

```text
Android WebView                       Desktop Orbit Host
----------------                     ------------------
shared React UI                       local React UI
remote runtime adapter  <- WebSocket -> remote Host
existing transcript reducer           Bridge -> bundled Pi RPC process
```

The desktop remains the execution authority. Pi, project files, credentials,
terminal commands, and child-agent processes stay on that machine. Android sends
typed commands to the Host and consumes the same Pi JSONL events that the desktop
uses. This preserves event ordering and avoids a second transcript model.

The transport batches burst events, uses bounded queues, and disconnects slow
clients instead of allowing unbounded memory growth. The control transport
sends structured JSON only: screenshots and preview frames never share this
socket, so a preview can never delay a thinking token or an input reply.

**A frame never carries an unbounded payload.** Small events are packed into
`pi.events` batches under a byte budget; an event too large for one frame — a
`get_messages` response on a session with a few hundred messages is several
megabytes — is cut into `pi.event.chunk` frames that the client concatenates and
parses back into the original payload. The cutting happens on the serialized
JSON at character boundaries, so a multi-byte character is never split.

The alternative was tried and is a dead end: dropping the oversized event made a
large session unopenable from the phone (「Pi get_messages 响应超时」, then
「连接失败」, then every later tap on that project doing nothing) while the
desktop showed the same session perfectly. A payload past even the chunked
ceiling, if it is a `response`, is answered with an explicit failure instead, so
the phone reports "too large" rather than waiting for something that is never
coming. On the phone a failed transcript fetch no longer marks the connection
itself as failed either: the worker is attached and still takes prompts, and
re-entering the session retries the history.

## Connection scope

The desktop Host keeps a stable local identity in a permissions-restricted file,
so restarting Orbit does not invalidate an already paired phone. The LAN path
uses an authenticated `ws://` connection and is intended for a trusted LAN or
Tailscale network; plain `ws://` does not encrypt LAN traffic by itself. Do not
expose the Host port directly to the public Internet. The Relay path uses `wss://`
and encrypts application frames before they leave the desktop. Automatic mode
advertises both paths in one pairing URI; the phone races them and keeps the
first authenticated path as the active connection.

The Host is disabled until the user starts mobile access. Stopping the Host drops
active sessions, while the stored identity lets the next start reuse the same
pairing credentials. Treat the pairing URI and the identity file as secrets.

A pairing attempt is never single-shot. The initial race over the advertised
endpoints retries a few times with backoff before it reports failure, so a relay
that has not registered its host yet, a Wi-Fi handover, or a wake from sleep
resolves itself instead of parking the phone on an error until the user taps
again. On the relay side the Host marks itself connected only after the relay
acknowledges its registration (`{"relay":"registered"}`), so the desktop never
tells the user "中转已连接" while a phone would still be answered with 404.

## The desktop's own commands, mirrored

The phone is not a viewer with a second, smaller feature set. It runs the same
React application, so it asks the same questions the desktop does — list this
directory, read this file, stage this change, commit, open a terminal — and
`invoke` routes those questions to the machine that owns the answer: locally on
the desktop, or over the authenticated encrypted socket (`host.invoke`) to the
desktop when the app is running on a phone.

The Host answers with the *same* Rust functions the local webview calls
(`src-tauri/src/remote_ops.rs`), which is why a feature cannot work on one side
and be missing on the other. Two rules keep that safe and maintainable:

* **The Host advertises what it answers.** `host.snapshot.commands` lists the
  reachable commands, and the phone routes a command there only when it is on
  that list. There is no second allowlist in the app to drift out of step, and
  an older APK against a newer desktop keeps working with what it knows.
* **Every command is a decision.** `tests/remote-commands.test.ts` fails if a
  registered command is neither mirrored nor excluded with a written reason, and
  fails again if an exclusion outlives the command it describes.

The exclusions are the commands about *the device in the user's hand* rather
than about the workspace: the phone's own bootstrap and APK update, the pairing
Host's lifecycle, the wake assertion, `pi_connect` (which hands out a
webview-local event channel — phones attach instead), and the three commands
whose paths come from a clipboard or picker on that device.

**The permission this implies is deliberate.** A paired phone is the same user
on the same machine, so it can read and write files, run Git, and open
terminals on the desktop — the pairing page says so in plain words. The token is
therefore a key to that computer: `REMOTE_COMMANDS` is reviewed like a security
boundary, because it is one.

### One project registry

The desktop window owns the project list (names, extra roots, order). It
publishes that list to the Host, which serves it in every snapshot and pushes
changes as `host.projects`; the phone renders it instead of keeping a private
copy. Adding a project from the phone is a `project.add` request the Host hands
back to that same window, which adds it, opens it, and republishes — one writer,
and the phone's rail is never a second opinion.

#### Opening a project from the phone

The registry lists every project; a live Pi connection exists only for the one
the desktop has open. Those are different facts, and the phone used to conflate
them: tapping a listed project without a connection failed with
「电脑端没有这个项目的活动连接」, which read as "the project is there but the tap
does nothing". Tapping now sends `project.open`, the Host hands it to the desktop
window, the window runs its own `connect` (the same one selecting the project
there does), and the phone polls until the connection appears — bounded, so a
desktop that never answers fails the tap instead of hanging it.
`project.add` still implies an open; `project.open` is the open without a
registry write, so a project is only listed once.

**The Host resolves the path, because only it can.** A project is registered
under the spelling the user typed, while the Pi worker reports the canonical
directory it was started in — the same project can be `/tmp/demo` to the phone
and `/private/tmp/demo` to the desktop. Comparing those strings on the phone
turned a project the desktop had open into 「没有活动连接」, and no amount of
retrying could change it, because the phone was comparing two correct answers.
So `connection.resolve` exists: the phone sends a spelling, the Host answers with
the connection that serves it, resolving exactly the way its own bridge resolves
a command (an exact connection id first, then the canonical directory).
`project.open` answers with the connection directly when the project is already
open, which also removes the wait. The phone's own comparison is a fallback for
an older Host, and treats a trailing slash as the same directory — never as a
different project.

The consequence is deliberate: the phone and the desktop share one workspace
pointer. Opening a project on the phone switches the desktop to it, exactly as
opening it on the desktop switches the phone.

### Attachments

An attachment is bytes, so it crosses to the Host as base64 inside the `prompt`
command — the one thing on this list that does not need a new transport. What it
did need is preparation, because a phone is not a desktop here in two ways:

* **A camera photo is several megabytes**, which base64 makes a third larger
  again, in a single WebSocket frame that the Host reads with tungstenite's 16
  MiB limit. Pasting a screenshot already went through `encodeClipboardImage`
  and its 2048px ceiling; picking a file did not.
* **`File.type` is often empty.** Android's picker hands back a `content://`
  source, and an attachment sent with an empty `mimeType` reaches the provider as
  something it cannot decode, and renders as `data:;base64,…`, which no browser
  shows either. The desktop path already derived the type from the file name;
  the picker path did not.

`src/lib/image-attachment.ts` decides both, and its decisions are pure so they
are tested without a canvas or a device: keep an image that is already small,
re-encode past `MAX_ATTACHMENT_EDGE` (2048) or `RECODE_ABOVE_BYTES` (2 MB), keep
PNG as PNG so a screenshot's text stays crisp and make everything else JPEG, and
refuse anything still over `MAX_ATTACHMENT_BYTES` (8 MB) by name. The cap is not
arbitrary: 8 MB of bytes is ~10.7 MB of base64, which fits the 16 MiB frame the
Host accepts with room to spare — and a test pins that relationship, because
raising the cap without raising the frame limit would drop the socket mid-send
rather than refuse the attachment.

### What is not mirrored yet

Both remaining entries are not commands, so they cannot be mirrored by name.

* **Media previews.** The desktop streams images, audio, video and PDFs through
  Tauri's asset protocol, which is "this webview reads this machine's disk" and
  therefore means nothing on a phone: the file is not there and the relay only
  forwards the pairing socket. A phone asks for the bytes over that socket
  instead (`read_media_file`), capped at `media::MAX_REMOTE_MEDIA_BYTES` = 24 MB,
  a number `lib/media-preview.ts` mirrors so the phone can skip a request whose
  answer it already knows; past the cap the view says so and points at the
  desktop. That protocol's scope is `requireLiteralLeadingDot: false`, because
  generated media lives under `~/.pi/agent/orbit-media` and the unix default
  refuses to match a pattern across a dot-prefixed directory.

  Streaming is a deliberate non-goal. Images, short audio and small clips play
  from a `Blob`; a video long enough to want seeking does not fit the cap and is
  answered with a message rather than a download. Making it seek would mean
  Range requests, which the pairing socket does not carry and the relay does not
  forward — a second transport for a file kind this app does not need to play on
  a phone. PDFs land in the same place for a different reason: an Android WebView
  has no inline viewer, so the `<object>` fallback in `MediaView` is what is
  actually shown there.
* **Editing a project's own metadata** (rename, extra roots) and importing a
  session file: the first needs a `project.update` request, the second opens a
  picker on the device that is holding the phone.

### The file editor

The phone edits files with the same editor the desktop uses — CodeMirror 6 with
shiki's tokens, `⌘F` find — and saves with the footer button (`⌘S` on a hardware
keyboard); save travels to the desktop as the `write_text_file` command. See
[EDITOR.md](EDITOR.md).

### The terminal

The dock is the same component on both surfaces, and it is a real PTY on the
desktop either way: `pty_spawn`, `pty_write`, `pty_resize` and `pty_kill` are
mirrored commands, so a phone runs its keystrokes on the Host.

Output needed one thing added, because it was the only half that is a *push*.
`pty_term` emits `pty-data` / `pty-exit` as Tauri events on the machine that owns
the PTY, and a phone has its own window and its own event bus, so it never saw
them. The Host republishes the same coalesced chunks as `pty.event` / `pty.exit`
and the phone re-emits them locally (`src/lib/remote-pty.ts`), which is why
nothing inside the dock had to change. Frames are not project-scoped:
`pty_spawn` already decides the same question, and a terminal belongs to whoever
opened it. `open_pi_terminal` still opens a real terminal window on the desktop
from the phone when a full TUI is wanted.

## Staying reachable

The Host is the desktop process, so "the phone cannot connect" has two causes
that are indistinguishable from the phone: Orbit is not running, or the computer
went to sleep. Both are treated as part of the feature rather than as the user's
problem:

* **Closing the window hides it instead of quitting while the Host is running.**
  The Host lives in this process, and a closed window would have taken every
  attached phone with it. `⌘Q` still quits, and the Dock icon (or the global
  show/hide hotkey) brings the hidden window back. With mobile access off,
  closing the window quits as it always did.
* **While Orbit runs, it holds the two IOKit idle-sleep assertions** — the same
  pair `caffeinate -d -i` creates — so neither the display nor the machine times
  out a few minutes after the last keystroke. The assertion belongs to the
  process, so it covers every window and is released by the process exit.
  Settings → 通用 → 「保持屏幕唤醒」 turns it off; only macOS implements it, and
  the other desktops stay on the operating system's own power settings.
* **A cold start opens on 「移动端」** — the Host switch and the QR code are the
  first screen — because that is the panel a launch exists for. Settings →
  通用 → 「启动页面」 changes it permanently.

### Coming back from another app

The phone's pairing socket is a `WebSocket` inside the WebView, so it does not
survive the app being backgrounded: `WryActivity.onPause` pauses the WebView, and
Doze closes what is left. A return therefore always reconnects, and that part is
Android's rather than ours.

What is ours is what the reconnect does to the screen. It used to replace the
conversation with the loading skeleton — on every single return, which is the
most common thing a phone does. `reconnectKeepsTranscript`
(`src/lib/protocol.ts`) is the rule that stops it, and both of its halves are
load-bearing: `sameConnection` is what separates a recovery from a switch, so
landing on another project cannot leave the previous project's messages under
the new one's title, and `hasMessages` is what separates a recovery from a first
connect, where there is nothing to keep and the skeleton is the honest answer.
A kept transcript says so with a「正在重连电脑…」 pill instead, because content
that looks live while it is not is worse than a skeleton.

Keeping the process alive in the background instead — a foreground service with
a permanent notification — was considered and not taken: it is the only way to
hold a socket across a backgrounded app, and it buys nothing once the reconnect
stops blanking the screen. It would be the right trade only if the phone ever has
to see events *while* it is in the background (notifications, or a turn watched
from another device).

## Install and use the Android build

1. Download `orbit-android-arm64-<tag>.apk` from the Orbit GitHub Release and
   open it on an ARM64 Android phone. If Android asks, allow the browser or file
   manager to install an unknown app. The release APK is signed so later Orbit
   releases using the same upload key can update it.
2. Keep the computer and phone on the same LAN, or connect both to the same
   Tailscale network. On the computer, open the project in Orbit and go to
   **Settings → General → Mobile access**.
3. Click **Enable**, copy the pairing URI, and paste it into Orbit on the phone.
   The URI contains the temporary access token; do not share it. The phone then
   attaches to the active Pi connection on the computer.
4. Send prompts from either side. Pi, tools, thinking, child-agent activity,
   session changes, and Markdown output are executed by the computer and are
   rendered through the same reducer on both devices.

The phone does not start Pi or access the computer filesystem locally. If the
computer Host is stopped, the phone returns to the pairing screen. Start Host
again and pair with the newly generated URI.

Theme ownership follows the same boundary: the desktop resolved light/dark
theme is included in the Host snapshot and broadcast to connected phones when
it changes. Mobile shows the theme as read-only “跟随电脑”; it never sends its
local theme preference back to the Host. Older Hosts without the optional theme
field remain connectable and simply leave the phone on its current theme until
the next themed event.

## Android toolchain

This repository currently uses Tauri CLI 2.11.4. Its Android template targets
Android SDK 36 and NDK 29.0.13846066. The generated Gradle project uses Android
Gradle Plugin 8.11, which requires JDK 17 or newer.

Required local components:

- Android SDK Platform 36
- Android SDK Platform-Tools
- Android SDK Build-Tools 35.0.0 or newer compatible version
- Android SDK Command-line Tools
- NDK (Side by side) 29.0.13846066
- Rust target `aarch64-linux-android`

The project defaults Android `build` and `dev` commands to the `aarch64`
target. This covers current physical Android phones without generating several
gigabytes of unused ARMv7 and emulator-only x86 build artifacts. Pass an
explicit `--target` only when another device architecture is actually needed.

Xcode is used for iOS and cannot replace the Android SDK, NDK, or JDK.

The Android release is signed with a private upload keystore. The keystore and
`keystore.properties` stay outside Git; a debug APK can be installed for local
testing, while a signed release APK can be installed over time and upgraded by
the same signing key.

Tauri's official updater plugin does not support Android or iOS. Orbit therefore
checks its signed GitHub release APK itself on Android, downloads it with Android's
system download manager, and opens the system package installer. Android always
requires the user to confirm a sideloaded update; silent installation is reserved
for managed devices and app stores. The package identifier and signing key must
stay the same for Android to accept the APK as an update.

The canonical Android launcher assets live in `src-tauri/icons/android`. Tauri's
generated Gradle project keeps a separate resource copy, so `bun run tauri android
...` synchronizes those assets before builds. After running `tauri android init`
directly, run `bun run icons:android` before building.

For a browser-only layout preview, run `bun run dev` and open
`http://127.0.0.1:5173/?preview=mobile`. This preview renders the pairing screen
without connecting to a Host; the signed APK is required for device camera and
Android install behavior.

## Sources

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#android)
- [Tauri mobile development](https://v2.tauri.app/develop/)
- [Android Gradle Plugin 8.11 compatibility](https://developer.android.com/build/releases/past-releases/agp-8-11-0-release-notes#compatibility)
- [Android Java versions](https://developer.android.com/build/jdks)
- [Android NDK installation](https://developer.android.com/studio/projects/install-ndk)
- Pi RPC contract: `node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
