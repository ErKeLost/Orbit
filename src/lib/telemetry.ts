import type {Event} from './protocol'
export type Usage={input:number;output:number;cacheRead:number;cacheWrite:number;totalTokens:number;cost?:{input:number;output:number;cacheRead:number;cacheWrite:number;total:number}}
export type Compaction={status:'running'|'complete'|'cancelled'|'error';reason:string;startedAt:number;endedAt?:number;tokensBefore?:number;estimatedTokensAfter?:number;summary?:string;error?:string;willRetry?:boolean;usage?:Usage}
export type Telemetry={usage:Usage|null;compaction:Compaction|null;retry:{status:string;attempt?:number;maxAttempts?:number;delayMs?:number;error?:string}|null;events:{type:string;at:number;detail:string}[]}
export const emptyTelemetry=():Telemetry=>({usage:null,compaction:null,retry:null,events:[]})
export function observe(previous:Telemetry,event:Event,now=Date.now()):Telemetry{
 // 流式里 99% 的 message_update 不带 usage：什么都没变就原样返回，避免下游白白重渲染。
 if(event.type==='message_update'&&!event.usage)return previous
 if(event.type==='tool_execution_update'||event.type==='response')return previous
 let next={...previous}
 if(event.type==='agent_start')next.usage=null
 if(event.type==='message_update'&&event.usage)next.usage=event.usage as Usage
 if(event.type==='compaction_start')next.compaction={status:'running',reason:String(event.reason),startedAt:now}
 if(event.type==='compaction_end'){
  const result=event.result as Partial<Compaction>|null
  next.compaction={...previous.compaction,reason:String(event.reason),startedAt:previous.compaction?.startedAt??now,endedAt:now,status:event.aborted?'cancelled':event.errorMessage||!result?'error':'complete',tokensBefore:result?.tokensBefore,estimatedTokensAfter:result?.estimatedTokensAfter,summary:result?.summary,usage:result?.usage,error:event.errorMessage,willRetry:!!event.willRetry}
 }
 if(event.type==='auto_retry_start'||event.type==='summarization_retry_scheduled')next.retry={status:'waiting',attempt:Number(event.attempt),maxAttempts:Number(event.maxAttempts),delayMs:Number(event.delayMs),error:event.errorMessage}
 if(event.type==='auto_retry_end')next.retry={...previous.retry,status:event.success?'complete':'error',attempt:Number(event.attempt),error:event.finalError?String(event.finalError):undefined}
 if(event.type==='summarization_retry_attempt_start')next.retry={...previous.retry,status:'running'}
 if(event.type==='summarization_retry_finished')next.retry={...previous.retry,status:'finished'}
 if(!['message_update','tool_execution_update','response'].includes(event.type))next.events=[{type:event.type,at:now,detail:String(event.errorMessage??event.toolName??event.reason??'')},...previous.events].slice(0,60)
 return next
}
