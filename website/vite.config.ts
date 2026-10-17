import { defineConfig } from 'vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'

const config = defineConfig({
  // A project page on GitHub Pages lives under `/Orbit/`; the deploy workflow sets
  // SITE_BASE for that, and everything else (dev, preview, a root domain) stays `/`.
  base: process.env.SITE_BASE || '/',
  resolve: { tsconfigPaths: true },
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
})

export default config
