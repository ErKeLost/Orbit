import {findBranchEntry,type BranchEntry} from "./session-branch"
import {emptyTelemetry,observe} from './telemetry'
import {Channel,invoke,isTauri} from '@tauri-apps/api/core'
import {QueryClient} from '@tanstack/react-query'
import type {RpcCommand,RpcResponse} from '@earendil-works/pi-coding-agent'
import {useWorkspace,type LiveSession,type Workspace,type WorkspaceMode} from './store'
import {normalizeProjectPath,projectExtraRoots,useProjects} from './projects'
import {parseAgentSnapshot} from './agents'
import {emptyTranscript,hydrate,reduceEvent,reconnectKeepsTranscript,sameModel,transcriptLoading,withPendingModel,type Event,type PendingModel,type PiMessage,type RpcSessionState,type UiRequest} from './protocol'
import {attachRemoteConnection,remoteHostSnapshot,resolveRemoteConnection,runRemoteHostOperation,sendRemotePiCommand,waitForRemoteConnection} from './remote-runtime'
import {findRemoteConnection,type RemoteConnection,type RemoteJson} from './remote-protocol'
export const queryClient=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false,staleTime:15000,gcTime:120000}}})
export const native=isTauri()
export type ProviderModel={
  id:string
  name?:string
  type?:string
  context_window?:number
  max_output_tokens?:number
  input_modalities?:string[]
  output_modalities?:string[]
  reasoning?:boolean
  thinking_levels?:Record<string,string>
  pricing?:Record<string,number>
  raw?:Record<string,unknown>
}
export type ProviderProfile={id:string;name?:string;baseUrl?:string;modelsUrl?:string;api?:string;authHeader?:boolean;isDefault:boolean;defaultModel?:string;models?:ProviderModel[];hasApiKey:boolean;modelCount:number}
export type Snapshot=Pick<Workspace,'transcript'|'telemetry'|'state'|'connection'|'error'|'draft'|'dialogs'|'notices'|'statuses'|'widgets'|'agents'>
type Pending={project:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}
const SESSION_FILES_KEY='pi-gui.sessionFiles.v1',LEGACY_SESSION_FILES_KEY=['pi-gui','sessionFiles'].join('.')
const pending=new Map<string,Pending>(),snapshots=new Map<string,Snapshot>(),connections=new Map<string,{token:symbol;cwd:string}>(),projectActive=new Map<string,string>(),sessionOwners=new Map<string,string>(),eventQueues=new Map<string,Event[]>(),flushTimers=new Map<string,ReturnType<typeof setTimeout>>()
const sessionMetadataPending=new Set<string>()
const reconnectingProjects=new Map<string,Promise<void>>()
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
function route(target=useWorkspace.getState().cwd){return projectActive.get(target)??target}
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
function sameLiveSessions(a:LiveSession[],b:LiveSession[]){return a.length===b.length&&a.every((item,index)=>item.path===b[index]?.path&&item.cwd===b[index]?.cwd&&item.title===b[index]?.title&&item.running===b[index]?.running)}
function syncLiveSessions(){
 const items:LiveSession[]=[],seen=new Set<string>()
 const ids=new Set([...snapshots.keys(),useWorkspace.getState().connectionId].filter(Boolean))
 for(const id of ids){
  const snap=current(id),path=snap.state?.sessionFile,cwd=connections.get(id)?.cwd??useWorkspace.getState().cwd
  if(!path||seen.has(path))continue
  const running=snap.transcript.running||snap.transcript.compacting
  if(!running&&!snap.transcript.messages.some(item=>item.message.role==='user'))continue
  seen.add(path);items.push({path,cwd,title:firstUserTitle(snap.transcript)||'新会话',running})
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
 const activityChanged=previous.transcript.running!==next.transcript.running||previous.transcript.compacting!==next.transcript.compacting||previous.state?.sessionFile!==next.state?.sessionFile||firstUserTitle(previous.transcript)!==firstUserTitle(next.transcript)
 if(activityChanged)syncLiveSessions()
 if(previous.state?.sessionFile!==next.state?.sessionFile&&next.state?.sessionFile)invalidateSessionList(id)
}
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
function mobileRuntime(){return useWorkspace.getState().runtimeTarget==='mobile'}
export function desktopRuntime(){return useWorkspace.getState().runtimeTarget==='desktop'}
/**
 * Any runtime with a workspace backend.
 *
 * The desktop itself, or a phone whose paired desktop answers (`native.ts`
 * routes the command over the authenticated socket), so a capability no longer
 * depends on which machine the UI happens to be running on. Only the browser
 * preview has nothing behind it.
 */
export function workspaceBackend(){const target=useWorkspace.getState().runtimeTarget;return target==='desktop'||target==='mobile'}
function asRemoteCommand(command:Record<string,unknown>){return command as unknown as Record<string,RemoteJson>}
function sendCommand(project:string,command:Record<string,unknown>){
 return mobileRuntime()?sendRemotePiCommand(project,asRemoteCommand(command)):invoke('pi_send',{project,command})
}
export function request<T=unknown>(command:RpcCommand,timeoutMs=30000,target=useWorkspace.getState().cwd):Promise<T>{
 const id=crypto.randomUUID(),project=route(target)
 return new Promise<T>((resolve,reject)=>{
  const timeout=setTimeout(()=>{pending.delete(id);reject(new Error(`Pi ${command.type} 响应超时`))},timeoutMs)
  pending.set(id,{project,resolve:value=>resolve(value as T),reject,timeout})
  void sendCommand(project,{...command,id}).catch(error=>{clearTimeout(timeout);pending.delete(id);reject(new Error(String(error)))})
 })
}
export function report(error:unknown){useWorkspace.getState().set({error:String(error instanceof Error?error.message:error)})}
/** The desktop's live projects, as a phone names them in a failure it shows. */
function describeConnections(connections:readonly RemoteConnection[]){return connections.length?connections.map(item=>item.cwd).join('、'):'无'}
function asConnection(value:RemoteJson|undefined):RemoteConnection|undefined{
 if(typeof value!=='object'||value===null||Array.isArray(value))return undefined
 const {id,cwd}=value as {id?:unknown;cwd?:unknown}
 return typeof id==='string'&&id&&typeof cwd==='string'&&cwd?{id,cwd}:undefined
}
export function persistedSessionFile(project:string):string {
 const value=readSessionFiles()[project];return typeof value==='string'?value:''
}
const multiAgentModeCommand=(enabled=useWorkspace.getState().multiAgentEnabled)=>({type:'prompt' as const,message:`/gui-agent-mode ${JSON.stringify({enabled})}`})
const computerUseModeCommand=(enabled=useWorkspace.getState().computerUseEnabled)=>({type:'prompt' as const,message:`/gui-computer-use-mode ${JSON.stringify({enabled})}`})
export const syncMultiAgentMode=(target:string,enabled=useWorkspace.getState().multiAgentEnabled)=>request(multiAgentModeCommand(enabled),30000,target)
export const syncComputerUseMode=(target:string,enabled=useWorkspace.getState().computerUseEnabled)=>request(computerUseModeCommand(enabled),30000,target)
// 模式开关记在 Pi 进程内，会话文件和开关值不变时没必要在每次发送前再往返两次。
// key = 会话文件 + 两个开关值；切会话/开关变化/连接关闭时自然失效。
const syncedModes=new Map<string,string>()
const modesKey=(id:string)=>{const s=useWorkspace.getState();return `${current(id).state?.sessionFile??''}|${s.multiAgentEnabled}|${s.computerUseEnabled}`}
const syncSessionModes=async(target:string)=>{
 const id=route(target),key=modesKey(id)
 syncedModes.delete(id)
 await Promise.all([syncMultiAgentMode(target),syncComputerUseMode(target)])
 syncedModes.set(id,key)
}
/** 发送前调用：模式已同步过就直接返回，不再产生 RPC 往返。 */
export async function ensureSessionModes(target=useWorkspace.getState().cwd){
 const id=route(target)
 if(syncedModes.get(id)===modesKey(id))return
 await syncSessionModes(target)
}
/**
 * 发送 prompt，并给 composer 的「等待开始」占位收尾。Pi 的 response 只表示
 * 接受/排队/被扩展处理：``disposition`` 不是 "started" 时这一轮不会自己开，
 * 失败时更是连 response 都没有，两种情况都要撤掉占位，否则会留下一个永远
 * 转圈的「正在思考」。
 */
export async function sendPrompt(command:RpcCommand,target=useWorkspace.getState().cwd,wasRunning=useWorkspace.getState().transcript.running){
 try{
  const result=await request<{disposition?:string}>(command,45000,target)
  if(!wasRunning&&result?.disposition!=='started')useWorkspace.getState().event({type:'prompt_settled'})
  return result
 }catch(error){
  if(!wasRunning)useWorkspace.getState().event({type:'prompt_settled'})
  throw error
 }
}
export const setSessionRoots=(roots:string[],target=useWorkspace.getState().cwd)=>request({type:'prompt',message:`/gui-workspace-set ${JSON.stringify({roots})}`},30000,target)
async function syncConfiguredProjectRoots(cwd:string,target=cwd){const project=useProjects.getState().projects.find(item=>item.path===cwd);if(project)await setSessionRoots(projectExtraRoots(project),target)}
export async function refresh(target=useWorkspace.getState().cwd){
 const id=route(target),state=await request<RpcSessionState>({type:'get_state'},30000,id)
 // Pi 回的就是刚要求的那个模型 → 意图完成，之后全听 `get_state` 的。
 const key=projectKey(id),pending=pendingModels.get(key)
 if(pending&&sameModel(pending,state.model))pendingModels.delete(key)
 patch(id,{state})
 // 轮询缓存同步成刚拿到的真实状态：从设置页切回会话时，MetricsSync 一挂载读到的
 // 就是它，而不是切换之前的旧快照。
 queryClient.setQueryData(['pi','live-state',id],withPendingModel(state,pendingModels.get(key)))
 const cwd=connections.get(id)?.cwd??useWorkspace.getState().cwd;if(state.sessionFile&&projectActive.get(cwd)===id)persistSession(cwd,state.sessionFile);await queryClient.invalidateQueries({queryKey:['pi','live-stats',id]});return state}
export async function listProviderModels(provider:string):Promise<{data:ProviderModel[]}> { if(!workspaceBackend()) throw new Error('模型目录设置请在电脑端修改'); return invoke<{data:ProviderModel[]}>('list_provider_models',{provider}) }
export async function listProjectFiles(project=useWorkspace.getState().cwd):Promise<string[]> { if(mobileRuntime())return runRemoteHostOperation<string[]>({name:'project.files',cwd:project});if(!native)throw new Error('文件索引需要桌面应用');return invoke<string[]>('list_project_files',{cwd:project}) }
export async function listProviderProfiles():Promise<ProviderProfile[]> { if(!workspaceBackend()) throw new Error('Provider 配置请在电脑端修改'); return invoke<ProviderProfile[]>('list_provider_profiles') }
export async function probeProviderModels(provider:string,baseUrl:string,api:string,apiKey?:string,authHeader=true,modelsUrl?:string):Promise<{data:ProviderModel[]}> { if(!workspaceBackend()) throw new Error('模型目录设置请在电脑端修改'); return invoke<{data:ProviderModel[]}>('probe_provider_models',{provider,baseUrl,api,apiKey:apiKey||null,authHeader,modelsUrl:modelsUrl||null}) }
export async function saveProvider(input:{provider:string;name?:string;baseUrl:string;modelsUrl?:string;api:string;apiKey?:string;authHeader:boolean}):Promise<{id:string;hasApiKey:boolean}> { if(!workspaceBackend()) throw new Error('Provider 配置请在电脑端修改'); return invoke<{id:string;hasApiKey:boolean}>('save_provider',{provider:input.provider,name:input.name||null,baseUrl:input.baseUrl,modelsUrl:input.modelsUrl||null,api:input.api,apiKey:input.apiKey||null,authHeader:input.authHeader}) }
export async function deleteProvider(provider:string):Promise<{id:string;deleted:boolean}> { if(!workspaceBackend()) throw new Error('Provider 配置请在电脑端修改'); return invoke<{id:string;deleted:boolean}>('delete_provider',{provider}) }
export async function listSessions(project:string){if(mobileRuntime())return runRemoteHostOperation<import('./protocol').Session[]>({name:'session.list',cwd:project});if(!native)return [];return invoke<import('./protocol').Session[]>('list_sessions',{cwd:project})}
export async function deleteSession(sessionPath:string):Promise<void> { if(mobileRuntime()){await runRemoteHostOperation<null>({name:'session.delete',sessionPath});return}if(!native) throw new Error('删除会话需要桌面应用'); return invoke<void>('delete_session',{sessionPath}) }
export async function clearSessionHistory():Promise<number> {
 if(!workspaceBackend()) throw new Error('清空会话历史请在电脑端执行')
 const workspace=useWorkspace.getState(),cwd=workspace.cwd,workspaceMode=workspace.workspaceMode
 await Promise.all([...connections.keys()].map(id=>closeConnection(id,'会话历史已清空')))
 projectActive.clear();snapshots.clear();sessionOwners.clear();syncLiveSessions()
 const result=await invoke<{removed?:number}>('clear_sessions')
 queryClient.removeQueries({predicate:query=>query.queryKey[0]==='pi'&&query.queryKey[1]==='sessions'})
 useWorkspace.getState().set({...fresh(),cwd,connectionId:'',workspaceMode})
 return typeof result?.removed==='number'?result.removed:0
}
export async function retireSession(sessionPath:string){
 const cwd=useWorkspace.getState().cwd,owner=sessionOwners.get(sessionPath),wasActive=owner?useWorkspace.getState().connectionId===owner:useWorkspace.getState().state?.sessionFile===sessionPath
 if(mobileRuntime()&&wasActive){await changeSession({type:'new_session'});await deleteSession(sessionPath);sessionOwners.delete(sessionPath);await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]});return}
 if(owner&&connections.has(owner))await closeConnection(owner,'会话已关闭')
 await deleteSession(sessionPath);sessionOwners.delete(sessionPath)
 if(!wasActive)return
 const remaining=connectionsFor(cwd)[0]
 if(remaining){activateConnection(remaining,cwd);return}
 useWorkspace.getState().set({...fresh(),cwd,connectionId:cwd,panel:'chat'})
 await startConnection(cwd,cwd)
}
export async function getSessionTurnDurations(sessionPath:string):Promise<Record<string,number>> { if(mobileRuntime())return runRemoteHostOperation<Record<string,number>>({name:'session.turnDurations',sessionPath});if(!native) return {}; return invoke<Record<string,number>>('session_turn_durations',{sessionPath}) }
export async function syncProviderModels(provider:string):Promise<{provider:string;count:number;previous:number;firstModelId?:string}> { if(!workspaceBackend()) throw new Error('同步模型请在电脑端执行'); return invoke<{provider:string;count:number;previous:number;firstModelId?:string}>('sync_provider_models',{provider}) }
export async function persistDefaultModel(provider:string,modelId:string):Promise<{provider:string;id:string}> { if(!workspaceBackend()) throw new Error('默认模型请在电脑端设置'); return invoke<{provider:string;id:string}>('set_default_model',{provider,modelId}) }
export type ProjectTrustMode = 'ask' | 'always' | 'never'
export async function getProjectTrustMode():Promise<ProjectTrustMode> { if(!workspaceBackend()) throw new Error('项目权限请在电脑端设置'); return invoke<ProjectTrustMode>('get_project_trust_mode') }
// --- MCP servers (Pi 1.0) -------------------------------------------------
// Pi reads `~/.pi/agent/mcp.json`; the GUI edits that file through Rust and
// reads live connection state through the `gui-mcp` capability status.
export type McpServerView={name:string;transport:'stdio'|'http'|'invalid';command:string|null;args:string[];url:string|null;envKeys:string[];headerKeys:string[];enabled:boolean;exposure:string|null;description:string|null;timeout:number|null}
export type McpServerList={path:string;servers:McpServerView[];authenticated:string[]}
export async function listMcpServers():Promise<McpServerList> { if(!workspaceBackend()) throw new Error('MCP 服务器请在电脑端管理'); return invoke<McpServerList>('list_mcp_servers') }
export async function saveMcpServer(name:string,config:Record<string,unknown>):Promise<McpServerView> { if(!workspaceBackend()) throw new Error('MCP 服务器请在电脑端管理'); return invoke<McpServerView>('save_mcp_server',{name,config}) }
export async function deleteMcpServer(name:string):Promise<{name:string;deleted:boolean}> { if(!workspaceBackend()) throw new Error('MCP 服务器请在电脑端管理'); return invoke<{name:string;deleted:boolean}>('delete_mcp_server',{name}) }
export async function mcpConfigLocation():Promise<{path:string;authPath:string;logPath:string}> { if(!workspaceBackend()) throw new Error('MCP 配置路径需要电脑端'); return invoke<{path:string;authPath:string;logPath:string}>('mcp_config_location') }
/** Pi 1.0 settings Orbit can write: `cacheWarming` and `codemode`. */
export type GuiSettings={path:string;settings:{cacheWarming:string|null;codemode:{mode?:'on'|'only';inlineBudget?:number}|null}}
export async function getGuiSettings():Promise<GuiSettings> { if(!workspaceBackend()) throw new Error('Pi 设置请在电脑端修改'); return invoke<GuiSettings>('get_gui_settings') }
export async function setGuiSetting(key:'cacheWarming'|'codemode',value:unknown):Promise<{key:string;value:unknown}> { if(!workspaceBackend()) throw new Error('Pi 设置请在电脑端修改'); return invoke<{key:string;value:unknown}>('set_gui_setting',{key,value}) }
/** Ask the GUI extension to recompute and republish its capability snapshots. */
export async function refreshCapabilities(target=useWorkspace.getState().cwd){await request({type:'prompt',message:'/gui-capabilities'},30000,target)}
/** Session-scoped MCP registration through the built-in MCP extension. */
export async function registerSessionMcpServer(name:string,config:Record<string,unknown>,target=useWorkspace.getState().cwd){return request({type:'prompt',message:`/gui-mcp ${JSON.stringify({action:'add',name,config})}`},30000,target)}
export async function unregisterSessionMcpServer(name:string,target=useWorkspace.getState().cwd){return request({type:'prompt',message:`/gui-mcp ${JSON.stringify({action:'remove',name})}`},30000,target)}
export async function setProjectTrustMode(mode:ProjectTrustMode):Promise<ProjectTrustMode> { if(!workspaceBackend()) throw new Error('项目权限请在电脑端设置'); return invoke<ProjectTrustMode>('set_project_trust_mode',{mode}) }
export async function computerUseKeyStatus():Promise<{hasKey:boolean}> { if(!workspaceBackend()) throw new Error('Jev Key 请在电脑端设置'); return invoke<{hasKey:boolean}>('computer_use_key_status') }
export async function saveComputerUseKey(apiKey?:string):Promise<{hasKey:boolean}> { if(!workspaceBackend()) throw new Error('Jev Key 请在电脑端设置'); return invoke<{hasKey:boolean}>('save_computer_use_key',{apiKey:apiKey?.trim()||null}) }
export type ComputerUseModel='jev'|'clef-flash'
export type ComputerUseConfig={decisionModel:ComputerUseModel;cloudflareAccountId:string;systemoneBaseUrl:string;keys:{jev:boolean;cloudflare:boolean}}
export type ComputerUseTestResult={ok:boolean;provider:string;model:string;latencyMs:number;answer:Record<string,unknown>|null;usage:{input_tokens?:number;output_tokens?:number}|null}
export async function computerUseConfig():Promise<ComputerUseConfig> { if(!workspaceBackend()) throw new Error('电脑操作请在电脑端设置'); return invoke<ComputerUseConfig>('computer_use_config') }
export async function saveComputerUseConfig(patch:Partial<Pick<ComputerUseConfig,'decisionModel'|'cloudflareAccountId'|'systemoneBaseUrl'>>):Promise<ComputerUseConfig> { if(!workspaceBackend()) throw new Error('电脑操作请在电脑端设置'); return invoke<ComputerUseConfig>('save_computer_use_config',{config:patch}) }
export async function saveComputerUseCloudflareToken(token?:string):Promise<{hasToken:boolean}> { if(!workspaceBackend()) throw new Error('Cloudflare Token 请在电脑端设置'); return invoke<{hasToken:boolean}>('save_computer_use_cloudflare_token',{token:token?.trim()||null}) }
export async function testComputerUseDecision():Promise<ComputerUseTestResult> { if(!workspaceBackend()) throw new Error('电脑操作请在电脑端设置'); return invoke<ComputerUseTestResult>('test_computer_use_decision') }
/**
 * The image-generation endpoint, as the extension resolves it.
 *
 * Pi's own provider config cannot describe an image model — its model schema has
 * no `type` discriminant — so this file is where the endpoint, its models and its
 * size presets live, and `gui-extension.ts` merges it over the built-in Ark
 * defaults. Every key other than the derived ones is optional, and an absent key
 * means "use the built-in", which is why an unconfigured install still works.
 */
/**
 * One capability's parameter. `from` 说的是值从哪来：`sizes` 取该模型自己的尺寸表，
 * `catalog` 取该 kind 的模型列表。没有 `from` 就是一个字面量枚举或数值。
 */
export type ImageConfigParam = {
  from?: "sizes" | "catalog"
  type?: "string" | "integer" | "number" | "boolean"
  enum?: string[]
  min?: number
  max?: number
  default?: unknown
  description?: string
}

/**
 * 一种生成能力。`recipe` 说的是**这次调用怎么发**，不是生成什么：`sync` 直接回字节，
 * `async-task` 起任务再轮询。`enabled` 缺省为开 —— 关掉的能力不注册工具。
 */
export type ImageConfigKind = {
  label?: string
  enabled?: boolean
  recipe?: string
  output?: { ext?: string; dir?: string }
  params?: Record<string, ImageConfigParam>
}

export type ImageConfig = {
  provider?: { id: string; name?: string; baseUrl?: string }
  models?: { id: string; name?: string; sizes?: Record<string, Record<string, string>>; params?: Record<string, ImageConfigParam>; taskTypes?: string[]; status?: string }[]
  sizes?: Record<string, Record<string, string>>
  defaults?: { model?: string; resolution?: string; aspect?: string }
  /** 能力表。缺省时扩展退回内置的一条 `image`。 */
  kinds?: Record<string, ImageConfigKind>
  /** Whether the file says anything at all. */
  configured: boolean
  /** Whether Pi can resolve a key for the configured (or built-in) provider. */
  hasApiKey: boolean
  /** The provider used when the file names none. */
  defaultProviderId: string
}
/**
 * A patch, not a replacement: an absent key keeps what is stored and `null`
 * clears it, so changing the default model cannot delete the endpoint beside it.
 */
export type ImageConfigPatch = {
  provider?: ImageConfig["provider"] | null
  models?: ImageConfig["models"] | null
  sizes?: ImageConfig["sizes"] | null
  defaults?: ImageConfig["defaults"] | null
  kinds?: ImageConfig["kinds"] | null
  /** The flat single-default form the settings page sends. */
  model?: string
  resolution?: string
  aspect?: string
}
export async function imageConfig():Promise<ImageConfig> { if(!workspaceBackend()) throw new Error('图片模型请在电脑端设置'); return invoke<ImageConfig>('image_config') }
export async function saveImageConfig(patch:ImageConfigPatch):Promise<ImageConfig> { if(!workspaceBackend()) throw new Error('图片模型请在电脑端设置'); return invoke<ImageConfig>('save_image_config',{config:patch}) }
/** The key goes to Pi's auth.json under the provider id, like every other key. */
export async function saveImageApiKey(provider:string,apiKey:string|null):Promise<{provider:string;hasApiKey:boolean}> { if(!workspaceBackend()) throw new Error('图片密钥请在电脑端设置'); return invoke('save_image_api_key',{provider,apiKey}) }
export async function loadMessages(target=useWorkspace.getState().cwd){
 // 几百条消息的会话，get_messages 的响应就是几 MB，会被电脑端切成多帧发过来；
 // 30s 的上限让“会话大”和“链路卡住了”变成同一个结果，所以给它更长的预算。
 const id=route(target)
 try{
  const data=await request<{messages:PiMessage[]}>({type:'get_messages'},60000,id)
  patch(id,{transcript:hydrate(data.messages)})
  const state=await refresh(id),currentTranscript=current(id).transcript
  if(state.isStreaming||state.isCompacting){
   const transcript={...currentTranscript,running:state.isStreaming,compacting:state.isCompacting,phase:state.isCompacting?'正在压缩上下文':'正在运行',active:[...currentTranscript.messages].map((item,index)=>item.message.role==='assistant'?index:-1).findLast(index=>index>=0)??-1}
   patch(id,{transcript})
  }
 }catch(error){
  // 骨架屏必须跟着失败一起收起来，否则加载失败后面板就永远停在骨架屏上。
  patch(id,{transcript:transcriptLoading(current(id).transcript,false)})
  throw error
 }
}
async function closeConnection(id:string,message='连接已关闭'){
 const cwd=connections.get(id)?.cwd,s=current(id)
 if(s.transcript.running){try{await request({type:'clear_queue'},30000,id);await request({type:'abort'},60000,id)}catch{/* process may already be gone */}}
 clearEvents(id);syncedModes.delete(id);connections.delete(id);failPending(id,message);snapshots.delete(id)
 if(cwd&&projectActive.get(cwd)===id)projectActive.delete(cwd)
 for(const [file,owner] of [...sessionOwners]) if(owner===id) sessionOwners.delete(file)
 if(mobileRuntime()){if(useWorkspace.getState().connectionId===id){useWorkspace.getState().set({connection:'offline',connectionId:''})};syncLiveSessions();return}
 await invoke('pi_disconnect',{project:id}).catch(()=>{});syncLiveSessions()
}
function activateConnection(id:string,cwd:string){
 const previous=useWorkspace.getState()
 if(previous.connectionId&&previous.connectionId!==id)snapshots.set(previous.connectionId,snapshot())
 projectActive.set(cwd,id)
 const saved=snapshots.get(id)??fresh()
 // 快照里可能留着上一条连接没跑完的 loading，切过去不会再有 hydrate 来收它，先收起来。
 useWorkspace.getState().set({...saved,cwd,connectionId:id,panel:'chat',transcript:transcriptLoading(saved.transcript,false)})
 persistSession(cwd,saved.state?.sessionFile);syncLiveSessions()
 if(saved.connection==='online')void Promise.all([refresh(id),syncSessionModes(id)]).catch(error=>patch(id,{error:String(error)}))
}
async function startConnection(cwd:string,id:string,options?:{restoreLast?:boolean;sessionPath?:string;keepTranscript?:boolean}){
 const token=Symbol(id);connections.set(id,{token,cwd});projectActive.set(cwd,id)
 // `keepTranscript` is a recovery of the session already on screen: it goes
 // through the same attach and rehydrate, but does not blank what the user is
 // looking at while it does. See `reconnectKeepsTranscript`.
 patch(id,{connection:'connecting',error:null,transcript:transcriptLoading(current(id).transcript,options?.keepTranscript!==true)})
 if(mobileRuntime()){
  try{
   await attachRemoteConnection(id)
   const state=await request<RpcSessionState>({type:'get_state'},45000,id)
   patch(id,{state})
   patch(id,{connection:'online'})
   // The transcript is the heaviest thing a connection carries, and failing to
   // fetch it must not take the connection down with it: the worker is attached
   // and still takes prompts, and re-entering the session retries the history.
   // Treating it as a failed connect is what turned one big `get_messages` into
   // 「连接失败」 and every later tap on the connection doing nothing.
   await loadMessages(id).catch(error=>patch(id,{error:String(error)}))
  }catch(error){connections.delete(id);projectActive.delete(cwd);failPending(id,'连接失败');patch(id,{connection:'offline'});throw error}
  return
 }
 const onEvent=new Channel<{kind:string;payload?:Event;payloads?:Event[];message?:string;code?:number}>()
 onEvent.onmessage=event=>{
  if(connections.get(id)?.token!==token)return
  if(event.kind==='rpc'&&event.payload)dispatch(event.payload,id)
  // Rust 侧把连发的 message_update / tool_execution_update 攒成一批（bridge.rs 的
  // PI_EVENT_BATCH_*）。逐条 dispatch，顺序与逐条 IPC 完全一致，dispatch 内部
  // 仍按帧（可见连接）/ 100ms（后台连接）合并 store 提交。
  if(event.kind==='rpc-batch'&&event.payloads){for(const payload of event.payloads)dispatch(payload,id)}
  if(event.kind==='exit'){const cwd=connections.get(id)?.cwd,s=current(id),detail=event.message?`：${event.message}`:'';flushEvents(id);clearEvents(id);syncedModes.delete(id);connections.delete(id);if(cwd&&projectActive.get(cwd)===id)projectActive.delete(cwd);for(const [file,owner] of [...sessionOwners]) if(owner===id) sessionOwners.delete(file);patch(id,{connection:'offline',error:`Pi 进程已退出（${event.code??'signal'}）${detail}`,transcript:{...s.transcript,running:false,submitted:false,compacting:false,phase:'就绪',turnStartedAt:null}});failPending(id,'Pi 进程已退出')}
  if(event.kind==='protocol_error')patch(id,{error:event.message})
 }
 try{
  await invoke('pi_connect',{cwd,onEvent,connectionId:id})
  const state=await request<RpcSessionState>({type:'get_state'},45000,id)
  if(connections.get(id)?.token!==token)return
  patch(id,{state})
  await syncSessionModes(id).catch(()=>{})
  if(options?.sessionPath){try{await request({type:'switch_session',sessionPath:options.sessionPath},45000,id)}catch{patch(id,{notices:['会话无法读取，已打开新会话']})}}
  else if(options?.restoreLast){const previousFile=persistedSessionFile(cwd)||undefined;if(previousFile&&previousFile!==state.sessionFile){try{await request({type:'switch_session',sessionPath:previousFile},45000,id)}catch{patch(id,{notices:['上次会话无法读取，已打开新会话']})}}}
  await loadMessages(id)
  if(connections.get(id)?.token!==token)return
  patch(id,{connection:'online'})
 }catch(error){
  if(connections.get(id)?.token!==token)return
  connections.delete(id);if(projectActive.get(cwd)===id)projectActive.delete(cwd);failPending(id,'连接失败');await invoke('pi_disconnect',{project:id}).catch(()=>{});patch(id,{connection:'offline',transcript:transcriptLoading(current(id).transcript,false)});throw error
 }
}
export async function connectRemoteConnection(connection:{id:string;cwd:string},workspaceMode:WorkspaceMode='project',options?:{recovery?:boolean}){
 if(!mobileRuntime())throw new Error('远程 connection 只能在移动端使用')
 const previous=useWorkspace.getState();if(previous.connectionId&&previous.connectionId!==connection.id)snapshots.set(previous.connectionId,snapshot())
 projectActive.set(connection.cwd,connection.id)
 const saved=snapshots.get(connection.id)??fresh()
 const keep=reconnectKeepsTranscript({recovery:options?.recovery===true,sameConnection:previous.connectionId===connection.id,hasMessages:saved.transcript.messages.length>0})
 // 快照里可能留着上一条连接没跑完的 loading；这里永远先把它收起来，要不要重新上
 // 骨架屏由 startConnection 按 keep 决定。
 useWorkspace.getState().set({...saved,runtimeTarget:'mobile',cwd:connection.cwd,workspaceMode,connectionId:connection.id,transcript:transcriptLoading(saved.transcript,false)})
 localStorage.setItem('pi-gui.cwd',connection.cwd)
 localStorage.setItem('pi-gui.workspaceMode',workspaceMode)
 localStorage.setItem(REMOTE_CONNECTION_KEY,connection.id)
 // A cached online snapshot does not prove that the current WebSocket is
 // attached to this project. Always attach and rehydrate after switching or
 // reconnecting so events cannot keep flowing from a previously selected id.
 await startConnection(connection.cwd,connection.id,{keepTranscript:keep})
}
export async function setMultiAgentMode(enabled:boolean){
 const previous=useWorkspace.getState().multiAgentEnabled
 useWorkspace.getState().set({multiAgentEnabled:enabled});localStorage.setItem('pi-gui.multiAgentEnabled',String(enabled))
 if(useWorkspace.getState().connection!=='online')return
 try{await request(multiAgentModeCommand(enabled),30000)}
 catch(error){useWorkspace.getState().set({multiAgentEnabled:previous});localStorage.setItem('pi-gui.multiAgentEnabled',String(previous));throw error}
}
export async function setComputerUseMode(enabled:boolean){
 const previous=useWorkspace.getState().computerUseEnabled
 useWorkspace.getState().set({computerUseEnabled:enabled});localStorage.setItem('pi-gui.computerUseEnabled',String(enabled))
 if(useWorkspace.getState().connection!=='online')return
 try{await request(computerUseModeCommand(enabled),30000)}
 catch(error){useWorkspace.getState().set({computerUseEnabled:previous});localStorage.setItem('pi-gui.computerUseEnabled',String(previous));throw error}
}
export async function connect(cwd:string,workspaceMode:WorkspaceMode=useWorkspace.getState().workspaceMode){
 if(!native&&!mobileRuntime())throw new Error('请在桌面应用中选择项目')
 if(mobileRuntime()){
  const snapshot=await remoteHostSnapshot()
  if(snapshot.theme||snapshot.machineName)useWorkspace.getState().set({...snapshot.theme?{remoteTheme:snapshot.theme}:{},...snapshot.machineName?{remoteMachineName:snapshot.machineName}:{}})
  let connection=findRemoteConnection(snapshot.connections,cwd)
  if(!connection){
   // A snapshot only carries the strings the desktop published, so it cannot
   // resolve a spelling difference. The desktop owns path identity — a project
   // may be registered as `/tmp/demo` while its Pi worker reports the canonical
   // `/private/tmp/demo` — so ask the Host before deciding it is not open. A
   // Host too old to answer leaves this undefined and the open below still runs.
   connection=await resolveRemoteConnection(cwd)
  }
  if(!connection){
   // The rail renders the desktop's whole registry, but only a project with a
   // live Pi connection can be attached to. Tapping a listed-but-closed project
   // used to dead-end; ask the desktop to open it (the same thing selecting it
   // there does). An answer that already carries a connection means it was open
   // all along, which skips the wait entirely.
   let opened:RemoteConnection|undefined
   try{opened=asConnection(await runRemoteHostOperation({name:'project.open',path:cwd}))}
   catch(error){throw new Error(`电脑端无法打开这个项目：${error instanceof Error?error.message:error}`)}
   connection=opened??await waitForRemoteConnection(cwd)
  }
  if(!connection)throw new Error(`电脑端没有这个项目的活动连接：${cwd}（电脑端当前连接：${describeConnections(snapshot.connections)}）`)
  await connectRemoteConnection(connection,workspaceMode)
  if(workspaceMode==='project')await syncConfiguredProjectRoots(cwd)
  return
 }
 cwd=normalizeProjectPath(cwd)
 const previous=useWorkspace.getState();if(previous.connectionId)snapshots.set(previous.connectionId,snapshot())
 const id=projectActive.get(cwd)??cwd
 const saved=snapshots.get(id)??fresh();useWorkspace.getState().set({...saved,cwd,workspaceMode,connectionId:id})
 localStorage.setItem('pi-gui.cwd',cwd)
 localStorage.setItem('pi-gui.workspaceMode',workspaceMode)
 if(connections.has(id)&&saved.connection==='online'){
  try{await Promise.all([refresh(id),syncSessionModes(id)]);if(workspaceMode==='project')await syncConfiguredProjectRoots(cwd,id);return}
  catch{await closeConnection(id,'项目连接已失效')}
 }
 await startConnection(cwd,id,{restoreLast:true})
 if(workspaceMode==='project')await syncConfiguredProjectRoots(cwd,id)
}
function projectDisconnected(error:unknown){return String(error instanceof Error?error.message:error).includes('项目尚未连接')}
export async function requestWithRecovery<T=unknown>(command:RpcCommand,timeoutMs=30000,target=useWorkspace.getState().cwd):Promise<T>{
 try{return await request<T>(command,timeoutMs,target)}catch(error){
  const workspace=useWorkspace.getState()
  if(!projectDisconnected(error)||mobileRuntime()||workspace.connectionId!==target||!workspace.cwd)throw error
  const cwd=workspace.cwd
  let task=reconnectingProjects.get(cwd)
  if(!task){
   task=connect(cwd,workspace.workspaceMode).finally(()=>reconnectingProjects.delete(cwd))
   reconnectingProjects.set(cwd,task)
  }
  await task
  return request<T>(command,timeoutMs,target)
 }
}
export async function disconnect(){const cwd=useWorkspace.getState().cwd;await Promise.all(connectionsFor(cwd).map(id=>closeConnection(id,'项目已断开')));projectActive.delete(cwd);useWorkspace.getState().set({...fresh(),cwd,connectionId:'',workspaceMode:useWorkspace.getState().workspaceMode})}
export async function forgetProject(project:string){
 await Promise.all(connectionsFor(project).map(id=>closeConnection(id,'项目已移除')))
 projectActive.delete(project)
 queryClient.removeQueries({predicate:query=>query.queryKey.includes(project)})
 const files=readSessionFiles();delete files[project];localStorage.setItem(SESSION_FILES_KEY,JSON.stringify(files))
 if(useWorkspace.getState().cwd===project)useWorkspace.getState().set({...fresh(),cwd:'',connectionId:''})
}
/** Pull every queued message back into the draft without stopping the turn. */
export async function recallQueue(target=useWorkspace.getState().cwd){const id=route(target),cleared=await request<{steering:string[];followUp:string[]}>({type:'clear_queue'},30000,id);const s=current(id);patch(id,{draft:[s.draft,...cleared.steering,...cleared.followUp].filter(Boolean).join('\n'),transcript:reduceEvent(s.transcript,{type:'queued_preview_clear'})})}
/** Promote one queued follow-up into the running turn as a steer (Orbit's "Steer"). */
export async function steerFollowUp(text:string,target=useWorkspace.getState().cwd){
 const id=route(target),cleared=await request<{steering:string[];followUp:string[]}>({type:'clear_queue'},30000,id)
 let promoted=false
 for(const message of cleared.steering)await request({type:'steer',message},30000,id)
 for(const message of cleared.followUp){
  if(!promoted&&message===text){promoted=true;await request({type:'steer',message},30000,id)}
  else await request({type:'follow_up',message},30000,id)
 }
}
/**
 * Pause: cut the turn that is running, keep the queued steering messages going.
 *
 * Pi's `abort` does not touch either queue, but the texts of a pending queue can
 * only be read by `clear_queue` (there is no read-only queue command), so the
 * order is: harvest the queue, abort, then replay — the first message as a plain
 * prompt to start the next turn, the rest as `steer` so they land in the same
 * turn. The agent loop polls the steering queue when the run starts (agent-loop
 * "Check for steering messages at start"), so they keep moving up into the
 * conversation instead of being dumped back into the draft.
 *
 * `steer` is used for the tail rather than `prompt` with a streaming behavior:
 * it is accepted whether or not the new turn has started streaming yet, so the
 * replay can never trip "Agent is already processing".
 *
 * Follow-ups are not replayed — they return to the draft so that stop still
 * means something actually stops.
 */
export async function stop(target=useWorkspace.getState().cwd){
 const id=route(target)
 const cleared=await request<{steering:string[];followUp:string[]}>({type:'clear_queue'},30000,id)
 await request({type:'abort'},60000,id)
 patch(id,{transcript:reduceEvent(current(id).transcript,{type:'queued_preview_clear'})})
 const steering=cleared.steering.filter(text=>text.trim())
 const returned:string[]=[]
 if(steering.length){
  let delivered=0
  try{
   await sendPrompt({type:'prompt',message:steering[0]},id,false);delivered=1
   for(const message of steering.slice(1)){await request({type:'steer',message},30000,id);delivered+=1}
  }
  // 只把没投出去的部分退回草稿：成功了再退会变成重复消息。
  catch(error){returned.push(...steering.slice(delivered));report(error)}
 }
 const draft=[...returned,...cleared.followUp].filter(text=>text.trim())
 if(draft.length){const s=current(id);patch(id,{draft:[s.draft,...draft].filter(Boolean).join('\n')})}
 await refresh(id)
}
export async function changeSession(command:RpcCommand){
 try {
  return await changeSessionOnce(command)
 } catch (error) {
  // A stale worker after a restart or project switch: reconnect and retry once.
  const workspace=useWorkspace.getState()
  if (!projectDisconnected(error) || mobileRuntime() || !workspace.cwd) throw error
  const cwd=workspace.cwd
  let task=reconnectingProjects.get(cwd)
  if(!task){
   task=connect(cwd,workspace.workspaceMode).finally(()=>reconnectingProjects.delete(cwd))
   reconnectingProjects.set(cwd,task)
  }
  await task
  return changeSessionOnce(command)
 }
}
/** 这些命令会换掉整个 transcript，切换期间用骨架屏顶替旧内容。 */
const SESSION_SWITCH_COMMANDS=new Set(['switch_session','new_session','clone','fork'])
/** 骨架屏置位：只在这条连接确实要跑一次 loadMessages 时才调，否则没人会把它收回来。 */
const markSessionLoading=(id:string)=>patch(id,{transcript:transcriptLoading(current(id).transcript,true)})
/**
 * 换掉整份 transcript：先上骨架屏再 loadMessages。会话树切分支这种『不换 session
 * 但内容整体换掉』的入口走这里，loadMessages 自己会（成功或失败）把骨架屏收起来。
 */
export async function reloadMessages(target=useWorkspace.getState().cwd){const id=route(target);markSessionLoading(id);return loadMessages(id)}
async function changeSessionOnce(command:RpcCommand){
 const cwd=useWorkspace.getState().cwd,active=route(cwd),running=current(active).transcript.running
 if(command.type==='switch_session'){
  if(useWorkspace.getState().state?.sessionFile===command.sessionPath){useWorkspace.getState().set({panel:'chat'});return}
  const owner=sessionOwners.get(command.sessionPath)
  // 这个会话的遥接已经活着（快照里有消息），切过去是瞬时的，不上骨架屏。
  if(owner&&connections.has(owner)){activateConnection(owner,cwd);await syncConfiguredProjectRoots(cwd,owner);await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]});return}
 }
 const switching=SESSION_SWITCH_COMMANDS.has(String(command.type))
 // 正在跑的那一轮会切到一条新连接上（旧连接留在快照里继续跑），加载发生在
 // 新连接上，所以这时不能在 active 上置位：没人会去收回它。
 const swapsConnection=(command.type==='new_session'||command.type==='switch_session')&&running&&!mobileRuntime()
 if(switching&&!swapsConnection)markSessionLoading(active)
 try{
  if(mobileRuntime()){
   const result=await request<{cancelled?:boolean;text?:string}>(command,60000,active)
   if(result?.cancelled)throw new Error('扩展取消了会话切换')
   patch(active,{error:null,telemetry:emptyTelemetry(),draft:result?.text??'',dialogs:[],statuses:{},widgets:{},agents:null})
   if(useWorkspace.getState().connectionId===active)useWorkspace.getState().set({panel:'chat'})
   await loadMessages(active)
   if(useWorkspace.getState().workspaceMode==='project')await syncConfiguredProjectRoots(cwd,active)
   await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]})
   return
  }
  if((command.type==='new_session'||command.type==='switch_session')&&running){
   const id=`${cwd}#${crypto.randomUUID()}`
   snapshots.set(active,snapshot())
   useWorkspace.getState().set({...fresh(),cwd,connectionId:id,panel:'chat'})
   await startConnection(cwd,id,command.type==='switch_session'?{sessionPath:command.sessionPath}:undefined)
   if(useWorkspace.getState().workspaceMode==='project')await syncConfiguredProjectRoots(cwd,id)
   await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]});return
  }
  const result=await request<{cancelled?:boolean;text?:string}>(command,60000,active);if(result?.cancelled)throw new Error('扩展取消了会话切换');patch(active,{error:null,telemetry:emptyTelemetry(),draft:result?.text??'',dialogs:[],statuses:{},widgets:{},agents:null});if(useWorkspace.getState().connectionId===active)useWorkspace.getState().set({panel:'chat'});await loadMessages(active);if(useWorkspace.getState().workspaceMode==='project')await syncConfiguredProjectRoots(cwd,active);await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]})
 }
 catch(error){
  // 取消/失败时手动收起骨架屏：这条路径不会走到 loadMessages 的 hydrate。
  for(const id of new Set([active,useWorkspace.getState().connectionId]))patch(id,{transcript:transcriptLoading(current(id).transcript,false)})
  throw error
 }
}
const branchingConnections = new Set<string>()
export async function branchFromMessage(message: PiMessage) {
 const workspace=useWorkspace.getState(),cwd=workspace.cwd,id=route(cwd)
 if(workspace.connection!=='online'||current(id).transcript.running||current(id).transcript.compacting)throw new Error('请等待当前回复结束后再分支')
 if(branchingConnections.has(id))throw new Error('正在创建分支，请稍候')
 branchingConnections.add(id)
 const sourceFile=current(id).state?.sessionFile
 let cloned=false
 try {
  const entries=await request<{entries:BranchEntry[];leafId:string|null}>({type:'get_entries'},30000,id)
  const entryId=findBranchEntry(entries.entries,entries.leafId,message)
  if(current(id).state?.sessionFile!==sourceFile||current(id).transcript.running)throw new Error('当前会话已变化，请重试')
  const result=await request<{cancelled?:boolean}>({type:'clone'},60000,id)
  if(result.cancelled)throw new Error('扩展取消了创建分支')
  cloned=true
  // Navigate only in the clone so the original conversation keeps its current leaf.
  await request({type:'prompt',message:`/gui-tree ${JSON.stringify({id:entryId,summarize:false})}`},60000,id)
  const branch=await request<{leafId:string|null}>({type:'get_entries'},30000,id)
  if(branch.leafId!==entryId)throw new Error('未能定位到所选回复，已创建的副本可在会话列表中查看')
  patch(id,{error:null,telemetry:emptyTelemetry(),draft:'',dialogs:[],statuses:{},widgets:{},agents:null})
  if(useWorkspace.getState().connectionId===id)useWorkspace.getState().set({panel:'chat'})
 } catch(error) {
  if(cloned&&sourceFile) {
   const restored=await request<{cancelled?:boolean}>({type:'switch_session',sessionPath:sourceFile},60000,id)
   if(restored.cancelled)throw new Error('分支操作失败，且扩展取消了返回原会话；请从侧栏选择原会话')
  }
  throw error
 } finally {
  try {
   if(cloned)await loadMessages(id)
   await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]})
   await queryClient.invalidateQueries({queryKey:['pi','tree',cwd]})
  } finally { branchingConnections.delete(id) }
 }
}
export async function answerDialog(request:UiRequest,answer:{value?:string;confirmed?:boolean;cancelled?:boolean},target?:string){const id=(target&&connections.has(target)?target:useWorkspace.getState().connectionId)||route();await sendCommand(id,{type:'extension_ui_response',id:request.id,...answer});patch(id,{dialogs:current(id).dialogs.filter(item=>item.id!==request.id)})}

/* ------------------------------------------------------------------ *
 * Workspace tabs (Orbit `workspaceTabGroups`): each workspace owns one
 * pi RPC process and its own pane tree. These wrappers keep the connection
 * table private to this module.
 * ------------------------------------------------------------------ */
export function hasWorkspaceConnection(id: string) { return Boolean(id) && connections.has(id) }
export function workspaceConnectionIds() { return [...connections.keys()] }
/** Start a workspace's pi process without stealing the project's route. */
export async function openWorkspaceConnection(cwd: string, id: string, options?: { sessionPath?: string; restoreLast?: boolean }) {
 await startConnection(cwd, id, options)
}
/** Make an existing connection the active projection again. */
export function focusWorkspaceConnection(id: string, cwd: string) {
 if (!id) return
 if (connections.has(id)) { activateConnection(id, cwd); return }
 projectActive.set(cwd, id)
}
/** Keep a background workspace's process from owning the project route. */
export function restoreProjectRoute(cwd: string, id: string) { if (connections.has(id)) projectActive.set(cwd, id) }
export async function closeWorkspaceConnection(id: string, message = '工作区已关闭') {
 if (id && connections.has(id)) await closeConnection(id, message)
}

/* ------------------------------------------------------------------ *
 * Session panes: a pane can show any connection, not just the projected one.
 * `snapshots` already holds a full projection per connection; these expose it.
 * ------------------------------------------------------------------ */
export function subscribeSnapshot(id: string, listener: () => void) {
 if (!id) return () => {}
 let set = snapshotListeners.get(id)
 if (!set) { set = new Set(); snapshotListeners.set(id, set) }
 set.add(listener)
 return () => { const current = snapshotListeners.get(id); if (!current) return; current.delete(listener); if (current.size === 0) snapshotListeners.delete(id) }
}
export function connectionSnapshot(id: string): Snapshot | null { return id ? snapshots.get(id) ?? null : null }
export function connectionCwd(id: string): string | null { return connections.get(id)?.cwd ?? null }
/** Writes from a pane that is showing a background connection. */
export function patchConnectionSnapshot(id: string, value: Partial<Snapshot>) { if (id) patch(id, value) }
export function primeConnectionSnapshot(id: string) { if (id && !snapshots.has(id)) snapshots.set(id, fresh()) }
