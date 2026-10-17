import { useI18n } from '../lib/i18n'
import { REPO_URL } from '../content/copy'
import markUrl from '../assets/orbit-mark.png'
import { AppleIcon, ChipIcon, GitHubIcon, LinuxIcon, WindowsIcon } from './icons'
import { DownloadButton, StarButton } from './DownloadButton'
import { LangToggle } from './LangToggle'

/**
 * One screen, centred, like a title card.
 *
 * The rule for this page is icons first: a mark instead of a word wherever a mark
 * is unambiguous (the repo, the platforms, the three numbers), and only the words
 * that carry meaning — the promise, the one-line definition, the buttons.
 */

const PLATFORM_ICONS = { apple: AppleIcon, chip: ChipIcon, windows: WindowsIcon, linux: LinuxIcon } as const

// The copy carries the icon name as a string (it is data, not code); this is the
// one place it is narrowed to the map's keys, with a safe fallback.
const platformIcon = (name: string) => PLATFORM_ICONS[name as keyof typeof PLATFORM_ICONS] ?? AppleIcon

export function Stage() {
  const { c } = useI18n()

  return (
    <section className="stage" id="top">
      <div className="stage__scrim" aria-hidden />

      <header className="stage__top">
        <a className="stage__brand" href="#top" aria-label="Orbit">
          <img src={markUrl} alt="" width={30} height={30} />
          <span>Orbit</span>
        </a>

        <div className="stage__top-end is-actions">
          <a className="stage__icon-link" href={REPO_URL} target="_blank" rel="noreferrer" aria-label={c.nav.repo} title={c.nav.repo}>
            <GitHubIcon />
          </a>
          <LangToggle />
        </div>
      </header>

      <div className="stage__copy">
        <h1 className="stage__title">
          {c.hero.title.map((line, index) => (
            <span className={index === 1 ? 'gradient-text' : undefined} key={line}>
              {line}
            </span>
          ))}
        </h1>

        <p className="stage__lede">{c.hero.lede}</p>

        <div className="stage__cta">
          <DownloadButton />
          <StarButton />
        </div>

      </div>

      <footer className="stage__foot">
        <span className="stage__foot-label">{c.platforms.label}</span>
        <ul className="stage__platforms">
          {c.platforms.items.map((platform) => {
            const Icon = platformIcon(platform.icon)
            return (
              <li key={platform.icon}>
                <Icon />
                <span>{platform.label}</span>
              </li>
            )
          })}
        </ul>
      </footer>
    </section>
  )
}
