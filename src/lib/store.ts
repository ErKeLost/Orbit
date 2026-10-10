import {emptyTelemetry,observe,type Telemetry} from './telemetry'
import { create } from 'zustand'
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { emptyTranscript, reduceEvent, type Event, type Transcript, type RpcSessionState, type UiRequest } from './protocol'
import { parseAgentSnapshot, type AgentSnapshot } from './agents'
import type { RemoteTheme } from './remote-protocol'
export type Panel = 'chat' | 'sessions' | 'tree' | 'commands' | 'settings' | 'mobile-access' | 'changes' | 'pi-tools' | 'inbox' | 'search' | 'automations' | 'notes'
export type SettingsPage = 'general' | 'appearance' | 'chat' | 'skills' | 'inbox' | 'providers' | 'computer-use' | 'screen' | 'sessions' | 'tree' | 'pi-tools' | 'changes' | 'integrations'
export type WorkspaceMode = 'project' | 'home'
export type RuntimeTarget = 'unknown' | 'browser' | 'desktop' | 'mobile'
export type LiveSession = { path: string; cwd: string; title: string; running: boolean }
export type Workspace = {
  telemetry:Telemetry; inspector:boolean; transcript: Transcript; state: RpcSessionState | null; connection: 'offline' | 'connecting' | 'online';
  runtimeTarget:RuntimeTarget; runtimePlatform:string; remoteTheme:RemoteTheme|null; remoteMachineName:string; cwd:string; connectionId:string; homeDir:string; workspaceMode:WorkspaceMode; piVersion:string; panel:Panel; settingsPage:SettingsPage; error:string | null; draft:string;
  dialogs:UiRequest[]; notices:string[]; statuses:Record<string,string>; widgets:Record<string,string[]>; liveSessions:LiveSession[]; agents:AgentSnapshot | null; multiAgentEnabled:boolean; computerUseEnabled:boolean;
  /** Whether the floating screen window is open. Independent of the panel. */
  screenPip:boolean; screenExpanded:boolean;
  set: (patch: Partial<Omit<Workspace,'set'|'event'|'updateAgentSnapshot'>>) => void; event:(event:Event)=>void; updateAgentSnapshot:(input:unknown)=>void;
}
const initialMultiAgentMode=()=>typeof localStorage!=='undefined'&&localStorage.getItem('pi-gui.multiAgentEnabled')==='true'
const initialComputerUseMode=()=>typeof localStorage!=='undefined'&&localStorage.getItem('pi-gui.computerUseEnabled')==='true'
export const workspaceStore=create<Workspace>((set)=>({
  telemetry:emptyTelemetry(),inspector:false,transcript:emptyTranscript(),state:null,connection:'offline',runtimeTarget:'unknown',runtimePlatform:'',remoteTheme:null,remoteMachineName:'',cwd:'',connectionId:'',homeDir:'',workspaceMode:'project',piVersion:'',panel:'chat',settingsPage:'general',error:null,draft:'',dialogs:[],notices:[],statuses:{},widgets:{},liveSessions:[],agents:null,multiAgentEnabled:initialMultiAgentMode(),computerUseEnabled:initialComputerUseMode(),screenPip:false,screenExpanded:false,
  set:(patch)=>set(patch),
  updateAgentSnapshot:(input)=>set(current=>{
    if(input==null||input==='')return {agents:null}
    const agents=parseAgentSnapshot(input)
    return agents?{agents}:current
  }),
  event:(event)=>set(current=>({transcript:reduceEvent(current.transcript,event),telemetry:observe(current.telemetry,event)})),
}))

/**
 * Session panes (Orbit's `TranscriptPool` spirit): a pane can show any pi
 * connection, not just the one the shell projects. `lib/rpc.ts` already keeps a
 * full projection per connection, so a pane that is scoped to a connection
 * reads that snapshot merged over the app-level state, and its writes go back
 * through `patchConnectionSnapshot`.
 *
 * Every existing `useWorkspace(selector)` call keeps working: without a
 * `SessionScope` it reads the app store, inside one it reads that pane's
 * connection.
 */
export type WorkspaceStore = Pick<typeof workspaceStore, 'getState' | 'getInitialState' | 'setState' | 'subscribe'>;

export const SessionScopeContext = createContext<WorkspaceStore | null>(null);

function useStoreSelector<T>(store: WorkspaceStore, selector: (state: Workspace) => T): T {
  return useSyncExternalStore(
    useCallback((listener: () => void) => store.subscribe(listener), [store]),
    useCallback(() => selector(store.getState()), [store, selector]),
    useCallback(() => selector(store.getState()), [store, selector]),
  );
}

/** The store a component should read: its pane's connection when scoped. */
export function useWorkspaceStore(): WorkspaceStore {
  return useContext(SessionScopeContext) ?? workspaceStore;
}

export function useWorkspace<T>(selector: (state: Workspace) => T): T {
  const scoped = useContext(SessionScopeContext);
  return useStoreSelector(scoped ?? workspaceStore, selector);
}

useWorkspace.getState = workspaceStore.getState;
useWorkspace.setState = workspaceStore.setState;
useWorkspace.subscribe = workspaceStore.subscribe;
useWorkspace.getInitialState = workspaceStore.getInitialState;
