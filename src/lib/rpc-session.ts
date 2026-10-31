import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { invoke } from "./native";
import { useWorkspace } from "./store";
import { findBranchEntry, type BranchEntry } from "./session-branch";
import { reduceEvent, transcriptLoading, type PiMessage, type UiRequest } from "./protocol";
import { emptyTelemetry } from "./telemetry";
import { runRemoteHostOperation } from "./remote-runtime";
import {
  cachedTranscript,
  connections,
  connectionsFor,
  current,
  forgetCachedTranscript,
  fresh,
  loadMessages,
  patch,
  projectActive,
  projectDisconnected,
  queryClient,
  reconnectingProjects,
  refresh,
  request,
  route,
  sendCommand,
  sessionOwners,
  snapshot,
  snapshots,
  syncLiveSessions,
  activeTarget,
  applyLocalEvent,
  beginSessionReplacement,
  endSessionReplacement,
} from "./rpc-core";
import { activateConnection, closeConnection, connect, startConnection } from "./rpc-connection";
import { mobileRuntime, native, report, workspaceBackend } from "./runtime";
import { deliveryBehavior, type QueueBehavior } from "./session-delivery";

/**
 * pi 自己说这一轮是不是真的在跑。
 *
 * UI 的 `running` 是投影：它比 pi 慢一个事件，手机上还会因为重连/丢包更慢。排队类
 * 投递只有在一轮真的在跑时才会被消费，所以这个问题必须在投递前问 pi 本身，而不是
 * 相信屏幕上的那个布尔值。问不到（超时/连接抖动）返回 `undefined`，由
 * `deliveryBehavior` 按「在跑」处理。
 */
async function piIsStreaming(id:string):Promise<boolean|undefined>{
 try{return (await request<{isStreaming?:boolean}>({type:'get_state'},15000,id))?.isStreaming===true}
 catch{return undefined}
}
/**
 * 真正发出去的那条命令：排队类投递只在 pi 确认这一轮在跑时才带 `streamingBehavior`。
 *
 * 规则本身在 `session-delivery.ts`；这里只负责去问 pi 和改写命令。
 */
export async function deliveryFor(command:RpcCommand,target=activeTarget()):Promise<{command:RpcCommand;degraded:boolean}>{
 if(command.type!=='prompt'||!command.streamingBehavior)return {command,degraded:false}
 const id=route(target)
 const decision=deliveryBehavior(command.streamingBehavior as QueueBehavior,await piIsStreaming(id))
 if(!decision.degraded)return {command,degraded:false}
 const fresh={...command} as RpcCommand&{streamingBehavior?:unknown}
 delete fresh.streamingBehavior
 return {command:fresh,degraded:true}
}
/** Session-level commands: open / switch / retire a session, send prompts,
 *  steer a running turn, and the queue. */
export async function sendPrompt(command:RpcCommand,target=activeTarget(),wasRunning?:boolean,beforeSend?:()=>void){
 // 一切都落在这条连接自己的快照上：后台面板/分屏发消息，不会把乐观预览、等待位写进别的会话。
 const id=route(target),running=wasRunning??current(id).transcript.running
 try{
  const delivery=await deliveryFor(command,id)
  beforeSend?.()
  const result=await request<{disposition?:string}>(delivery.command,45000,id)
  // 退化成普通 prompt 的那一条已经开了一轮，不再需要用 `prompt_settled` 收等待位。
  if(!running&&result?.disposition!=='started')applyLocalEvent(id,{type:'prompt_settled'})
  return result
 }catch(error){
  if(!running)applyLocalEvent(id,{type:'prompt_settled'})
  throw error
 }
}
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
/**
 * 重命名一条会话。
 *
 * 已经打开的会话走 pi 自己的 `set_session_name`（它追加记录并同步内存里的名字），
 * 没打开的会话往 JSONL 末尾追加同一条 `session_info`——两种写法在磁盘上等价，
 * 差别只是前者顺便把活着的连接叫醒。
 */
export async function renameSession(sessionPath:string,name:string,connectionId?:string):Promise<void>{
 const clean=name.replace(/[\r\n]+/g,' ').replace(/\s+/g,' ').trim().slice(0,80)
 if(!clean)throw new Error('标题不能为空')
 if(mobileRuntime()){await runRemoteHostOperation<null>({name:'session.rename',sessionPath,title:clean})}
 else{
  const owner=(connectionId&&connections.has(connectionId)?connectionId:undefined)??sessionOwners.get(sessionPath)
  if(owner&&connections.has(owner)){
   await request({type:'set_session_name',name:clean} as RpcCommand,30000,owner)
   // 连接自己的快照里也存着这个名字（抬头、标签页读它），顺手对齐。
   await refresh(owner).catch(()=>undefined)
  }
  else{ if(!native)throw new Error('重命名会话需要桌面应用'); await invoke('rename_session',{sessionPath,name:clean}) }
 }
 // 按前缀作废**所有**项目的会话列表：改的可能不是当前项目的那条（项目栏的「会话」
 // 区块是跨项目列出的），只刷当前 cwd 的话，被改的那一行会一直显示旧标题。
 await queryClient.invalidateQueries({queryKey:['pi','sessions']})
}
export async function retireSession(sessionPath:string){
 const cwd=useWorkspace.getState().cwd,owner=sessionOwners.get(sessionPath),wasActive=owner?useWorkspace.getState().connectionId===owner:useWorkspace.getState().state?.sessionFile===sessionPath
 if(mobileRuntime()&&wasActive){await changeSession({type:'new_session'});await deleteSession(sessionPath);sessionOwners.delete(sessionPath);await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]});return}
 if(owner&&connections.has(owner))await closeConnection(owner,'会话已关闭')
 await deleteSession(sessionPath);sessionOwners.delete(sessionPath);forgetCachedTranscript(sessionPath)
 if(!wasActive)return
 const remaining=connectionsFor(cwd)[0]
 if(remaining){activateConnection(remaining,cwd);return}
 const id=`${cwd}#${crypto.randomUUID()}`
 useWorkspace.getState().set({...fresh(),cwd,connectionId:id,panel:'chat'})
 await startConnection(cwd,id)
}
export async function getSessionTurnDurations(sessionPath:string):Promise<Record<string,number>> { if(mobileRuntime())return runRemoteHostOperation<Record<string,number>>({name:'session.turnDurations',sessionPath});if(!native) return {}; return invoke<Record<string,number>>('session_turn_durations',{sessionPath}) }
export async function recallQueue(target=activeTarget()){const id=route(target),cleared=await request<{steering:string[];followUp:string[]}>({type:'clear_queue'},30000,id);const s=current(id);patch(id,{draft:[s.draft,...cleared.steering,...cleared.followUp].filter(Boolean).join('\n'),transcript:reduceEvent(s.transcript,{type:'queued_preview_clear'})})}
/** Promote one queued follow-up into the running turn as a steer (Orbit's "Steer"). */
export async function steerFollowUp(text:string,target=activeTarget()){
 const id=route(target),cleared=await request<{steering:string[];followUp:string[]}>({type:'clear_queue'},30000,id)
 // 没有在跑的一轮时，`steer` 只是把消息放回队列（没有回合会来取，见 `deliveryFor`）。
 // 那就让第一条直接把这一轮开起来，其余的照旧 steer——回合开始时 pi 会一起取走。
 const streaming=await piIsStreaming(id)
 // 问不到 pi 时同样按「在跑」处理（`deliveryBehavior` 的规则）：宁可退回排队。
 let opened=streaming!==false
 const deliver=async(message:string)=>{
  if(opened)return request({type:'steer',message},30000,id)
  opened=true
  return request({type:'prompt',message},45000,id)
 }
 let promoted=false
 for(const message of cleared.steering)await deliver(message)
 for(const message of cleared.followUp){
  if(!promoted&&message===text){promoted=true;await deliver(message)}
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
export async function stop(target=activeTarget()){
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
const SESSION_SWITCH_COMMANDS=new Set(['switch_session','new_session','clone','fork'])
/** 骨架屏置位：只在这条连接确实要跑一次 loadMessages 时才调，否则没人会把它收回来。 */
const markSessionLoading=(id:string)=>patch(id,{transcript:transcriptLoading(current(id).transcript,true)})
/**
 * 换掉整份 transcript：先上骨架屏再 loadMessages。会话树切分支这种『不换 session
 * 但内容整体换掉』的入口走这里，loadMessages 自己会（成功或失败）把骨架屏收起来。
 */
export async function reloadMessages(target=activeTarget()){const id=route(target);markSessionLoading(id);return loadMessages(id)}
async function changeSessionOnce(command:RpcCommand){
 const cwd=useWorkspace.getState().cwd,active=route(cwd),running=current(active).transcript.running
 if(command.type==='switch_session'){
  if(useWorkspace.getState().state?.sessionFile===command.sessionPath){useWorkspace.getState().set({panel:'chat'});return}
  const owner=sessionOwners.get(command.sessionPath)
  // 这个会话的遥接已经活着（快照里有消息），切过去是瞬时的，不上骨架屏。
  if(owner&&connections.has(owner)){activateConnection(owner,cwd);await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]});return}
 }
 const switching=SESSION_SWITCH_COMMANDS.has(String(command.type))
 // 正在跑的那一轮会切到一条新连接上（旧连接留在快照里继续跑），加载发生在
 // 新连接上，所以这时不能在 active 上置位：没人会去收回它。
 const swapsConnection=(command.type==='new_session'||command.type==='switch_session')&&running&&!mobileRuntime()
 // 开过的会话有正文缓存：先直接画出来（无骨架屏），再去后台确认。
 const cached=command.type==='switch_session'?cachedTranscript(command.sessionPath):undefined
 if(switching&&!swapsConnection){
  if(cached)patch(active,{transcript:cached,error:null})
  else markSessionLoading(active)
 }
 // 从这个请求发出到新会话就绪，这条连接的扩展上下文正在（或即将）作废。
 // 期间自动发起的 `/gui-*` 命令先让开（会话元数据、指标轮询），替换完再发。
 if(switching)beginSessionReplacement(active)
 try{
  if(mobileRuntime()){
   const result=await request<{cancelled?:boolean;text?:string}>(command,60000,active)
   if(result?.cancelled)throw new Error('扩展取消了会话切换')
   patch(active,{error:null,telemetry:emptyTelemetry(),draft:result?.text??'',dialogs:[],statuses:{},widgets:{},agents:null})
   if(useWorkspace.getState().connectionId===active)useWorkspace.getState().set({panel:'chat'})
   await loadMessages(active,command.type==='switch_session'?command.sessionPath:undefined)
   await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]})
   return
  }
  if((command.type==='new_session'||command.type==='switch_session')&&running){
   const id=`${cwd}#${crypto.randomUUID()}`
   snapshots.set(active,snapshot())
   useWorkspace.getState().set({...fresh(),cwd,connectionId:id,panel:'chat'})
   await startConnection(cwd,id,command.type==='switch_session'?{sessionPath:command.sessionPath}:undefined)
   await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]});return
  }
  const result=await request<{cancelled?:boolean;text?:string}>(command,60000,active);if(result?.cancelled)throw new Error('扩展取消了会话切换');patch(active,{error:null,telemetry:emptyTelemetry(),draft:result?.text??'',dialogs:[],statuses:{},widgets:{},agents:null});if(useWorkspace.getState().connectionId===active)useWorkspace.getState().set({panel:'chat'});await loadMessages(active,command.type==='switch_session'?command.sessionPath:undefined);await queryClient.invalidateQueries({queryKey:['pi','sessions',cwd]})
 }
 catch(error){
  // 取消/失败时手动收起骨架屏：这条路径不会走到 loadMessages 的 hydrate。
  for(const id of new Set([active,useWorkspace.getState().connectionId]))patch(id,{transcript:transcriptLoading(current(id).transcript,false)})
  throw error
 } finally {
  if(switching)endSessionReplacement(active)
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
  // 克隆是一次会话替换：从这里到 `/gui-tree` 回来，旧 ctx 作废，自动发起的
  // `/gui-*` 命令先让开（同 `changeSessionOnce`）。
  beginSessionReplacement(id)
  const result=await request<{cancelled?:boolean}>({type:'clone'},60000,id)
  if(result.cancelled)throw new Error('扩展取消了创建分支')
  cloned=true
  // Navigate only in the clone so the original conversation keeps its current leaf.
  await request({type:'prompt',message:`/gui-tree ${JSON.stringify({id:entryId,summarize:false})}`},60000,id)
  endSessionReplacement(id)
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
   endSessionReplacement(id)
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
