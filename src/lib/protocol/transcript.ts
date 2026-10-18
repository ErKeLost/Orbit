import { emptyTranscript } from './types'
import type { DisplayMessage, Event, PendingModel, PiMessage, Tool, ToolUsage, Transcript } from './types'
import { toolImageInfo, toolResultImages, toolResultText } from './images'
import { isQueuedPreview, visibleTurnStart } from './grouping'
import { isStaleExtensionContextError } from '../extension-errors'

/** 会话切换期间先上骨架屏，别让上一个会话的消息停在原地再突然换掉。 */
export const transcriptLoading = (transcript: Transcript, loading: boolean): Transcript => transcript.loading === loading ? transcript : { ...transcript, loading }

/**
 * Whether a reconnect may keep the transcript that is already on screen.
 *
 * Both halves are load-bearing. `sameConnection` is what separates a recovery
 * from a switch: coming back to the app is the same project showing the same
 * session, while landing on another project must not leave the previous one's
 * messages under the new one's title. `hasMessages` separates that from a first
 * connect, where there is nothing to keep and the skeleton is the honest answer.
 *
 * The cost of getting this wrong is a skeleton on every return from another app,
 * which is exactly what the user sees most often and trusts least.
 */
export const reconnectKeepsTranscript = ({ recovery, sameConnection, hasMessages }: { recovery: boolean; sameConnection: boolean; hasMessages: boolean }): boolean =>
  recovery && sameConnection && hasMessages

export const sameModel = (left: PendingModel | undefined, right: { provider?: string; id?: string } | undefined) =>
  Boolean(left && right && left.provider === right.provider && left.id === right.id)

/**
 * 把「正在切换」的模型盖到一份会话状态上。
 *
 * 切换 provider 要重起 Pi 进程，那几秒里 `get_state` 回的是**重启后**的默认模型
 * （旧的那个）——直接把这份状态写进 store，就是“点了切换、回来还写着 deepseek，
 * 等十秒才自己变”。所以在 Pi 确认新模型之前，store 里显示的是用户要的那个。
 */
export function withPendingModel<T extends { model?: { provider?: string; id?: string } } | null>(state: T, pending?: PendingModel): T {
  if (!pending || !state?.model) return state
  if (sameModel(pending, state.model)) return state
  return { ...state, model: { ...state.model, provider: pending.provider, id: pending.id } } as T
}
const MAX_TOOL_PATCH_CHARS = 100_000
function toolCodeDetails(toolName:string,value:unknown):Tool['details']|undefined {
  if(!/(^|[_-])(edit|patch|apply)([_-]|$)|^(edit|patch|apply)/i.test(toolName))return undefined
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined
  const record=value as Record<string,unknown>
  const details=record.details&&typeof record.details==='object'&&!Array.isArray(record.details)?record.details as Record<string,unknown>:record
  const patch=details.patch
  return typeof patch==='string'&&patch.length<=MAX_TOOL_PATCH_CHARS?{patch}:undefined
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
// 手动停止一轮时，Pi 给 assistant 消息标上 stopReason "aborted" 并附
// "This operation was aborted"。用户主动暂停不是故障：剥掉这段错误文本，
// 轮内错误行和 transcript.error 都不会再为它出现（历史重载 hydrate 同样生效）。
const isAbortedAssistant = (message: PiMessage) =>
  message.role === 'assistant' && (message.stopReason === 'aborted' || message.errorMessage?.trim().toLowerCase() === 'this operation was aborted')
export function normalizeMessage(message: PiMessage): PiMessage {
  // 会话替换后旧扩展 ctx 作废的报错不是这一轮的回答出错（见 extension-errors.ts）：
  // 它挂在某条 assistant 消息上时同样剥掉，历史重载和实时都走这里。
  if (message.errorMessage && (isAbortedAssistant(message) || isStaleExtensionContextError(message.errorMessage))) return { ...message, errorMessage: undefined }
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
    else state.messages.push({ id: `history-${state.messages.length}-${message.timestamp ?? 0}`, message, settled: message.role === 'assistant' })
  }
  return state
}
// Pi 0.85.1 RPC intentionally has delta-only updates. The end snapshot is authoritative.
export function reduceEvent(previous: Transcript, event: Event): Transcript {
  const state = { ...previous }
  switch (event.type) {
    case 'prompt_submitted': {
      // 空闲提交才占等待位：流式中提交（steer）本来就有「正在处理」的面板，
      // 再补一个指示就是一轮两个（0.3.43 的回归）。
      return {
        ...state,
        ...(state.running ? {} : { submitted: true, phase: '正在思考', turnStartedAt: state.turnStartedAt ?? Date.now() }),
        error: null,
        messages: state.messages.map(item => item.message.errorMessage ? {...item,message:{...item.message,errorMessage:undefined}} : item),
      }
    }
    // Pi 没有真的开一轮：被扩展命令接管（disposition "handled"）、排队（"queued"）
    // 或直接发送失败。撤掉等待位，否则会留下一个永远转圈的「正在思考」。
    case 'prompt_settled': return state.submitted
      ? { ...state, submitted: false, ...(state.running ? {} : { phase: '就绪', turnStartedAt: null }) }
      : state
    case 'bash_execution_update': return { ...state, bash: { id: typeof event.id === 'string' ? event.id : undefined, command: typeof event.command === 'string' ? event.command : state.bash?.command, output: `${state.bash?.output ?? ''}${String(event.delta ?? '')}`, running: true } }
    case 'agent_start': return { ...state, active: -1, running: true, submitted: false, phase: '正在思考', error: null, aborted: false, turnStartedAt: state.turnStartedAt ?? Date.now() }
    case 'agent_settled': {
      // 一次可见的轮里可能有多次运行（worker 的 `custom` 结果并入同一组，见
      // `groupDisplayMessages`）。耗时写在**这一组**的首条 assistant 上、从这一组的
      // 第一次运行起算，并覆盖上一次 settle 写下的值：写“本次运行自己的耗时”会让
      // 整轮只剩最后一小段（真实遇到过 11m45s 的一轮被写成 2s），累加则会把历史
      // 算出来的墙钟时间换算成另一个数。这样实时和重载都按同一个口径：从提问到
      // 最后一个回答。
      const owner = visibleTurnStart(state.messages)
      const elapsedMs = owner?.startedAt == null ? undefined : Math.max(0, Date.now() - owner.startedAt)
      return {
        ...state,
        running: false,
        submitted: false,
        // Pi 1.1.0 起 agent_settled 带 aborted：这是「这一轮是被中止的」唯一权威信号。
        // 只靠 error 字段判断会把取消记成成功（自动化回写就踩这个坑）。
        aborted: event.aborted === true,
        phase: '就绪',
        bash: state.bash ? { ...state.bash, running: false } : null,
        turnStartedAt: null,
        messages: (elapsedMs == null ? state.messages : state.messages.map(item => (item === owner ? { ...item, elapsedMs } : item))).filter(item => queuedStillPending(item, state.queue)),
      }
    }
    case 'agent_end': return state
    case 'compaction_start': return { ...state, compacting: true, phase: '正在压缩上下文' }
    case 'compaction_end': return { ...state, compacting: false, phase: state.running ? '正在运行' : '就绪' }
    case 'auto_retry_start': return { ...state, running: true, phase: '正在重试' }
    case 'extension_error':
      // 同一个守卫从扩展 runner 出来时走这条路（pi 的 `extension_error` 事件）。
      // 手机端换会话是原地做的，一条迟到的 status/会话名写入就会撞上它；把这种噪声
      // 画成会话级错误，用户看到的就是一条他无从处理的英文报错。
      return isStaleExtensionContextError(event.error ?? event.errorMessage)
        ? state
        : { ...state, error: String(event.error ?? event.errorMessage ?? '扩展执行失败') }
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
        state.messages = [...state.messages]
        // settled = 这条消息已经收到 message_end。流式中的 tail 是否是最终总结只能
        // 在消息结束后判定（toolcall 紧跟最后一个 text token，间隔毫秒级），
        // 提前提升会让正文先全尺寸渲染、工具调用一到又掉回折叠区 —— 就是那个闪烁。
        state.messages[index] = {...state.messages[index],message,settled: state.messages[index].settled || message.role === 'assistant'}
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
      // Pi 1.1.0 起 tool_execution_end 带 durationMs（execute() 的单调时钟耗时）。只有实时
      // 事件有它：历史会话 hydrate 出来的 toolResult 不带这个字段，所以必须容忍 undefined。
      const durationMs = event.type === 'tool_execution_end' && typeof event.durationMs === 'number' ? event.durationMs : tool?.durationMs
      return { ...state, phase: event.type === 'tool_execution_end' ? '正在运行' : `执行 ${event.toolName}`, tools: {...state.tools,[event.toolCallId]:{...tool,name,args:event.args ?? tool?.args,result,details,images,image,durationMs,running:event.type !== 'tool_execution_end',isError:event.isError}} }
    }
    default: return state
  }
}
