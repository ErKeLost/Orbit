import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { copy, type Copy, type Lang } from '../content/copy'

/**
 * Language is app state, not a document rewrite.
 *
 * Order: an explicit `?lang=` (a link someone shared), then the visitor's last
 * choice, then **English**. The browser's own language is deliberately not
 * consulted: the launch audience reads English first, and a Chinese browser is a
 * weak signal compared to the switch in the corner. Whichever wins, `<html lang>`
 * follows it — screen readers and hyphenation both read that value.
 */

type I18n = {
  lang: Lang
  c: Copy
  setLang: (lang: Lang) => void
  toggle: () => void
}

const STORAGE_KEY = 'orbit.site.lang'
const LangContext = createContext<I18n | null>(null)

function isLang(value: unknown): value is Lang {
  return value === 'en' || value === 'zh'
}

function initialLang(): Lang {
  const asked = new URLSearchParams(window.location.search).get('lang')
  if (isLang(asked)) return asked
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isLang(stored)) return stored
  } catch {
    /* private mode: fall through to the default */
  }
  return 'en'
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* a blocked storage API must not break the switch */
    }
  }, [])

  const value = useMemo<I18n>(
    () => ({ lang, c: copy[lang], setLang, toggle: () => setLang(lang === 'zh' ? 'en' : 'zh') }),
    [lang, setLang],
  )

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useI18n(): I18n {
  const context = useContext(LangContext)
  if (!context) throw new Error('useI18n must be used inside <LangProvider>')
  return context
}
