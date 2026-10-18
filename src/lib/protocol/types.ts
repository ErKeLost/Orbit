import type { RpcSessionState, RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
export type { RpcSessionState, RpcCommand, RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent'
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type Part = { type: string; text?: string; thinking?: string; thinkingComplete?: boolean; data?: string; /** 历史图片落盘后的本地路径（见 `media::offload_history`）。 */ file?: string; /** 历史图片在会话文件里的位置（见 `history::project`）：session + 行偏移 + 序号。 */ session?: string; at?: number; ordinal?: number; mimeType?: string; url?: string; id?: string; name?: string; arguments?: Record<string, Json>; argsText?: string }
export type PiMessage = { role: string; content?: string | Part[]; command?: string; output?: string; summary?: string; display?: boolean; timestamp?: number; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown; usage?: ToolUsage; errorMessage?: string; stopReason?: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }
export type DisplayMessage = { id: string; message: PiMessage; startedAt?: number; elapsedMs?: number; settled?: boolean }
export type DisplayMessageGroup = { id: string; items: DisplayMessage[]; indexes: number[] }
export type ToolUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total?: number } }
export type ToolImage = { data?: string; file?: string; session?: string; at?: number; ordinal?: number; mimeType: string }
export type ToolImageInfo = { model?: string; size?: string; paths?: string[] }
export type Tool = { name: string; args?: Record<string, Json>; result?: unknown; details?: { patch: string }; images?: ToolImage[]; image?: ToolImageInfo; running: boolean; isError?: boolean; usage?: ToolUsage; durationMs?: number }
export type Event = { type: string; message?: PiMessage; toolCallId?: string; toolName?: string; args?: Record<string, Json>; result?: unknown; partialResult?: unknown; isError?: boolean; details?: unknown; errorMessage?: string; assistantMessageEvent?: { type: string; contentIndex: number; delta?: string; content?: string; id?: string; toolName?: string; toolCall?: Part }; steering?: string[]; followUp?: string[]; [key: string]: unknown }
/**
 * ``submitted`` 是「已经提交、但 Pi 还没宣告这一轮开始」的等待位。回车到
 * ``agent_start`` 之间要做模式同步、图片 base64、prompt 往返和进程/模型启动，
 * 这段时间 ``running`` 还是 false，屏幕上此前没有任何指示。它只在空闲提交时置位，
 * ``agent_start`` / ``agent_settled`` / ``prompt_settled`` 时撤下。
 */
export type Transcript = { messages: DisplayMessage[]; active: number; running: boolean; submitted: boolean; compacting: boolean; loading: boolean; phase: string; tools: Record<string, Tool>; error: string | null; aborted: boolean; queue: { steering: string[]; followUp: string[] }; bash: { id?: string; command?: string; output: string; running: boolean } | null; turnStartedAt: number | null }
/**
 * `loading` 是骨架屏的开关：切换会话/项目时置位，`hydrate` 换上一份真正的 transcript
 * 就自然把它清掉（见 `lib/rpc.ts` 的 `loadMessages`）。
 */
export const emptyTranscript = (): Transcript => ({ messages: [], active: -1, running: false, submitted: false, compacting: false, loading: false, phase: '就绪', tools: {}, error: null, aborted: false, queue: { steering: [], followUp: [] }, bash: null, turnStartedAt: null })
/** 用户已经要求、但 Pi 还没确认的模型切换（provider + model id）。 */
export type PendingModel = { provider: string; id: string }
export type Model = NonNullable<RpcSessionState['model']>
export type Session = { path:string; id:string; cwd:string; name?:string; icon?:string; modified:string; messageCount:number; firstMessage:string }
export type UiRequest = RpcExtensionUIRequest
/**
 * 面板表头计时器的归属：``live`` 表示这一段负责显示「正在处理 Xs / 用时 Xs」，
 * ``hidden`` 表示同一轮的后续段（只显示「处理过程」标题，不再出现第二个"正在处理"）。
 */
export type TurnClock = 'live' | 'hidden' | undefined
