# orbit site

The 1.0 landing page: one screen, centred, with the app's own new-session backdrop
behind it. TanStack Router (file-based, router-only) + Vite + TypeScript; the look
is hand-written CSS, no UI kit.

```bash
cd website
bun install
bun run dev        # http://localhost:8788
bun run build      # dist/
bun run preview
```

## The backdrop is the app's, not an imitation

`src/lib/galaxy-dots.ts` is a **copy of the app's module**
(`src/features/background/galaxyDots.ts`): the artwork sampled onto the 6px
terminal grid, the plate drifting and breathing, the graph-paper pattern, the
light sweep, the twinkling stars, the motes, and a three-streak meteor burst every
few seconds. `components/GalaxySky.tsx` drives it exactly like
`GalaxyDotBackground` does (40ms frames, pointer parallax, reduced-motion still
frame, paused when hidden).

The copy is deliberate: the site is a standalone deployable and must not import
app internals. If the app's backdrop changes, copy the module again — do not
"improve" the two into different pictures.

## Layout

```
src/
  assets/         mascot + galaxy (imported, so Vite fingerprints them)
  components/     Stage (the whole screen), GalaxySky, DownloadButton, LangToggle, icons
  content/copy.ts every string, English and Chinese, in the same shape
  lib/            i18n context, galaxy-dots (copied from the app)
  routes/         __root.tsx (sky + skip link) and index.tsx (the page)
  styles/         tokens.css, base.css, stage.css
```

## The download button resolves a real installer

`src/lib/release.ts` asks GitHub for the latest release and picks the asset for the
visitor's machine (`Orbit_<v>_aarch64.dmg`, `…_x64-setup.exe`, `…_amd64.AppImage`),
labels the button with that platform's icon, and puts the live star count on the
GitHub button. The answer is cached in `sessionStorage` for 15 minutes (the public
API allows 60 requests an hour per IP) and every failure falls back to the releases
page. The version pill reads the same tag, so tagging `v1.0.0` updates the page
without a code change.

## Artwork

`scripts/make-assets.py` regenerates the favicons (the mascot on the site's own dark
rounded square, so it does not vanish at 16px) and `public/social-card.png` from
`src/assets/`. Re-run it after changing either source image.

## Decisions worth keeping

- **One screen.** `100svh`, three rows (bar, copy, platform capsule), no scroll and
  no sections. Sizes are viewport functions, not a column, so the composition holds
  at 1440×900 and at 520×900.
- **English is the default**, whatever the browser asks for; `?lang=zh` and the
  corner switch override it and the choice is remembered.
- **Copy is typed.** `zh` is declared as `Copy`, so a missing or renamed string is a
  compile error rather than a silent fallback to English.
- **A scrim, not a wall.** The middle of the backdrop is dimmed with a radial so the
  headline never sits on glyph-free noise; the edges keep the grid the app is made of.
- **Numbers must be true.** 8 concurrent workers (`MAX_ACTIVE_CHILDREN`), 33/33 RPC
  commands (`docs/CAPABILITIES.md`). Platforms listed are the ones the release
  workflow actually builds: Apple Silicon, Linux, Windows.
- **Icons are inline at one stroke weight**, because no icon set matches the app's.

## Before tagging 1.0

1. Bump `src-tauri/tauri.conf.json`; the page reads its version from copy, not from
   the app, so update `copy.ts` too.
2. `og:image` / `og:url` need absolute URLs once the domain exists.
3. Check 1440×900, 1280×800, 520×900 in both languages, and with reduced motion on.

## Deploy

Live at **https://orbit-agent.netlify.app** (Netlify project `orbit-agent`, team
`erkelost`).

```bash
cd website
bun run build
npx netlify-cli deploy --prod --dir=dist    # `netlify link --id …` is already in .netlify/
```

`netlify.toml` carries the build (`npx bun@1.4.2 install && … build`), the publish
directory, immutable caching for hashed assets, and the SPA fallback. `og:image`,
`og:url` and `canonical` point at this domain — update them together with any
custom domain.

`.github/workflows/pages.yml` still builds the same folder for GitHub Pages
(`SITE_BASE=/Orbit/`); it is a second, independent target, not a dependency.
