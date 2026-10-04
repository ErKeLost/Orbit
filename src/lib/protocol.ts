import type { RpcSessionState, RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
export type { RpcSessionState, RpcCommand, RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Part = { type: string; text?: string; thinking?: string; thinkingComplete?: boolean; data?: string; mimeType?: string; url?: string; id?: string; name?: string; arguments?: Record<string, Json>; argsText?: string }
export type PiMessage = { role: string; content?: string | Part[]; command?: string; output?: string; summary?: string; display?: boolean; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown; usage?: ToolUsage; errorMessage?: string; stopReason?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }
export type DisplayMessage = { id: string; message: PiMessage; startedAt?: number; elapsedMs?: number }
export type DisplayMessageGroup = { id: string; items: DisplayMessage[]; indexes: number[] }
export type ToolUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } }
export type ToolImage = { data: string; mimeType: string }
export type ToolImageInfo = { model?: string; size?: string; paths?: string[] }
export type Tool = { name: string; args?: Record<string, Json>; result?: unknown; details?: { patch: string }; images?: ToolImage[]; image?: ToolImageInfo; running: boolean; isError?: boolean; usage?: ToolUsage }
export type Event = { type: string; message?: PiMessage; toolCallId?: string; toolName?: string; args?: Record<string, Json>; result?: unknown; partialResult?: unknown; isError?: boolean; details?: unknown; errorMessage?: string; assistantMessageEvent?: { type: string; contentIndex: number; delta?: string; content?: string; id?: string; toolName?: string; toolCall?: Part }; steering?: string[]; followUp?: string[]; [key: string]: unknown }
export type Transcript = { messages: DisplayMessage[]; active: number; running: boolean; compacting: boolean; phase: string; tools: Record<string, Tool>; error: string | null; queue: { steering: string[]; followUp: string[] }; bash: { id?: string; command?: string; output: string; running: boolean } | null; turnStartedAt: number | null }
export const emptyTranscript = (): Transcript => ({ messages: [], active: -1, running: false, compacting: false, phase: '就绪', tools: {}, error: null, queue: { steering: [], followUp: [] }, bash: null, turnStartedAt: null })
const MAX_TOOL_RESULT_CHARS = 20_000
const MAX_TOOL_PATCH_CHARS = 100_000
const boundedToolText = (text:string) => text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0,MAX_TOOL_RESULT_CHARS)}\n\n[输出过长，已省略]`
function toolCodeDetails(toolName:string,value:unknown):Tool['details']|undefined {
  if(!/(^|[_-])(edit|patch|apply)([_-]|$)|^(edit|patch|apply)/i.test(toolName))return undefined
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined
  const record=value as Record<string,unknown>
  const details=record.details&&typeof record.details==='object'&&!Array.isArray(record.details)?record.details as Record<string,unknown>:record
  const patch=details.patch
  return typeof patch==='string'&&patch.length<=MAX_TOOL_PATCH_CHARS?{patch}:undefined
}
export function toolResultText(value:unknown):string {
  if(value == null)return ''
  if(typeof value==='string')return boundedToolText(value)
  if(typeof value==='number'||typeof value==='boolean')return String(value)
  if(Array.isArray(value))return boundedToolText(value.flatMap(item=>{
    if(typeof item==='string')return [item]
    if(item&&typeof item==='object'&&'text' in item&&typeof item.text==='string')return [item.text]
    if(item&&typeof item==='object'&&'type' in item&&item.type==='image')return ['[图片]']
    return []
  }).join('\n'))
  if(typeof value==='object'){
    const record=value as Record<string,unknown>
    if('content' in record)return toolResultText(record.content)
    for(const key of ['message','error','output','result'] as const){
      if(key in record){const text=toolResultText(record[key]);if(text)return text}
    }
  }
  return '工具执行完成'
}
/** Tool that generates images; its results carry media plus the model that ran. */
export const IMAGE_TOOL_NAME = 'generate_image'
/**
 * 生成的图片以 base64 常驻在会话里，一张 2K 图就是几 MB。每次渲染都重新拼
 * `data:` URL 会给每帧加几 MB 的一次性字符串（GC 压力），而同一张图的 base64
 * 字符串引用是稳定的，所以按图片对象缓存。WeakMap 随图片对象一起回收。
 */
const dataUrlCache = new WeakMap<ToolImage, string>()

export function toolImageDataUrl(image: ToolImage): string {
  const cached = dataUrlCache.get(image)
  if (cached !== undefined) return cached
  const url = `data:${image.mimeType};base64,${image.data}`
  dataUrlCache.set(image, url)
  return url
}

export function toolResultImages(value:unknown):ToolImage[] {
  const images:ToolImage[] = []
  const visit=(input:unknown)=>{
    if(Array.isArray(input)){for(const item of input)visit(item);return}
    if(!input||typeof input!=='object')return
    const record=input as Record<string,unknown>
    if(record.type==='image'&&typeof record.data==='string'&&record.data&&typeof record.mimeType==='string'&&record.mimeType){
      images.push({data:record.data,mimeType:record.mimeType})
      return
    }
    if('content' in record)visit(record.content)
  }
  visit(value)
  return images
}
/** The model, pixel size, and local files a tool result reports, so the image
 * card can name it, reveal it in the file manager, and reuse it as a reference. */
function toolImageInfo(toolName:string,source:unknown):ToolImageInfo|undefined {
  if(toolName!==IMAGE_TOOL_NAME)return undefined
  const details=(source as {details?:unknown}|null)?.details
  if(!details||typeof details!=='object')return undefined
  const record=details as Record<string,unknown>
  const model=typeof record.model==='string'?record.model:undefined
  const size=typeof record.size==='string'?record.size:undefined
  const paths=Array.isArray(record.paths)?record.paths.filter((path):path is string=>typeof path==='string'&&path.length>0):[]
  if(!model&&!paths.length)return undefined
  return {...(model?{model}:{}),...(size?{size}:{}),...(paths.length?{paths}:{})}
}
export function groupDisplayMessages(messages: DisplayMessage[]): DisplayMessageGroup[] {
  return messages.reduce<DisplayMessageGroup[]>((groups, item, index) => {
    const previous = groups.at(-1)
    if (item.message.role === 'assistant' && previous?.items.every(entry => entry.message.role === 'assistant')) {
      previous.items.push(item)
      previous.indexes.push(index)
      return groups
    }
    groups.push({ id: item.id, items: [item], indexes: [index] })
    return groups
  }, [])
}

/**
 * 面板表头计时器的归属：``live`` 表示这一段负责显示「正在处理 Xs / 用时 Xs」，
 * ``hidden`` 表示同一轮的后续段（只显示「处理过程」标题，不再出现第二个"正在处理"）。
 */
export type TurnClock = 'live' | 'hidden' | undefined

/**
 * steer / follow-up 会把一轮拆成共享同一个 startedAt 的多段。一次 turn 只在**最上面**
 * 那段计时：运行时显示「正在处理 Xs」，结束后显示「用时 Xs」；下面被 steer 拆出来的段
 * 只返回 ``hidden``，无论是否正在流式输出都不再重复「正在处理」，避免一轮里两个闪烁的
 * 处理面板。
 */
export function assignTurnClocks(
  groups: readonly { startedAt?: number }[],
  turn: { running: boolean; turnStartedAt: number | null },
): TurnClock[] {
  const runningTurn = turn.running ? turn.turnStartedAt : null
  const seenTurns = new Set<number>()
  return groups.map(group => {
    if (group.startedAt === undefined) return undefined
    if (seenTurns.has(group.startedAt)) return 'hidden'
    seenTurns.add(group.startedAt)
    return runningTurn !== null && group.startedAt === runningTurn ? 'live' : undefined
  })
}
export function formatTranscriptError(raw: string): string {
  const text = raw.trim()
  if (!text) return '会话异常'
  const start = text.indexOf('{')
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { message?: unknown; error?: { message?: unknown; type?: unknown } | string }
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim()
      if (parsed.error && typeof parsed.error === 'object') {
        if (typeof parsed.error.message === 'string' && parsed.error.message.trim()) return parsed.error.message.trim()
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
      const kind = parsed.error && typeof parsed.error === 'object' && typeof parsed.error.type === 'string' ? parsed.error.type : ''
      const prefix = text.slice(0, start).trim()
      const fallback = [prefix, kind].filter(Boolean).join(' · ')
      if (fallback) return fallback
    } catch {
      /* keep the original provider string */
    }
  }
  return text
}
export function normalizeMessage(message: PiMessage): PiMessage {
  if(message.content !== undefined)return message
  if(message.role==='bashExecution')return {...message,content:`Bash: ${message.command ?? ''}\n\n${message.output ?? ''}`}
  return {...message,content:message.summary ?? ''}
}
export function messagePlainText(message: PiMessage | undefined): string {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.flatMap(part => part.type === 'text' && part.text ? [part.text] : []).join('\n')
}
const isQueuedPreview = (item: DisplayMessage) => item.id.startsWith('queued-')
// 前端乐观预览与后端 queued_preview 事件会先后到达：内容一致且时间接近时视为同一条回声。
const previewEcho = (existing: DisplayMessage, incoming: PiMessage) => {
  if (!isQueuedPreview(existing) || existing.message.role !== 'user') return false
  const fingerprint = (message: PiMessage) => {
    const parts = Array.isArray(message.content) ? message.content : (typeof message.content === 'string' && message.content ? [{ type: 'text', text: message.content }] : [])
    return JSON.stringify(parts.map(part => ({ type: part.type, text: (part as { text?: string }).text })))
  }
  if (fingerprint(existing.message) !== fingerprint(incoming)) return false
  const a = existing.message.timestamp ?? 0, b = incoming.timestamp ?? 0
  return !a || !b || Math.abs(a - b) < 5000
}
const queuedStillPending = (item: DisplayMessage, queue: Transcript['queue']) => {
  if (!isQueuedPreview(item)) return true
  const text = messagePlainText(item.message)
  return queue.steering.includes(text) || queue.followUp.includes(text)
}
export function hydrate(messages: PiMessage[]): Transcript {
  const state = emptyTranscript()
  for (const raw of messages) {
    if(raw.role==='custom' && raw.display===false)continue
    const message=normalizeMessage(raw)
    if (message.role === 'toolResult' && message.toolCallId) state.tools[message.toolCallId] = {name: message.toolName ?? 'tool', result: toolResultText(message.content), details:toolCodeDetails(message.toolName??'tool',message.details), images:toolResultImages(message.content), image:toolImageInfo(message.toolName??'tool',message), running: false, isError: message.isError, usage: message.usage as ToolUsage|undefined}
    else state.messages.push({ id: `history-${state.messages.length}-${message.timestamp ?? 0}`, message })
  }
  return state
}
// Pi 0.85.1 RPC intentionally has delta-only updates. The end snapshot is authoritative.
export function reduceEvent(previous: Transcript, event: Event): Transcript {
  const state = { ...previous }
  switch (event.type) {
    case 'prompt_submitted': return { ...state, error: null, messages: state.messages.map(item => item.message.errorMessage ? {...item,message:{...item.message,errorMessage:undefined}} : item) }
    case 'bash_execution_update': return { ...state, bash: { id: typeof event.id === 'string' ? event.id : undefined, command: typeof event.command === 'string' ? event.command : state.bash?.command, output: `${state.bash?.output ?? ''}${String(event.delta ?? '')}`, running: true } }
    case 'agent_start': return { ...state, active: -1, running: true, phase: '正在思考', error: null, turnStartedAt: state.turnStartedAt ?? Date.now() }
    case 'agent_settled': {
      const elapsedMs = state.turnStartedAt == null ? undefined : Math.max(0, Date.now() - state.turnStartedAt)
      let durationOwner = false
      return {
        ...state,
        running: false,
        phase: '就绪',
        bash: state.bash ? { ...state.bash, running: false } : null,
        turnStartedAt: null,
        messages: (elapsedMs == null ? state.messages : state.messages.map(item => {
          if (durationOwner || item.startedAt !== state.turnStartedAt || item.message.role !== 'assistant') return item
          durationOwner = true
          return { ...item, elapsedMs }
        })).filter(item => queuedStillPending(item, state.queue)),
      }
    }
    case 'agent_end': return state
    case 'compaction_start': return { ...state, compacting: true, phase: '正在压缩上下文' }
    case 'compaction_end': return { ...state, compacting: false, phase: state.running ? '正在运行' : '就绪' }
    case 'auto_retry_start': return { ...state, running: true, phase: '正在重试' }
    case 'extension_error': return { ...state, error: String(event.error ?? event.errorMessage ?? '扩展执行失败') }
    case 'queue_update': return { ...state, queue: { steering: event.steering ?? [], followUp: event.followUp ?? [] } }
    case 'queued_preview': {
      if (!event.message || event.message.role !== 'user') return state
      const message = normalizeMessage(event.message)
      const last = state.messages[state.messages.length - 1]
      if (last && previewEcho(last, message)) return state
      const id = typeof event.id === 'string' ? event.id : `queued-${state.messages.length}`
      return { ...state, messages: [...state.messages, { id, message }] }
    }
    case 'queued_preview_revert': {
      const id = typeof event.id === 'string' ? event.id : ''
      return id ? { ...state, messages: state.messages.filter(item => item.id !== id) } : state
    }
    case 'queued_preview_clear': return { ...state, messages: state.messages.filter(item => !isQueuedPreview(item)) }
    case 'message_start': {
      if (!event.message || event.message.role === 'toolResult' || (event.message.role==='custom'&&event.message.display===false)) return state
      const message = normalizeMessage(event.message)
      const entry: DisplayMessage = {
        id: `live-${state.messages.length}-${event.message.timestamp ?? 0}`,
        message,
        ...(message.role === 'assistant' ? { startedAt: state.turnStartedAt ?? Date.now() } : {}),
      }
      // 投递时把预览移到末尾：预览可能早于后续 assistant 的 message_start 插入，
      // 原位替换会让用户消息不在末尾，随后的 message_end（写最后一条）就会覆盖掉 assistant 回复。
      const preview = message.role === 'user' ? state.messages.findIndex(isQueuedPreview) : -1
      const base = preview >= 0 ? state.messages.filter((_, index) => index !== preview) : state.messages
      if (preview >= 0 && state.active > preview) state.active -= 1
      state.messages = [...base, entry]
      if (message.role === 'assistant') state.active = state.messages.length - 1
      return state
    }
    case 'message_update': {
      const delta = event.assistantMessageEvent
      const original = state.messages[state.active]
      if (!delta || !original || original.message.role !== 'assistant') return state
      const content = Array.isArray(original.message.content) ? [...original.message.content] : []
      const index = delta.contentIndex
      let part = { ...content[index] }
      switch(delta.type) {
        case 'text_start': part = {type:'text', text:''}; break
        case 'text_delta': part = { ...part, type:'text', text:(part.text ?? '')+(delta.delta ?? '') }; break
        case 'text_end': if (delta.content !== undefined) part = {...part, type:'text', text:delta.content}; break
        case 'thinking_start': part = {type:'thinking', thinking:''}; break
        case 'thinking_delta': part = { ...part, type:'thinking', thinking:(part.thinking ?? '')+(delta.delta ?? '') }; break
        case 'thinking_end': part = {...part,type:'thinking',thinking:delta.content ?? part.thinking,thinkingComplete:true}; break
        case 'toolcall_start': part = {type:'toolCall', id:delta.id, name:delta.toolName,argsText:''}; break
        case 'toolcall_delta': part = {...part,argsText:(part.argsText ?? '')+(delta.delta ?? '')}; break
        case 'toolcall_end': if(delta.toolCall) part = delta.toolCall; break
      }
      content[index] = part
      state.messages = [...state.messages]
      state.messages[state.active] = {...original,message:{...original.message,content}}
      return state
    }
    case 'message_end': {
      if (!event.message || (event.message.role==='custom'&&event.message.display===false)) return state
      const message = { ...normalizeMessage(event.message) }
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        message.content = message.content.map(part => part.type === 'thinking' ? {...part,thinkingComplete:true} : part)
      }
      if (message.role === 'toolResult' && message.toolCallId) return { ...state, tools: {...state.tools,[message.toolCallId]:{...state.tools[message.toolCallId],name:message.toolName ?? 'tool',running:false,result:toolResultText(message.content),details:toolCodeDetails(message.toolName??'tool',message.details)??state.tools[message.toolCallId]?.details,images:toolResultImages(message.content),image:toolImageInfo(message.toolName??'tool',message),isError:message.isError,usage:message.usage as ToolUsage|undefined}} }
      let index = message.role === 'assistant' ? state.active : -1
      if (message.role !== 'assistant') {
        for (let i = state.messages.length - 1; i >= 0; i--) {
          const candidate = state.messages[i].message
          if (candidate.role === message.role && !isQueuedPreview(state.messages[i]) && (candidate.timestamp === undefined || message.timestamp === undefined || candidate.timestamp === message.timestamp)) { index = i; break }
        }
      }
      if(index >= 0) {
        state.messages = [...state.messages]; state.messages[index] = {...state.messages[index],message}
      }
      if(message.errorMessage) state.error=message.errorMessage
      return state
    }
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end': {
      if (!event.toolCallId) return state
      const tool = state.tools[event.toolCallId]
      const name=event.toolName ?? tool?.name ?? 'tool'
      const result = event.result !== undefined ? toolResultText(event.result) : event.partialResult !== undefined ? toolResultText(event.partialResult) : tool?.result
      const details=event.result!==undefined?toolCodeDetails(name,event.result)??tool?.details:tool?.details
      const images=event.result!==undefined?toolResultImages(event.result):tool?.images
      const image=event.result!==undefined?toolImageInfo(name,event.result):tool?.image
      return { ...state, phase: event.type === 'tool_execution_end' ? '正在运行' : `执行 ${event.toolName}`, tools: {...state.tools,[event.toolCallId]:{...tool,name,args:event.args ?? tool?.args,result,details,images,image,running:event.type !== 'tool_execution_end',isError:event.isError}} }
    }
    default: return state
  }
}
export type Model = NonNullable<RpcSessionState['model']>
export type Session = { path:string; id:string; cwd:string; name?:string; icon?:string; modified:string; messageCount:number; firstMessage:string }
export type UiRequest = RpcExtensionUIRequest
