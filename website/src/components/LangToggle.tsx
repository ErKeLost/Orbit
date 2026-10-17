import { useI18n } from '../lib/i18n'

/** Two-way language switch. The pair is the control; the fill marks the side. */
export function LangToggle() {
  const { lang, c, setLang } = useI18n()
  return (
    <div className="lang" role="group" aria-label={c.nav.langLabel}>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
        EN
      </button>
      <button type="button" aria-pressed={lang === 'zh'} onClick={() => setLang('zh')}>
        中文
      </button>
    </div>
  )
}
