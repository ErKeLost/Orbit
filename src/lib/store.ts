import {emptyTelemetry,observe,type Telemetry} from './telemetry'
import { create } from 'zustand'
import { emptyTranscript, reduceEvent, type Event, type Transcript, type RpcSessionState, type UiRequest } from './protocol'
import { parseAgentSnapshot, type AgentSnapshot } from './agents'
import type { RemoteTheme } from './remote-protocol'
export type Panel = 'chat' | 'sessions' | 'tree' | 'commands' | 'settings' | 'mobile-access' | 'screen' | 'console' | 'changes' | 'pi-tools'
export type SettingsPage = 'general' | 'providers' | 'computer-use' | 'sessions' | 'tree' | 'pi-tools' | 'changes' | 'console'
export type WorkspaceMode = 'project' | 'home'
export type RuntimeTarget = 'unknown' | 'browser' | 'desktop' | 'mobile'
export type LiveSession = { path: string; cwd: string; title: string; running: boolean }
export type Workspace = {
  telemetry:Telemetry; inspector:boolean; transcript: Transcript; state: RpcSessionState | null; connection: 'offline' | 'connecting' | 'online';
  runtimeTarget:RuntimeTarget; runtimePlatform:string; remoteTheme:RemoteTheme|null; remoteMachineName:string; cwd:string; connectionId:string; homeDir:string; workspaceMode:WorkspaceMode; piVersion:string; panel:Panel; settingsPage:SettingsPage; error:string | null; draft:string;
  dialogs:UiRequest[]; notices:string[]; statuses:Record<string,string>; widgets:Record<string,string[]>; liveSessions:LiveSession[]; agents:AgentSnapshot | null; multiAgentEnabled:boolean; computerUseEnabled:boolean;
  set: (patch: Partial<Omit<Workspace,'set'|'event'|'updateAgentSnapshot'>>) => void; event:(event:Event)=>void; updateAgentSnapshot:(input:unknown)=>void;
}
const initialMultiAgentMode=()=>typeof localStorage!=='undefined'&&localStorage.getItem('pi-gui.multiAgentEnabled')==='true'
const initialComputerUseMode=()=>typeof localStorage!=='undefined'&&localStorage.getItem('pi-gui.computerUseEnabled')==='true'
export const useWorkspace=create<Workspace>((set)=>({
  telemetry:emptyTelemetry(),inspector:false,transcript:emptyTranscript(),state:null,connection:'offline',runtimeTarget:'unknown',runtimePlatform:'',remoteTheme:null,remoteMachineName:'',cwd:'',connectionId:'',homeDir:'',workspaceMode:'project',piVersion:'',panel:'chat',settingsPage:'general',error:null,draft:'',dialogs:[],notices:[],statuses:{},widgets:{},liveSessions:[],agents:null,multiAgentEnabled:initialMultiAgentMode(),computerUseEnabled:initialComputerUseMode(),
  set:(patch)=>set(patch),
  updateAgentSnapshot:(input)=>set(current=>{
    if(input==null||input==='')return {agents:null}
    const agents=parseAgentSnapshot(input)
    return agents?{agents}:current
  }),
  event:(event)=>set(current=>({transcript:reduceEvent(current.transcript,event),telemetry:observe(current.telemetry,event)})),
}))
