import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./native";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { useWorkspace, type WorkspaceMode } from "./store";
import { normalizeProjectPath } from "./projects";
import { reconnectKeepsTranscript, transcriptLoading, type Event, type RpcSessionState } from "./protocol";
import { findRemoteConnection, type RemoteConnection, type RemoteJson } from "./remote-protocol";
import {
  attachRemoteConnection,
  remoteHostSnapshot,
  resolveRemoteConnection,
  runRemoteHostOperation,
  waitForRemoteConnection,
} from "./remote-runtime";
import {
  REMOTE_CONNECTION_KEY,
  SESSION_FILES_KEY,
  clearEvents,
  connections,
  connectionsFor,
  current,
  dispatch,
  failPending,
  flushEvents,
  fresh,
  loadMessages,
  isLoadingConnection,
  multiAgentModeCommand,
  browserUseModeCommand,
  computerUseModeCommand,
  patch,
  persistSession,
  primeProjection,
  queryClient,
  persistedSessionFile,
  projectActive,
  projectDisconnected,
  readSessionFiles,
  reconnectingProjects,
  refresh,
  request,
  sessionOwners,
  snapshot,
  snapshotListeners,
  snapshots,
  syncConfiguredProjectRoots,
  syncLiveSessions,
  syncSessionModes,
  syncedModes,
  type Snapshot,
  activeTarget,
} from "./rpc-core";
import { mobileRuntime, native } from "./runtime";

/** Connection lifecycle: start / activate / close a pi process, and the
 * workspace-tab wrappers the shell controller uses. */
export { startConnection, activateConnection, closeConnection };
function describeConnections(connections:readonly RemoteConnection[]){return connections.length?connections.map(item=>item.cwd).join('、'):'无'}
function asConnection(value:RemoteJson|undefined):RemoteConnection|undefined{
 if(typeof value!=='object'||value===null||Array.isArray(value))return undefined
 const {id,cwd}=value as {id?:unknown;cwd?:unknown}
 return typeof id==='string'&&id&&typeof cwd==='string'&&cwd?{id,cwd}:undefined
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
 // 空快照 + 正在拉历史：保持骨架屏。否则切回这条连接的第一帧会是一个空
 // transcript，ChatPane 会把它当“新会话”渲染出首页——就是“闪一下首页”。
 // 首页/新会话的 keepTranscript 快照 loading 本来就是 false，不受影响；
 // 有正文的快照永远优先，旧的、没人再收的 loading 仍然收起来。
 const stillLoading = saved.transcript.messages.length === 0 && saved.transcript.loading
   && (saved.connection !== "online" || isLoadingConnection(id))
 useWorkspace.getState().set({...saved,cwd,connectionId:id,panel:'chat',transcript:transcriptLoading(saved.transcript,stillLoading)})
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
  // 打开的会话已知路径：先读文件把它画出来（~110ms），不必等 pi 加载完再 serializer
  // 一遍。缓存会记下文件戳与条数，随后 loadMessages 对账后直接采用。
  const beforeEarly=current(id).transcript
  if(options?.sessionPath&&(beforeEarly.loading||beforeEarly.messages.length===0)){
   void primeProjection(options.sessionPath).then(primed=>{if(primed)patch(id,{transcript:primed.transcript})}).catch(()=>undefined)
  }
  await invoke('pi_connect',{cwd,onEvent,connectionId:id})
  const state=await request<RpcSessionState>({type:'get_state'},45000,id)
  if(connections.get(id)?.token!==token)return
  patch(id,{state})
  // 模式同步不挡连接：发送前 `ensureSessionModes` 会再确认一次键，这里错了也会被纠正。
  void syncSessionModes(id).catch(()=>{})
  // switch_session 成功才有资格把路径当作投影预告：否则先画的会是别人的历史。
  let switchedTo:string|undefined
  if(options?.sessionPath){try{await request({type:'switch_session',sessionPath:options.sessionPath},45000,id);switchedTo=options.sessionPath}catch{patch(id,{notices:['会话无法读取，已打开新会话']})}}
  else if(options?.restoreLast){const previousFile=persistedSessionFile(cwd)||undefined;if(previousFile&&previousFile!==state.sessionFile){try{await request({type:'switch_session',sessionPath:previousFile},45000,id);switchedTo=previousFile}catch{patch(id,{notices:['上次会话无法读取，已打开新会话']})}}}
  await loadMessages(id,switchedTo)
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
export async function setBrowserUseMode(enabled:boolean){
 const previous=useWorkspace.getState().browserUseEnabled
 useWorkspace.getState().set({browserUseEnabled:enabled});localStorage.setItem('pi-gui.browserUseEnabled',String(enabled))
 if(useWorkspace.getState().connection!=='online')return
 try{await request(browserUseModeCommand(enabled),30000)}
 catch(error){useWorkspace.getState().set({browserUseEnabled:previous});localStorage.setItem('pi-gui.browserUseEnabled',String(previous));throw error}
}
export async function connect(cwd:string,workspaceMode:WorkspaceMode=useWorkspace.getState().workspaceMode,options?:{restoreLast?:boolean}){
 const restoreLast=options?.restoreLast!==false
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
 await startConnection(cwd,id,{restoreLast})
 if(workspaceMode==='project')await syncConfiguredProjectRoots(cwd,id)
}
/** 桌面 bootstrap：只确定当前范围，不启动 pi 进程。连接由 shell 的面上层按需拉起。 */
export function setDesktopScope(cwd:string,workspaceMode:WorkspaceMode){
 const path=normalizeProjectPath(cwd)
 localStorage.setItem('pi-gui.cwd',path)
 localStorage.setItem('pi-gui.workspaceMode',workspaceMode)
 useWorkspace.getState().set({cwd:path,workspaceMode})
 return path
}
export async function requestWithRecovery<T=unknown>(command:RpcCommand,timeoutMs=30000,target=activeTarget()):Promise<T>{
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
export function hasWorkspaceConnection(id: string) { return Boolean(id) && connections.has(id) }
/** 某个会话文件当前挂在哪条活着的连接上（没有就返回空）。 */
export function connectionOwningSession(sessionPath: string): string {
 const owner = sessionOwners.get(sessionPath)
 return owner && connections.has(owner) ? owner : ""
}
export function workspaceConnectionIds() { return [...connections.keys()] }
/** Start a workspace's pi process without stealing the project's route. */
export async function openWorkspaceConnection(cwd: string, id: string, options?: { sessionPath?: string; restoreLast?: boolean; keepTranscript?: boolean }) {
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
