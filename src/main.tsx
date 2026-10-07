import { StrictMode } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/rpc'
import { installExternalLinkHandler } from './lib/external-links'
import { installPerfLog } from './lib/perf-log'
import './lib/perf-tier'
import App from './App'
import './index.css'
import {Providers} from './components/Providers'
document.title = import.meta.env.DEV ? 'Workspace · DEV (HMR)' : 'Workspace'
installExternalLinkHandler()
installPerfLog()
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}><Providers><App/></Providers></QueryClientProvider></StrictMode>)

// Tauri splashscreen pattern: the native splash window stays up until both the
// frontend (here) and the Rust setup report ready; Rust then swaps windows.
if (isTauri()) requestAnimationFrame(() => requestAnimationFrame(() => { void invoke('splash_ready', { task: 'frontend' }).catch(() => undefined) }))
