import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function computerUseDevReload() {
  const root = path.resolve(import.meta.dirname)
  const watched = [
    path.resolve(root, 'src-tauri/resources/computer-use'),
    path.resolve(root, 'src-tauri/resources/gui-extension.ts'),
    path.resolve(root, 'src-tauri/src/ax.rs'),
    path.resolve(root, 'src-tauri/src/fast_ax.rs'),
    path.resolve(root, 'src-tauri/src/bin/ax_control.rs'),
  ]
  return {
    name: 'orbit-computer-use-dev-reload',
    apply: 'serve' as const,
    configureServer(server: { watcher: { add: (paths: string[]) => void; on: (event: string, callback: (file: string) => void) => void }; ws: { send: (payload: { type: string; path: string }) => void } }) {
      server.watcher.add(watched)
      let timer: ReturnType<typeof setTimeout> | undefined
      server.watcher.on('change', file => {
        if (!watched.some(rootPath => file === rootPath || file.startsWith(`${rootPath}${path.sep}`))) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => server.ws.send({ type: 'full-reload', path: '*' }), 800)
      })
    },
  }
}

// Tauri 2 official Vite guide: docs/SOURCES.md (T1).
export default defineConfig({
  plugins: [react(), tailwindcss(), computerUseDevReload()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
    dedupe: ['react', 'react-dom'],
  },
  clearScreen: false,
  // Second entry for the native Tauri splashscreen window.
  build: { rollupOptions: { input: { main: path.resolve(import.meta.dirname, 'index.html'), splashscreen: path.resolve(import.meta.dirname, 'splashscreen.html') } } },
  server: { port: Number(process.env.ORBIT_DEV_PORT ?? 5173), strictPort: true, host: '127.0.0.1', watch: { ignored: ['**/src-tauri/target/**', path.join(import.meta.dirname, 'work', '**')] } },
})
