import { createRootRoute, Outlet } from '@tanstack/react-router'

import { LangProvider, useI18n } from '../lib/i18n'
import { GalaxySky } from '../components/GalaxySky'
import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/stage.css'

export const Route = createRootRoute({ component: Root })

function Root() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  )
}

/**
 * The document, top to bottom: one fixed sky, the bar, and one screen of content.
 * There is no footer and no scroll target — the page is a plate, not a document.
 */
function Shell() {
  const { c } = useI18n()
  return (
    <>
      <a className="skip-link" href="#main">
        {c.skip}
      </a>

      <div className="sky" aria-hidden>
        <GalaxySky />
      </div>

      <main id="main">
        <Outlet />
      </main>
    </>
  )
}
