import { StrictMode } from 'react'
import type { ComponentType } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/rpc'
import { installExternalLinkHandler } from './lib/external-links'
import { installPerfLog } from './lib/perf-log'
import './lib/perf-tier'
import { Providers } from './components/Providers'
import './index.css'

document.title = import.meta.env.DEV ? 'Workspace · DEV (HMR)' : 'Workspace'
installExternalLinkHandler()
installPerfLog()

// 借鉴 monocode：App 是独立 chunk，动态加载。原生 splash 窗口（Rust 侧）
// 与这层 HTML 启动画面都立即可见，App chunk 的下载/求值与首帧并行。
const appLoaded = import('./App')

function dismissBootSplash() {
  const splash = document.getElementById('boot-splash')
  if (!splash || splash.dataset.dismissed === '1') return
  splash.dataset.dismissed = '1'
  splash.classList.add('boot-splash-out')
  window.setTimeout(() => splash.remove(), 200)
}

function mount(App: ComponentType) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Providers>
          <App />
        </Providers>
      </QueryClientProvider>
    </StrictMode>,
  )
  // Tauri splashscreen pattern: the native splash window stays up until both
  // the frontend (here) and the Rust setup report ready; Rust then swaps windows.
  // 两帧之后首帧已上屏，启动画面淡出露出真实 UI。
  if (isTauri()) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        dismissBootSplash()
        void invoke('splash_ready', { task: 'frontend' }).catch(() => undefined)
      }),
    )
  } else {
    requestAnimationFrame(() => requestAnimationFrame(dismissBootSplash))
  }
  // 兑底：任何情况下启动画面最多停留 4s，绝不卡住入口。
  window.setTimeout(dismissBootSplash, 4000)
}

void appLoaded.then(({ default: App }) => mount(App))
