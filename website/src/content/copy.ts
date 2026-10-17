/**
 * Every string on the page, in both languages.
 *
 * One screen means one argument: the English object is the shape and `zh` is typed
 * against it, so a sentence added in one language and forgotten in the other is a
 * compile error rather than a page that silently falls back.
 */

const en = {
  nav: {
    repo: 'GitHub',
    langLabel: 'Language',
  },
  hero: {
    title: ['Your agent.', 'Your machine.'],
    lede: 'A local-first desktop workspace for Pi.',
    star: 'GitHub',
  },
  platforms: {
    label: 'Available for',
    items: [
      { icon: 'apple', label: 'Apple Silicon' },
      { icon: 'chip', label: 'Intel' },
      { icon: 'windows', label: 'Windows' },
      { icon: 'linux', label: 'Linux' },
    ],
  },
  skip: 'Skip to content',
}

type Copy = typeof en

const zh: Copy = {
  nav: {
    repo: 'GitHub',
    langLabel: '语言',
  },
  hero: {
    title: ['你的 agent。', '你的机器。'],
    lede: '给 Pi 的本地优先桌面工作区。',
    star: 'GitHub',
  },
  platforms: {
    label: '支持平台',
    items: [
      { icon: 'apple', label: 'Apple Silicon' },
      { icon: 'chip', label: 'Intel' },
      { icon: 'windows', label: 'Windows' },
      { icon: 'linux', label: 'Linux' },
    ],
  },
  skip: '跳到正文',
}

export type Lang = 'en' | 'zh'
export type { Copy }
export const copy: Record<Lang, Copy> = { en, zh }

export const RELEASES_URL = 'https://github.com/ErKeLost/Orbit/releases/latest'
export const REPO_URL = 'https://github.com/ErKeLost/Orbit'
