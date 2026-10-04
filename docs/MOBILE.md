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
