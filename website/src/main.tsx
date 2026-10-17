import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

// `BASE_URL` is `/` locally and `/Orbit/` when the site is published under a
// project path on GitHub Pages; Router wants that path without the trailing slash.
const basepath = import.meta.env.BASE_URL.replace(/\/$/, '')

const router = createRouter({
  routeTree,
  basepath: basepath || undefined,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const rootElement = document.getElementById('app')!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  root.render(<RouterProvider router={router} />)
}
