import { useEffect, useState } from 'react'

/**
 * The latest GitHub release, resolved in the browser.
 *
 * The download button has to hand the visitor the installer for *their* machine,
 * not a releases page they then have to read. GitHub's API answers with the asset
 * list, so the work is: ask once, cache it, and pick by filename.
 *
 * One public, CORS-open call; 60 requests an hour per IP is the ceiling, which is
 * why the answer is cached in `sessionStorage` for a quarter of an hour. Any
 * failure is silent — the button still points at the releases page.
 */

export type Platform = 'mac-arm64' | 'mac-x64' | 'windows' | 'linux'

export type Release = {
  tag: string
  pageUrl: string
  assets: { name: string; url: string }[]
}

const REPO = 'ErKeLost/Orbit'
const CACHE_KEY = 'orbit.site.release'
const CACHE_MS = 15 * 60 * 1000

type Cache = { at: number; release: Release }

/** What the browser will admit about the machine it is running on. */
export function currentPlatform(): Platform | null {
  const ua = navigator.userAgent
  if (/Windows/i.test(ua)) return 'windows'
  if (/Android/i.test(ua)) return null
  if (/Linux|X11/i.test(ua)) return 'linux'
  if (!/Mac|iPhone|iPad/i.test(ua)) return null
  // Safari and Firefox do not report the architecture; the release only ships
  // Apple Silicon, so arm64 is the honest default rather than a guess.
  const arch = (navigator as Navigator & { userAgentData?: { architecture?: string } }).userAgentData?.architecture
  return arch === 'x86' ? 'mac-x64' : 'mac-arm64'
}

/**
 * Installer patterns, most specific first. Tauri names bundles
 * `Orbit_<version>_<arch>_<kind>`, so the architecture has to be part of the match
 * — a `.dmg` alone could be either.
 */
const PATTERNS: Record<Platform, RegExp[]> = {
  'mac-arm64': [/aarch64[^/]*\.dmg$/i, /arm64[^/]*\.dmg$/i, /\.dmg$/i],
  'mac-x64': [/x64[^/]*\.dmg$/i, /\.dmg$/i],
  windows: [/x64-setup\.exe$/i, /\.msi$/i, /\.exe$/i],
  linux: [/\.AppImage$/i, /amd64\.deb$/i, /\.deb$/i, /\.rpm$/i],
}

export function installerFor(release: Release | null, platform: Platform | null): string | undefined {
  if (!release || !platform) return undefined
  for (const pattern of PATTERNS[platform]) {
    const asset = release.assets.find((item) => pattern.test(item.name))
    if (asset) return asset.url
  }
  return undefined
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

function readCache(): Release | null {
  try {
    const raw = window.sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw) as Cache
    if (!cache.release || Date.now() - cache.at > CACHE_MS) return null
    return cache.release
  } catch {
    return null
  }
}

function writeCache(release: Release) {
  try {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release } satisfies Cache))
  } catch {
    /* private mode: the answer simply is not cached */
  }
}

async function load(): Promise<Release | null> {
  const cached = readCache()
  if (cached) return cached

  const latest = await fetchJson<{
    tag_name?: string
    html_url?: string
    assets?: { name?: string; browser_download_url?: string }[]
  }>(`https://api.github.com/repos/${REPO}/releases/latest`)
  if (!latest?.assets) return null

  const release: Release = {
    tag: latest.tag_name ?? '',
    pageUrl: latest.html_url ?? `https://github.com/${REPO}/releases/latest`,
    assets: latest.assets
      .filter((asset): asset is { name: string; browser_download_url: string } =>
        Boolean(asset.name && asset.browser_download_url),
      )
      .map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
  }
  writeCache(release)
  return release
}

/**
 * The release, once. Both buttons on the page read from this hook, so the page
 * makes one round of requests rather than one per component.
 */
export function useLatestRelease(): Release | null {
  const [release, setRelease] = useState<Release | null>(readCache)

  useEffect(() => {
    if (release) return
    let live = true
    void load().then((next) => {
      if (live && next) setRelease(next)
    })
    return () => {
      live = false
    }
  }, [release])

  return release
}
