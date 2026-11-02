import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/rpc'
import { installExternalLinkHandler } from './lib/external-links'
import { installPerfLog } from './lib/perf-log'
import { warmHighlight } from './lib/highlight'
import './lib/perf-tier'
import { Providers } from './components/Providers'
import App from './App'
import './index.css'

document.title = import.meta.env.DEV ? 'Workspace · DEV (HMR)' : 'Workspace'
installExternalLinkHandler()
installPerfLog()

// 语音页是最重的一个 lazy chunk（three.js + R3F）。等首屏闲下来再把它拉下来，
// 否则第一次点侧栏「语音」会先看到一块空白，chunk 到了才是球——那就是"闪一下"。
const prefetchVoice = () => {
  void import('./features/voice/ui/VoicePage').catch(() => undefined)
}
// 固定延迟而不是 requestIdleCallback：dev 下第一次加载 three 会触发 Vite 重新预构建，
// 和首屏抢带宽只会让页面再闪一次。两秒后拉，谁也不碍谁。
window.setTimeout(prefetchVoice, 2500)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Providers>
        <App />
      </Providers>
    </QueryClientProvider>
  </StrictMode>,
)

// 首个代码块/差异块出现前把高亮 Worker 预热好：shiki 的语法和主题是懒加载的，
// 那几百毫秒不该由「第一次滚到那段代码」来买单。启动路径上只排队，不抢首帧。
if (typeof window.requestIdleCallback === 'function') {
  window.requestIdleCallback(warmHighlight, { timeout: 3000 })
} else {
  window.setTimeout(warmHighlight, 1500)
}
