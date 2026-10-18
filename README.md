<p align="center">
  <img src="public/orbit-mark.png" alt="Orbit" width="88" />
</p>

<h1 align="center">Orbit</h1>

<p align="center">
  <strong>A work agent that runs on your own machine.</strong>
</p>

<p align="center">
  <a href="https://github.com/ErKeLost/Orbit/releases/latest">Download the latest release</a>
</p>

## Getting started

You'll need Node.js 20+, Bun 1.4+, a stable Rust toolchain, and Pi installed and signed in.

```bash
bun install
bun run tauri:dev     # development
bun run tauri:build   # package
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the layer boundaries, state ownership, and RPC routing, and [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) for the full feature set and its boundaries.

## Credits

Thanks to [MonoCode](https://github.com/hardbeat920/monocode) by [@hardbeat920](https://github.com/hardbeat920) — where Orbit's UI started.

