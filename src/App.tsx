import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {MetricsSync} from './lib/metrics'
import { useWorkspace } from './lib/store'
import { compactTitle } from './lib/session-visual'
import { Panel, ExtensionDialog } from './components/Panels'
import { WorkspaceTitlebar } from './components/workspace/WorkspaceTitlebar'
import { WorkspaceLayout } from './components/workspace/WorkspaceLayout'
import { mergeProjectSessions, useProjectSessions } from './hooks/use-project-sessions'
import { useWorkspaceBootstrap, useWorkspaceShortcuts } from './hooks/use-workspace-shell'
import { useDesktopNotifications } from './hooks/use-desktop-integration'
import { useNarrowWorkspace } from './hooks/use-narrow-workspace'
import { WorkspaceNavigationDrawer } from './components/workspace/WorkspaceDrawer'
import { RemotePairingScreen } from './components/remote/RemotePairingScreen'
import './styles/workspace-base.css'
import './App.css'
import './styles/workspace-mobile.css'

type SidebarVisibility = { wide: boolean; narrow: boolean }

function storedBoolean(key: string, fallback: boolean) {
 const value=localStorage.getItem(key)
 return value===null?fallback:value==='true'
}

export default function App(){
 const panel=useWorkspace(s=>s.panel)
 const cwd=useWorkspace(s=>s.cwd)
 const connection=useWorkspace(s=>s.connection)
 const state=useWorkspace(s=>s.state)
 const dialogs=useWorkspace(s=>s.dialogs)
 const liveSessions=useWorkspace(s=>s.liveSessions)
 const online=connection==='online'
 const narrow=useNarrowWorkspace()
 const [sidebarVisibility,setSidebarVisibility]=useState<SidebarVisibility>(()=>({wide:storedBoolean('pi-gui.sidebarOpen',true),narrow:storedBoolean('pi-gui.sidebarOpen.narrow',false)}))
 const sidebarOpen=sidebarVisibility[narrow?'narrow':'wide']
 const setSidebarOpen=useCallback<Dispatch<SetStateAction<boolean>>>(next=>setSidebarVisibility(current=>{
  const mode=narrow?'narrow':'wide'
  const value=typeof next==='function'?next(current[mode]):next
  return current[mode]===value?current:{...current,[mode]:value}
 }),[narrow])
 const bootstrap=useWorkspaceBootstrap()
 useWorkspaceShortcuts(online,setSidebarOpen)
 useDesktopNotifications()
 const sessions=useProjectSessions(cwd)
 useEffect(()=>{
  localStorage.setItem('pi-gui.sidebarOpen',String(sidebarVisibility.wide))
  localStorage.setItem('pi-gui.sidebarOpen.narrow',String(sidebarVisibility.narrow))
 },[sidebarVisibility])
 const merged=useMemo(()=>mergeProjectSessions(cwd,sessions.data??[],liveSessions),[cwd,sessions.data,liveSessions])
 const currentSession=merged.sessions.find(session=>session.path===state?.sessionFile)
 const rawHeaderTitle=panel==='chat'?(currentSession?.name||currentSession?.firstMessage||''):panel==='settings'?'设置':panel==='commands'?'技能与命令':panel==='mobile-access'?'移动端':panel==='screen'?'屏幕':'Orbit'
 const headerTitle=panel==='chat'?compactTitle(rawHeaderTitle):rawHeaderTitle
 const toggleSidebar=()=>setSidebarOpen(value=>!value)
 if(bootstrap.runtimeTarget==='mobile'&&bootstrap.pairing.required) return <RemotePairingScreen pairingUri={bootstrap.pairing.uri} connecting={bootstrap.pairing.connecting} error={bootstrap.pairing.error} onPairingUriChange={bootstrap.setPairingUri} onConnect={value=>void bootstrap.connectPairing(value)} />
 return <main className={`app-shell ${sidebarOpen?'':'sidebar-collapsed'} ${narrow?'narrow-workspace':''}`}>
   {panel==='settings'?<>
    <WorkspaceTitlebar variant="full" sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} title={headerTitle} rawTitle={rawHeaderTitle}/>
    <section className="settings-root"><MetricsSync/><Panel/></section>
   </>:<WorkspaceLayout narrow={narrow} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} online={online} panel={panel} title={headerTitle} rawTitle={rawHeaderTitle} liveSessions={liveSessions} currentSessionFile={state?.sessionFile}/>}
   {narrow&&<WorkspaceNavigationDrawer open={sidebarOpen} onClose={()=>setSidebarOpen(false)} online={online} panel={panel} liveSessions={liveSessions} currentSessionFile={state?.sessionFile}/>}
   {dialogs[0]&&<ExtensionDialog key={dialogs[0].id} dialog={dialogs[0]}/>}
  </main>
}
