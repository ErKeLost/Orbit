import { QueryClient } from "@tanstack/react-query";
import { invoke } from "./native";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { useWorkspace, type LiveSession, type Workspace } from "./store";
import { projectExtraRoots, useProjects } from "./projects";
import { parseAgentSnapshot } from "./agents";
import { emptyTelemetry, observe } from "./telemetry";
import {
  emptyTranscript,
  hydrate,
  reduceEvent,
  sameModel,
  transcriptLoading,
  withPendingModel,
  type Event,
  type PendingModel,
  type PiMessage,
  type RpcSessionState,
  type Transcript,
  type UiRequest,
} from "./protocol";
import { sendRemotePiCommand } from "./remote-runtime";
import type { RemoteJson } from "./remote-protocol";
import { mobileRuntime } from "./runtime";

export const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,staleTime:15000,gcTime:120000}}})

/**
 * The connection/transcript engine: the per-connection snapshot table, the
 * request pump, the event dispatcher and the transcript cache that the
 * connection and session modules are built on. It depends on nothing above it,
 * so the import graph stays acyclic (core ← connection ← session).
 */
export type Snapshot=Pick<Workspace,'transcript'|'telemetry'|'state'|'connection'|'error'|'draft'|'dialogs'|'notices'|'statuses'|'widgets'|'agents'>
type Pending={project:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}
const SESSION_FILES_KEY='pi-gui.sessionFiles.v1',LEGACY_SESSION_FILES_KEY=['pi-gui','sessionFiles'].join('.')
const pending=new Map<string,Pending>(),snapshots=new Map<string,Snapshot>(),connections=new Map<string,{token:symbol;cwd:string}>(),projectActive=new Map<string,string>(),sessionOwners=new Map<string,string>(),eventQueues=new Map<string,Event[]>(),flushTimers=new Map<string,ReturnType<typeof setTimeout>>()
const sessionMetadataPending=new Set<string>()
const reconnectingProjects=new Map<string,Promise<void>>()
/** 正在拉历史消息的连接。切回这种连接时不能把骨架屏收掉，否则会先闪一下空首页。 */
const loadingConnections=new Set<string>()
/** 已要求、待 Pi 确认的模型切换（见 `protocol.ts` 的 `withPendingModel`）。 */
const pendingModels=new Map<string,PendingModel>()
/**
 * 意图挂在「项目」上，不挂在 connection 上。
 *
 * 切换 provider 会 `disconnect` + `connect`，连接 id 可能变（一个项目也可以有几条
 * 并行连接），但用户要的是「这个项目用 Tare」——所以按 cwd 记，重连之后仍然算数。
 * 传 connection id 时解析成它自己的 cwd。
 */
function projectKey(target:string){return connections.get(target)?.cwd??target}
/**
 * 用户已经在界面上选定的模型：立刻贴到 store 和轮询缓存上，之后 Pi 的确认只是
 * 补齐细节。重连（停掉 Pi、重新起进程、恢复会话）要好几秒，不能让用户在这几秒里
 * 看着上一个 provider —— 也不能在切回会话时从轮询缓存里把旧模型翻出来。
 */
export function expectModel(target:string,model:PendingModel){
 const key=projectKey(target),id=route(target)
 pendingModels.set(key,model)
 const state=current(id).state
 if(state)patch(id,{state})
 queryClient.setQueryData(['pi','live-state',id],current(id).state??undefined)
}
/**
 * 撤下意图，并把一份权威状态写进 store 和轮询缓存。
 *
 * 两条路：Pi 确认了新模型（`get_state` 就是它），或者用户放弃/失败要回滚到
 * 切换前的那份。不传状态就只撤意图，不动已写入的状态。
 */
export function settleModel(target:string,state?:RpcSessionState){
 const key=projectKey(target),id=route(target)
 pendingModels.delete(key)
 const next=state??current(id).state
 if(!next)return
 patch(id,{state:next})
 queryClient.setQueryData(['pi','live-state',id],next)
}
/** 待确认的模型（轮询结果写进 store 前也要盖一次）。 */
export function pendingModel(target:string){return pendingModels.get(projectKey(target))}
const REMOTE_CONNECTION_KEY='orbit.remote.connection.v1'
const fresh=():Snapshot=>({transcript:emptyTranscript(),telemetry:emptyTelemetry(),state:null,connection:'offline',error:null,draft:'',dialogs:[],notices:[],statuses:{},widgets:{},agents:null})
function snapshot():Snapshot{const s=useWorkspace.getState();return {transcript:s.transcript,telemetry:s.telemetry,state:s.state,connection:s.connection,error:s.error,draft:s.draft,dialogs:s.dialogs,notices:s.notices,statuses:s.statuses,widgets:s.widgets,agents:s.agents}}
/**
 * The connection a call acts on when the caller does not say: the one the shell
 * is projecting. Never the bare project path — a project can have many live
 * connections (one per session), and "the project" is not a session.
 */
function activeTarget(){const s=useWorkspace.getState();return s.connectionId||s.cwd}
/** A connection id resolves to itself; only a bare project path goes through the project route. */
function route(target=activeTarget()){return connections.has(target)?target:projectActive.get(target)??target}
function connectionsFor(cwd:string){return [...connections.entries()].flatMap(([id,meta])=>meta.cwd===cwd?[id]:[])}
function readSessionFiles():Record<string,string>{try{return JSON.parse(localStorage.getItem(SESSION_FILES_KEY)??localStorage.getItem(LEGACY_SESSION_FILES_KEY)??'{}')}catch{return {}}}
function persistSession(cwd:string,sessionFile?:string){if(!sessionFile)return;const files=readSessionFiles();files[cwd]=sessionFile;localStorage.setItem(SESSION_FILES_KEY,JSON.stringify(files))}
function current(id:string):Snapshot{return useWorkspace.getState().connectionId===id?snapshot():snapshots.get(id)??fresh()}
// 按 messages 数组引用缓存：流式里每个 patch 都会比较前后标题，原来每次都从头扫消息；
// messages 引用没变（多数 patch 只改 phase/tools/telemetry）时直接复用上次结果。
const titleCache=new WeakMap<object,string>()
export function firstUserTitle(transcript:Workspace['transcript']){
 const cached=titleCache.get(transcript.messages)
 if(cached!==undefined)return cached
 const title=scanFirstUserTitle(transcript)
 titleCache.set(transcript.messages,title)
 return title
}
function scanFirstUserTitle(transcript:Workspace['transcript']){
 for(const item of transcript.messages){
  if(item.message.role!=='user')continue
  const content=item.message.content
  if(typeof content==='string'&&content.trim())return content.trim().slice(0,80)
  if(Array.isArray(content)){
   const text=content.flatMap(part=>part.type==='text'&&part.text?[part.text]:[]).join('').trim()
   if(text)return text.slice(0,80)
  }
 }
 return ''
}
function sameLiveSessions(a:LiveSession[],b:LiveSession[]){return a.length===b.length&&a.every((item,index)=>item.path===b[index]?.path&&item.cwd===b[index]?.cwd&&item.title===b[index]?.title&&item.running===b[index]?.running&&item.needsInput===b[index]?.needsInput&&item.connectionId===b[index]?.connectionId)}
function syncLiveSessions(){
 const items:LiveSession[]=[],seen=new Set<string>()
 const ids=new Set([...snapshots.keys(),useWorkspace.getState().connectionId].filter(Boolean))
 for(const id of ids){
  const snap=current(id),path=snap.state?.sessionFile,cwd=connections.get(id)?.cwd??useWorkspace.getState().cwd
  if(!path||seen.has(path))continue
  const running=snap.transcript.running||snap.transcript.compacting,needsInput=snap.dialogs.length>0
  if(!running&&!needsInput&&!snap.transcript.messages.some(item=>item.message.role==='user'))continue
  seen.add(path);items.push({path,cwd,connectionId:id,title:firstUserTitle(snap.transcript)||'新会话',running,needsInput})
 }
 if(!sameLiveSessions(useWorkspace.getState().liveSessions,items))useWorkspace.getState().set({liveSessions:items})
}
function invalidateSessionList(id:string){
 const cwd=connections.get(id)?.cwd??useWorkspace.getState().cwd
 if(cwd)void queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]})
}
async function ensureSessionMetadata(id:string){
 if(sessionMetadataPending.has(id))return
 sessionMetadataPending.add(id)
 try{
  const commands=await request<{commands:{name:string}[]}>({type:'get_commands'},30000,id)
  if(!commands.commands.some(command=>command.name==='gui-session-meta'))return
  await request({type:'prompt',message:'/gui-session-meta'},60000,id)
  await refresh(id);invalidateSessionList(id)
 }catch{/* Metadata is optional; the default title and icon remain usable. */}
 finally{sessionMetadataPending.delete(id)}
}
const snapshotListeners=new Map<string,Set<()=>void>>()
function notifySnapshot(id:string){const set=snapshotListeners.get(id);if(!set)return;for(const listener of[...set])listener()}
function patch(id:string,value:Partial<Snapshot>){
 // 用户刚点了切换、Pi 还没确认的模型优先：重连期间回来的 `get_state` 是重启后的
 // 旧模型，直接写进 store 会把刚选好的那个顶回旧值（“等了十秒自己变”）。
 const pending=pendingModels.get(projectKey(id))
 const resolved=pending&&value.state?{...value,state:withPendingModel(value.state,pending)}:value
 const previous=current(id),next={...previous,...resolved}
 if(previous.state?.sessionFile&&previous.state.sessionFile!==next.state?.sessionFile&&sessionOwners.get(previous.state.sessionFile)===id)sessionOwners.delete(previous.state.sessionFile)
 snapshots.set(id,next);if(next.state?.sessionFile)sessionOwners.set(next.state.sessionFile,id);if(useWorkspace.getState().connectionId===id)useWorkspace.getState().set(resolved);notifySnapshot(id)
 const activityChanged=previous.transcript.running!==next.transcript.running||previous.transcript.compacting!==next.transcript.compacting||previous.state?.sessionFile!==next.state?.sessionFile||previous.dialogs.length!==next.dialogs.length||firstUserTitle(previous.transcript)!==firstUserTitle(next.transcript)
 if(activityChanged)syncLiveSessions()
 // 会话级生命周期事件：每条连接各自发，后台会话和前台会话一视同仁（通知、自动化回写、检查点都挂在这上面）。
 const sessionFile=next.state?.sessionFile,cwd=connections.get(id)?.cwd
 if(previous.transcript.running&&!next.transcript.running&&sessionFile&&cwd)window.dispatchEvent(new CustomEvent('orbit-turn-settled',{detail:{cwd,sessionFile,connectionId:id,title:firstUserTitle(next.transcript),error:next.transcript.error??null}}))
 if(next.dialogs.length>previous.dialogs.length&&cwd)window.dispatchEvent(new CustomEvent('orbit-session-needs-input',{detail:{cwd,sessionFile:sessionFile??'',connectionId:id,title:firstUserTitle(next.transcript)}}))
 if(previous.state?.sessionFile!==next.state?.sessionFile&&next.state?.sessionFile)invalidateSessionList(id)
}
/** A UI-side transcript event (optimistic preview, settle) for one connection, not the shell's projection. */
export function applyLocalEvent(id:string,event:Event){const s=current(id);patch(id,{transcript:reduceEvent(s.transcript,event),telemetry:observe(s.telemetry,event)})}
function failPending(project:string,message:string){for(const [id,p]of pending){if(p.project!==project)continue;clearTimeout(p.timeout);p.reject(new Error(message));pending.delete(id)}}
export function suspendRemoteConnection(message='电脑连接已断开，正在重连'){
 if(!mobileRuntime())return
 const ids=new Set([...connections.keys(),useWorkspace.getState().connectionId].filter(Boolean))
 for(const id of ids){clearEvents(id);failPending(id,message);patch(id,{connection:'connecting',error:null})}
 queryClient.cancelQueries()
}
function applyEvent(event:Event,project:string){
 if(event.type==='response'){
  const response=event as unknown as RpcResponse;if(!response.id)return;const p=pending.get(response.id)
  if(!p){
   if(response.success&&['new_session','switch_session'].includes(String(response.command)))void loadMessages(project).catch(error=>patch(project,{error:String(error)}))
   return
  }
  clearTimeout(p.timeout);pending.delete(response.id);if(response.success)p.resolve('data'in response?response.data:undefined);else p.reject(new Error(response.error));return
 }
 const s=current(project)
 if(event.type==='extension_ui_request'){
  const request=event as unknown as UiRequest
  if(['select','confirm','input','editor'].includes(request.method))patch(project,{dialogs:[...s.dialogs,request]})
  else if(request.method==='notify')patch(project,{notices:[...s.notices,request.message].slice(-5)})
  else if(request.method==='set_editor_text')patch(project,{draft:request.text})
  else if(request.method==='setStatus'){
   if(request.statusKey==='gui-agents'){
    const statuses={...s.statuses};delete statuses['gui-agents']
    const text=request.statusText??'',agents=parseAgentSnapshot(text)
    patch(project,{statuses,...(!text?{agents:null}:agents?{agents}:{})})
   }else patch(project,{statuses:{...s.statuses,[request.statusKey]:request.statusText??''}})
  }
  else if(request.method==='setWidget')patch(project,{widgets:{...s.widgets,[request.widgetKey]:request.widgetLines??[]}})
  else if(request.method==='setTitle'&&useWorkspace.getState().connectionId===project)document.title=request.title
  return
 }
 patch(project,{transcript:reduceEvent(s.transcript,event),telemetry:observe(s.telemetry,event)})
 if(['compaction_end','message_end','agent_settled'].includes(event.type))void queryClient.invalidateQueries({queryKey:['pi','live-stats',project]})
 if(event.type==='agent_settled'){
  if(s.state?.sessionFile)void queryClient.invalidateQueries({queryKey:['pi','turn-durations',s.state.sessionFile]})
  void refresh(project).then(()=>ensureSessionMetadata(project)).catch(error=>patch(project,{error:String(error)}))
 }
}
const burstEvents=new Set(['message_update','tool_execution_update'])
// Orbit's harness cadence (app/model/harnessFlush.ts): the visible
// connection flushes once per animation frame; hidden connections and a
// backgrounded window advance on a slower 100ms timer so background streams
// never drive the whole UI at display refresh rate.
const BACKGROUND_FLUSH_MS=100
type FlushHandle={kind:'raf'|'timeout';id:number}
const flushHandles=new Map<string,FlushHandle>()
function cancelFlush(project:string){
 const handle=flushHandles.get(project);if(!handle)return
 if(handle.kind==='raf')cancelAnimationFrame(handle.id);else clearTimeout(handle.id)
 flushHandles.delete(project)
}
function scheduleFlush(project:string){
 if(flushHandles.has(project))return
 const run=()=>{flushHandles.delete(project);flushEvents(project)}
 const foreground=typeof document!=='undefined'&&!document.hidden&&useWorkspace.getState().connectionId===project&&typeof requestAnimationFrame==='function'
 flushHandles.set(project,foreground?{kind:'raf',id:requestAnimationFrame(run)}:{kind:'timeout',id:setTimeout(run,BACKGROUND_FLUSH_MS) as unknown as number})
}
function flushEvents(project:string){
 cancelFlush(project)
 const timer=flushTimers.get(project);if(timer)clearTimeout(timer);flushTimers.delete(project)
 const queue=eventQueues.get(project);if(!queue?.length)return;eventQueues.delete(project)
 // burst 队列里只会是 message_update / tool_execution_update。此前逐条
 // applyEvent，每条各做一次 patch（store 提交 + 全量订阅者通知）：快速流式时
 // 一个窗口内多达 5~15 次提交。逐条 reduce 后只 patch 一次，结果与逐条应用一致。
 const s=current(project)
 patch(project,{transcript:queue.reduce((transcript,event)=>reduceEvent(transcript,event),s.transcript),telemetry:queue.reduce((telemetry,event)=>observe(telemetry,event),s.telemetry)})
}
function clearEvents(project:string){cancelFlush(project);const timer=flushTimers.get(project);if(timer)clearTimeout(timer);flushTimers.delete(project);eventQueues.delete(project)}
function dispatch(event:Event,project:string){
 // Anything a user may act on (approvals, dialogs, lifecycle) lands at once,
 // after delivering the output that preceded it so ordering is preserved.
 if(!burstEvents.has(event.type)){flushEvents(project);applyEvent(event,project);return}
 const queue=eventQueues.get(project)??[];queue.push(event);eventQueues.set(project,queue)
 scheduleFlush(project)
}
/** Tab activation catches the visible connection up without waiting a frame. */
export function flushForegroundEvents(){const id=useWorkspace.getState().connectionId;if(id)flushEvents(id)}
export function dispatchRemoteEvent(project:string,payload:unknown){
 if(!project||typeof payload!=='object'||payload===null||typeof (payload as {type?:unknown}).type!=='string')return
 dispatch(payload as Event,project)
}
function asRemoteCommand(command:Record<string,unknown>){return command as unknown as Record<string,RemoteJson>}
function sendCommand(project:string,command:Record<string,unknown>){
 return mobileRuntime()?sendRemotePiCommand(project,asRemoteCommand(command)):invoke('pi_send',{project,command})
}
export function request<T=unknown>(command:RpcCommand,timeoutMs=30000,target=activeTarget()):Promise<T>{
 const id=crypto.randomUUID(),project=route(target)
 return new Promise<T>((resolve,reject)=>{
  const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`Pi ${command.type} 响应超时`))},timeoutMs)
  pending.set(id,{project,resolve:value=>resolve(value as T),reject,timeout})
  void sendCommand(project,{...command,id}).catch(error=>{clearTimeout(timeout);pending.delete(id);reject(new Error(String(error)))})
 })
}
export function persistedSessionFile(project:string):string {
 const value=readSessionFiles()[project];return typeof value==='string'?value:''
}
const multiAgentModeCommand=(enabled=useWorkspace.getState().multiAgentEnabled)=>({type:'prompt' as const,message:`/gui-agent-mode ${JSON.stringify({enabled})}`})
const computerUseModeCommand=(enabled=useWorkspace.getState().computerUseEnabled)=>({type:'prompt' as const,message:`/gui-computer-use-mode ${JSON.stringify({enabled})}`})
const browserUseModeCommand=(enabled=useWorkspace.getState().browserUseEnabled)=>({type:'prompt' as const,message:`/gui-browser-use-mode ${JSON.stringify({enabled})}`})
export const syncMultiAgentMode=(target:string,enabled=useWorkspace.getState().multiAgentEnabled)=>request(multiAgentModeCommand(enabled),30000,target)
export const syncComputerUseMode=(target:string,enabled=useWorkspace.getState().computerUseEnabled)=>request(computerUseModeCommand(enabled),30000,target)
export const syncBrowserUseMode=(target:string,enabled=useWorkspace.getState().browserUseEnabled)=>request(browserUseModeCommand(enabled),30000,target)
// 模式开关记在 Pi 进程内，会话文件和开关值不变时没必要在每次发送前再往返两次。
// key = 会话文件 + 两个开关值；切会话/开关变化/连接关闭时自然失效。
const syncedModes=new Map<string,string>()
const modesKey=(id:string)=>{const s=useWorkspace.getState();return `${current(id).state?.sessionFile??''}|${s.multiAgentEnabled}|${s.computerUseEnabled}|${s.browserUseEnabled}`}
const syncSessionModes=async(target:string)=>{
 const id=route(target),key=modesKey(id)
 syncedModes.delete(id)
 await Promise.all([syncMultiAgentMode(target),syncComputerUseMode(target),syncBrowserUseMode(target)])
 syncedModes.set(id,key)
}
/** 发送前调用：模式已同步过就直接返回，不再产生 RPC 往返。 */
export async function ensureSessionModes(target=activeTarget()){
 const id=route(target)
 if(syncedModes.get(id)===modesKey(id))return
 await syncSessionModes(target)
}
export const setSessionRoots=(roots:string[],target=activeTarget())=>request({type:'prompt',message:`/gui-workspace-set ${JSON.stringify({roots})}`},30000,target)
export async function syncConfiguredProjectRoots(cwd:string,target=cwd){const project=useProjects.getState().projects.find(item=>item.path===cwd);if(project)await setSessionRoots(projectExtraRoots(project),target)}
export async function refresh(target=activeTarget()){
 const id=route(target),state=await request<RpcSessionState>({type:'get_state'},30000,id)
 // Pi 回的就是刚要求的那个模型 → 意图完成，之后全听 `get_state` 的。
 const key=projectKey(id),pending=pendingModels.get(key)
 if(pending&&sameModel(pending,state.model))pendingModels.delete(key)
 patch(id,{state})
 // 轮询缓存同步成刚拿到的真实状态：从设置页切回会话时，MetricsSync 一挂载读到的
 // 就是它，而不是切换之前的旧快照。
 queryClient.setQueryData(['pi','live-state',id],withPendingModel(state,pendingModels.get(key)))
 const cwd=connections.get(id)?.cwd??useWorkspace.getState().cwd;if(state.sessionFile&&projectActive.get(cwd)===id)persistSession(cwd,state.sessionFile);await queryClient.invalidateQueries({queryKey:['pi','live-stats',id]});return state}
const transcriptCache = new Map<string, Transcript>()
const TRANSCRIPT_CACHE_LIMIT = 3
function rememberTranscript(sessionPath: string | undefined, transcript: Transcript) {
 if (!sessionPath) return
 transcriptCache.delete(sessionPath)
 transcriptCache.set(sessionPath, transcript)
 if (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
  const oldest = transcriptCache.keys().next().value
  if (oldest !== undefined) transcriptCache.delete(oldest)
 }
}
export function cachedTranscript(sessionPath: string): Transcript | undefined { return transcriptCache.get(sessionPath) }
export function forgetCachedTranscript(sessionPath: string) { transcriptCache.delete(sessionPath) }

export async function loadMessages(target=activeTarget()){
 // 几百条消息的会话，get_messages 的响应就是几 MB，会被电脑端切成多帧发过来；
 // 30s 的上限让“会话大”和“链路卡住了”变成同一个结果，所以给它更长的预算。
 const id=route(target)
 loadingConnections.add(id)
 try{
  // get_messages 与 get_state 没有先后依赖，并行发：省掉一整轮往返。
  const [data,state]=await Promise.all([
   request<{messages:PiMessage[]}>({type:'get_messages'},60000,id),
   refresh(id),
  ])
  const transcript=hydrate(data.messages)
  patch(id,{transcript})
  rememberTranscript(state.sessionFile,transcript)
  const currentTranscript=current(id).transcript
  if(state.isStreaming||state.isCompacting){
   const running={...currentTranscript,running:state.isStreaming,compacting:state.isCompacting,phase:state.isCompacting?'正在压缩上下文':'正在运行',active:[...currentTranscript.messages].map((item,index)=>item.message.role==='assistant'?index:-1).findLast(index=>index>=0)??-1}
   patch(id,{transcript:running})
  }
 }catch(error){
  // 骨架屏必须跟着失败一起收起来，否则加载失败后面板就永远停在骨架屏上。
  patch(id,{transcript:transcriptLoading(current(id).transcript,false)})
  throw error
 }finally{
  loadingConnections.delete(id)
 }
}
/** 这条连接的历史消息是否正在加载（供切面时决定要不要收骨架屏）。 */
export function isLoadingConnection(id:string){return loadingConnections.has(id)}
function projectDisconnected(error:unknown){return String(error instanceof Error?error.message:error).includes('项目尚未连接')}

// The connection/session modules are built on these internals; export them so
// the shared state stays owned by one module instead of being copied around.
export {
  SESSION_FILES_KEY,
  LEGACY_SESSION_FILES_KEY,
  REMOTE_CONNECTION_KEY,
  pending,
  snapshots,
  connections,
  projectActive,
  sessionOwners,
  eventQueues,
  flushTimers,
  sessionMetadataPending,
  reconnectingProjects,
  pendingModels,
  projectKey,
  fresh,
  snapshot,
  route,
  activeTarget,
  connectionsFor,
  readSessionFiles,
  persistSession,
  current,
  scanFirstUserTitle,
  sameLiveSessions,
  syncLiveSessions,
  invalidateSessionList,
  ensureSessionMetadata,
  snapshotListeners,
  notifySnapshot,
  patch,
  failPending,
  applyEvent,
  burstEvents,
  BACKGROUND_FLUSH_MS,
  cancelFlush,
  scheduleFlush,
  flushEvents,
  clearEvents,
  dispatch,
  asRemoteCommand,
  sendCommand,
  multiAgentModeCommand,
  computerUseModeCommand,
  browserUseModeCommand,
  syncedModes,
  modesKey,
  syncSessionModes,
  projectDisconnected,
  transcriptCache,
  rememberTranscript,
  loadingConnections,
};
export type { Pending };
