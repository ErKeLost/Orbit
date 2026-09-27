# Desktop releases

Pushing a `v*` tag starts the `Release desktop app` GitHub Actions workflow.
It publishes signed installers for Apple Silicon macOS, Intel macOS, Linux x86_64,
and Windows, then uploads `latest.json` for the built-in Tauri updater.

## macOS signing (self-signed, zero-cost)

macOS builds are signed with a fixed self-signed code signing certificate
("Orbit Developer"), not ad-hoc. This is what keeps macOS Accessibility (TCC)
grants alive across in-app updates: TCC matches grants against the app's
Designated Requirement, and ad-hoc signatures produce a new cdhash (and
therefore a new requirement) on every build, so every update would have
required re-granting. A stable certificate keeps the requirement stable.

Setup once per machine / repository:

1. Local: run `bun run signing:setup`. It generates the certificate into the
   login keychain, exports `work/orbit-signing.p12` (plus a base64 copy and the
   password, all git-ignored), and grants `/usr/bin/codesign` access to the key.
   Local builds pick the identity up automatically through `scripts/tauri.mjs`.
2. CI: add repository secrets `ORBIT_MACOS_SIGNING_P12_BASE64` (contents of
   `work/orbit-signing.p12.base64`) and `ORBIT_MACOS_SIGNING_P12_PASSWORD`
   (contents of `work/orbit-signing.password`). The release workflow exposes
   them as `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / `APPLE_SIGNING_IDENTITY`
   for the bundler, which imports the P12 into a temporary keychain. Missing
   secrets fail the macOS jobs instead of silently falling back to ad-hoc.

The certificate is untrusted by Apple by definition, and that is fine for this
distribution model: the in-app updater extracts the signed `.app` bundle
itself (no Gatekeeper involvement, no quarantine attribute), so colleagues get
seamless updates. Only the very first install from the downloaded `.dmg` needs
a one-time manual approval (right-click → Open, or System Settings → Privacy &
Security → Open Anyway) because the build is not notarized.

Keep the certificate forever and never regenerate it casually: a new
certificate means a new Designated Requirement, and every colleague would need
to re-grant Accessibility once more. The minisign updater key
(`TAURI_SIGNING_PRIVATE_KEY`) is independent of this certificate and stays as-is.

## Linux and Android signing

Linux publishes an AppImage, a Debian package, and an RPM package. The `.deb`
and `.rpm` declare Node.js >= 22.19.0 as a package dependency, so apt/dnf installs
it automatically when an enabled distribution or NodeSource repository provides
that version. This adds only package metadata to Orbit's release artifacts.

Fedora KDE Plasma users can install the `.rpm` or run the AppImage. AppImage
cannot install system dependencies, so AppImage users must provide Node.js >=
22.19.0 separately. The official Tauri updater uses the signed AppImage artifact
on Linux; `.deb` and `.rpm` installations are updated by installing a newer
package manually (or through the user's package manager).

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
