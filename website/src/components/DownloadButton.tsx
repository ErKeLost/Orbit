import { useI18n } from '../lib/i18n'
import { REPO_URL, RELEASES_URL } from '../content/copy'
import { useLatestRelease, currentPlatform, installerFor, type Platform } from '../lib/release'
import { AppleIcon, DownloadIcon, GitHubIcon, LinuxIcon, WindowsIcon } from './icons'

/**
 * The two buttons in the middle of the page.
 *
 * The primary one resolves the visitor's platform to that release's installer —
 * `releases/latest` gives the asset list, `installerFor` picks the `.dmg` for the
 * right architecture, the `.exe` for Windows or the AppImage for Linux — and falls
 * back to the releases page when the API is unreachable or the asset is missing.
 */

const PLATFORM_LABEL: Record<Platform, string> = {
  'mac-arm64': 'macOS',
  'mac-x64': 'macOS',
  windows: 'Windows',
  linux: 'Linux',
}

const PLATFORM_ICON = {
  'mac-arm64': AppleIcon,
  'mac-x64': AppleIcon,
  windows: WindowsIcon,
  linux: LinuxIcon,
} as const

export function DownloadButton({ className = 'btn btn--primary' }: { className?: string }) {
  const { lang } = useI18n()
  const release = useLatestRelease()
  const platform = currentPlatform()
  const href = installerFor(release, platform) ?? RELEASES_URL
  const word = lang === 'zh' ? '下载' : 'Download'

  if (!platform) {
    return (
      <a className={className} href={RELEASES_URL}>
        <DownloadIcon />
        <span>{word}</span>
      </a>
    )
  }

  const Icon = PLATFORM_ICON[platform]
  const version = release?.tag ? ` · ${release.tag}` : ''
  return (
    <a className={className} href={href} title={`${word} ${PLATFORM_LABEL[platform]}${version}`}>
      <Icon />
      <span>
        {word} {PLATFORM_LABEL[platform]}
      </span>
    </a>
  )
}

export function StarButton({ className = 'btn btn--ghost' }: { className?: string }) {
  const { c } = useI18n()
  return (
    <a className={className} href={REPO_URL} target="_blank" rel="noreferrer">
      <GitHubIcon style={{ width: 17, height: 17 }} />
      <span>{c.hero.star}</span>
    </a>
  )
}
