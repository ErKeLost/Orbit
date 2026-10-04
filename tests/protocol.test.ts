import {describe,test,expect} from 'bun:test'
import {assignTurnClocks,emptyTranscript,groupDisplayMessages,reuseGroups,reduceEvent,hydrate,toolResultImages,toolResultText} from '../src/lib/protocol'
import { summarizeToolCalls } from '../src/lib/tool-activity'
import { turnDurationId } from '../src/lib/turn-duration'
describe('Pi 0.87.1 JSONL event projection',()=>{
 test('assembling indexed text and thinking deltas, ending with the authoritative snapshot',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'message_start',message:{role:'assistant',content:[],timestamp:1}})
  for(const event of [{type:'text_start',contentIndex:0},{type:'text_delta',contentIndex:0,delta:'Hello\u2028'},{type:'thinking_start',contentIndex:1},{type:'thinking_delta',contentIndex:1,delta:'思考'},{type:'text_delta',contentIndex:0,delta:'world'}])state=reduceEvent(state,{type:'message_update',assistantMessageEvent:event})
  expect(state.messages[0].message.content).toEqual([{type:'text',text:'Hello\u2028world'},{type:'thinking',thinking:'思考'}])
  state=reduceEvent(state,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'authoritative'}],stopReason:'stop'}})
  expect(state.messages).toHaveLength(1);expect(state.messages[0].message.content).toEqual([{type:'text',text:'authoritative'}])
 })
 test('agent_end does not mark the run idle before retry/queue continuations settle',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'agent_end'});expect(state.running).toBe(true)
  state=reduceEvent(state,{type:'agent_settled'});expect(state.running).toBe(false)
 })
 test('queued steering preview shows as a user message and is promoted on delivery',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'message_start',message:{role:'assistant',content:[{type:'text',text:'正在处理'}]}})
  state=reduceEvent(state,{type:'queued_preview',id:'queued-1',message:{role:'user',content:'转向'}})
  expect(state.messages.map(item=>item.message.role)).toEqual(['assistant','user'])
  expect(state.messages[1].id).toBe('queued-1')
  state=reduceEvent(state,{type:'queue_update',steering:['转向'],followUp:[]})
  state=reduceEvent(state,{type:'message_start',message:{role:'user',content:'转向',timestamp:9}})
  expect(state.messages).toHaveLength(2)
  expect(state.messages[1].message).toEqual({role:'user',content:'转向',timestamp:9})
  expect(state.messages[1].id.startsWith('queued-')).toBe(false)
 })
 test('steer delivered after a later assistant message does not overwrite that reply',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'message_start',message:{role:'assistant',content:[{type:'toolCall',id:'t1',name:'bash'}],timestamp:1}})
  state=reduceEvent(state,{type:'queued_preview',id:'queued-1',message:{role:'user',content:'转向',timestamp:2}})
  state=reduceEvent(state,{type:'message_start',message:{role:'assistant',content:[],timestamp:3}})
  state=reduceEvent(state,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'最终回复'}],timestamp:3}})
  const user={role:'user',content:[{type:'text',text:'转向'}],timestamp:4}
  state=reduceEvent(state,{type:'message_start',message:user})
  state=reduceEvent(state,{type:'message_end',message:user})
  expect(state.messages.map(item=>item.message.role)).toEqual(['assistant','assistant','user'])
  expect(state.messages[1].message.content).toEqual([{type:'text',text:'最终回复'}])
  expect(state.messages.filter(item=>item.message.role==='user')).toHaveLength(1)
 })
 test('undelivered queued preview is dropped on abort or settle',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'queued_preview',id:'queued-1',message:{role:'user',content:'转向'}})
  state=reduceEvent(state,{type:'queued_preview_revert',id:'queued-missing'})
  expect(state.messages).toHaveLength(1)
  state=reduceEvent(state,{type:'queued_preview_clear'})
  expect(state.messages).toHaveLength(0)
  state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'queued_preview',id:'queued-2',message:{role:'user',content:'转向'}})
  state=reduceEvent(state,{type:'queue_update',steering:[],followUp:[]})
  state=reduceEvent(state,{type:'agent_settled'})
  expect(state.messages).toHaveLength(0)
 })
 test('图片附件的乐观预览在回显时被 base64 真实消息替换（不会重复）',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'prompt_submitted'})
  // 发送瞬间就用本地 object URL 把消息放进会话
  state=reduceEvent(state,{type:'queued_preview',id:'queued-image',message:{role:'user',content:[{type:'text',text:'看这张图'},{type:'image',mimeType:'image/png',url:'blob:local-preview'}],timestamp:1}})
  expect(state.messages).toHaveLength(1)
  expect(state.messages[0].message.content).toEqual([{type:'text',text:'看这张图'},{type:'image',mimeType:'image/png',url:'blob:local-preview'}])
  // Pi 回显同一条消息（这时带 base64）
  state=reduceEvent(state,{type:'message_start',message:{role:'user',content:[{type:'text',text:'看这张图'},{type:'image',mimeType:'image/png',data:'AAAA'}],timestamp:2}})
  expect(state.messages.filter(item=>item.message.role==='user')).toHaveLength(1)
  expect(state.messages[0].id.startsWith('queued-')).toBe(false)
  expect(state.messages[0].message.content).toEqual([{type:'text',text:'看这张图'},{type:'image',mimeType:'image/png',data:'AAAA'}])
})

test('乐观预览在发送失败时被撤回',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'prompt_submitted'})
  state=reduceEvent(state,{type:'queued_preview',id:'queued-fail',message:{role:'user',content:'发出去了吗',timestamp:1}})
  state=reduceEvent(state,{type:'queued_preview_revert',id:'queued-fail'})
  expect(state.messages).toHaveLength(0)
})

test('回车到 agent_start 之间先占上等待位，否则那段时间屏幕上什么都没有',()=>{
  const state=reduceEvent(emptyTranscript(),{type:'prompt_submitted'})
  expect(state.submitted).toBe(true)
  expect(state.running).toBe(false)
  expect(state.phase).toBe('正在思考')
  expect(state.turnStartedAt).toBeTypeOf('number')
})

test('agent_start 与 agent_settled 都会撤下等待位',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'prompt_submitted'})
  state=reduceEvent(state,{type:'agent_start'})
  expect(state.submitted).toBe(false)
  expect(state.running).toBe(true)
  state=reduceEvent(emptyTranscript(),{type:'prompt_submitted'})
  state=reduceEvent(state,{type:'agent_settled'})
  expect(state.submitted).toBe(false)
  expect(state.phase).toBe('就绪')
  expect(state.turnStartedAt).toBeNull()
})

test('被扩展接管/排队/发送失败的 prompt 不会留下永久的等待占位',()=>{
  const waiting=reduceEvent(emptyTranscript(),{type:'prompt_submitted'})
  const settled=reduceEvent(waiting,{type:'prompt_settled'})
  expect(settled.submitted).toBe(false)
  expect(settled.phase).toBe('就绪')
  expect(settled.turnStartedAt).toBeNull()
  // 没有等待位时是空操作（值不变）
  const again=reduceEvent(settled,{type:'prompt_settled'})
  expect(again.submitted).toBe(false)
  expect(again.phase).toBe('就绪')
  expect(again.turnStartedAt).toBeNull()
})

test('流式中的 steer 不再额外点一盏灯，一轮只留一个「正在处理」',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  const startedAt=state.turnStartedAt
  state=reduceEvent(state,{type:'prompt_submitted'})
  expect(state.submitted).toBe(false)
  expect(state.running).toBe(true)
  expect(state.turnStartedAt).toBe(startedAt)
  // 跟下来的 prompt_settled 不能把还在跑的一轮按停
  state=reduceEvent(state,{type:'prompt_settled'})
  expect(state.running).toBe(true)
  expect(state.submitted).toBe(false)
})

test('steered assistant continuation keeps the turn duration on the first segment only',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'message_start',message:{role:'assistant',content:[{type:'thinking',thinking:'原始任务'}]}})
  state=reduceEvent(state,{type:'message_start',message:{role:'assistant',content:[{type:'text',text:'steer 后继续'}]}})
  state=reduceEvent(state,{type:'agent_settled'})
  expect(state.messages).toHaveLength(2)
  expect(state.messages[0].elapsedMs).toBeTypeOf('number')
  expect(state.messages[1].elapsedMs).toBeUndefined()
 })
 test('thinking ends before the agent settles, retaining deltas when the end omits content',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'agent_start'})
  state=reduceEvent(state,{type:'message_start',message:{role:'assistant',content:[]}})
  state=reduceEvent(state,{type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'真实推理'}})
  state=reduceEvent(state,{type:'message_update',assistantMessageEvent:{type:'thinking_end',contentIndex:0}})
  expect(state.running).toBe(true)
  expect(state.messages[0].message.content).toEqual([{type:'thinking',thinking:'真实推理',thinkingComplete:true}])
  state=reduceEvent(state,{type:'message_update',assistantMessageEvent:{type:'thinking_start',contentIndex:1}})
  expect(Array.isArray(state.messages[0].message.content) && state.messages[0].message.content[1].thinkingComplete).toBeUndefined()
 })
 test('an authoritative message snapshot settles thinking without mutating the RPC message',()=>{
  const message={role:'assistant',content:[{type:'thinking',thinking:'Final reasoning'}]}
  let state=reduceEvent(emptyTranscript(),{type:'message_start',message:{role:'assistant',content:[]}})
  state=reduceEvent(state,{type:'message_end',message})
  expect(state.messages[0].message.content).toEqual([{type:'thinking',thinking:'Final reasoning',thinkingComplete:true}])
  expect(message.content).toEqual([{type:'thinking',thinking:'Final reasoning'}])
 })
 test('new agent turns do not reuse the previous assistant message as the active stream',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'message_start',message:{role:'assistant',content:[{type:'text',text:'previous'}]}})
  expect(state.active).toBe(0)
  state=reduceEvent(state,{type:'agent_start'})
  expect(state.active).toBe(-1)
  expect(state.running).toBe(true)
 })
 test('tool partial output replaces accumulated output and final error is preserved',()=>{
  let state=reduceEvent(emptyTranscript(),{type:'tool_execution_start',toolCallId:'a',toolName:'bash',args:{command:'pwd'}})
  state=reduceEvent(state,{type:'tool_execution_update',toolCallId:'a',toolName:'bash',partialResult:'abc'})
  state=reduceEvent(state,{type:'tool_execution_update',toolCallId:'a',toolName:'bash',partialResult:'abcdef'})
  expect(state.tools.a.result).toBe('abcdef')
  state=reduceEvent(state,{type:'tool_execution_end',toolCallId:'a',result:'failed',isError:true})
  expect(state.tools.a.running).toBe(false);expect(state.tools.a.isError).toBe(true)
 })
 test('hydration attaches historical tool results without showing duplicate assistant messages',()=>{
  const state=hydrate([{role:'user',content:'test'},{role:'assistant',content:[{type:'toolCall',id:'call',name:'read'}]},{role:'toolResult',toolCallId:'call',toolName:'read',content:[{type:'text',text:'file'}]}])
  expect(state.messages).toHaveLength(2);expect(state.tools.call.result).toBe('file')
 })
 test('projects large structured tool results to bounded display text',()=>{
  const hugeDetails={outline:{root:{children:Array.from({length:10_000},(_,index)=>({title:`node-${index}`}))}}}
  const result={content:[{type:'text',text:'observe_ui completed'}],details:hugeDetails}
  expect(toolResultText(result)).toBe('observe_ui completed')
  let state=reduceEvent(emptyTranscript(),{type:'tool_execution_end',toolCallId:'ui',toolName:'observe_ui',result})
  expect(state.tools.ui.result).toBe('observe_ui completed')
  expect(state.tools.ui.details).toBeUndefined()
  state=hydrate([{role:'assistant',content:[{type:'toolCall',id:'ui',name:'observe_ui'}]},{role:'toolResult',toolCallId:'ui',toolName:'observe_ui',content:[{type:'text',text:'done'}],details:hugeDetails}])
  expect(state.tools.ui.result).toBe('done')
  expect(state.tools.ui.details).toBeUndefined()
 })
 test('retains only bounded edit patches for code diff rendering',()=>{
  const patch='--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b'
  let state=reduceEvent(emptyTranscript(),{type:'tool_execution_end',toolCallId:'edit',toolName:'edit',result:{content:[{type:'text',text:'done'}],details:{patch,diff:'display only'}}})
  expect(state.tools.edit).toMatchObject({result:'done',details:{patch}})
  state=reduceEvent(state,{type:'message_end',message:{role:'toolResult',toolCallId:'edit',toolName:'edit',content:[{type:'text',text:'done'}]}})
  expect(state.tools.edit.details).toEqual({patch})
  state=hydrate([{role:'assistant',content:[{type:'toolCall',id:'edit',name:'edit'}]},{role:'toolResult',toolCallId:'edit',toolName:'edit',content:[{type:'text',text:'done'}],details:{patch}}])
  expect(state.tools.edit.details).toEqual({patch})
 })
})
test('bash and compaction records normalize without exposing hidden custom messages',()=>{
 const state=hydrate([{role:'bashExecution',command:'pwd',output:'/tmp'},{role:'compactionSummary',summary:'summary'},{role:'custom',display:false,content:'hidden'}])
 expect(state.messages).toHaveLength(2)
 expect(state.messages[0].message.content).toContain('/tmp')
 expect(state.messages[1].message.content).toBe('summary')
})
test('tool activity summaries use the actual Pi tool names',()=>{
 expect(summarizeToolCalls(['read','rg','bash','edit','write'])).toBe('读取 1 次 · 搜索 1 次 · 运行 1 次 · 编辑 2 次')
 expect(summarizeToolCalls(['gui_task'])).toBe('操作 1 次')
})
test('consecutive assistant fragments render as one logical turn',()=>{
 const messages=[
  {id:'user',message:{role:'user',content:'inspect'}},
  {id:'thought-1',message:{role:'assistant',content:[{type:'thinking',thinking:'first'},{type:'toolCall',id:'read-1',name:'read'}]}},
  {id:'thought-2',message:{role:'assistant',content:[{type:'thinking',thinking:'second'},{type:'toolCall',id:'run-1',name:'bash'}]}},
  {id:'answer',message:{role:'assistant',content:[{type:'text',text:'done'}]}},
  {id:'next-user',message:{role:'user',content:'next'}},
 ]
 const groups=groupDisplayMessages(messages)
 expect(groups).toHaveLength(3)
 expect(groups[1].items.map(item=>item.id)).toEqual(['thought-1','thought-2','answer'])
 expect(groups[1].indexes).toEqual([1,2,3])
 expect(turnDurationId(groups[1].items)).toBe('tool:read-1')
})
test('turn duration ids survive live-to-history message id changes',()=>{
 const live={id:'live-4-1',message:{role:'assistant',timestamp:1789546873294,content:[{type:'thinking',thinking:'work'}]}}
 const history={...live,id:'history-4-1789546873294'}
 expect(turnDurationId([live])).toBe('timestamp:1789546873294')
 expect(turnDurationId([history])).toBe(turnDurationId([live]))
})
describe('turn timer ownership across steer splits',()=>{
 const turn=1_790_000_000_000
 test('shows 正在处理 only on the topmost segment of a steered turn',()=>{
  // 19:40 那条 steer：第一段 + steer 出来的第二段共享同一个 startedAt。
  const groups=[{startedAt:turn},{startedAt:undefined},{startedAt:turn}]
  expect(assignTurnClocks(groups,{running:true,turnStartedAt:turn})).toEqual(['live',undefined,'hidden'])
 })
 test('never repeats 正在处理 on later segments of the same turn',()=>{
  const groups=[{startedAt:turn},{startedAt:turn},{startedAt:turn}]
  expect(assignTurnClocks(groups,{running:true,turnStartedAt:turn})).toEqual(['live','hidden','hidden'])
 })
 test('keeps the settled duration on the topmost segment too',()=>{
  // 运行时把 elapsedMs 写在轮次首段，刚好就是保留 live 的那一段。
  const groups=[{startedAt:turn,elapsedMs:52_000},{startedAt:turn},{startedAt:turn}]
  expect(assignTurnClocks(groups,{running:false,turnStartedAt:null})).toEqual([undefined,'hidden','hidden'])
 })
 test('leaves ordinary single-segment turns unchanged',()=>{
  expect(assignTurnClocks([{startedAt:turn}],{running:true,turnStartedAt:turn})).toEqual(['live'])
  expect(assignTurnClocks([{startedAt:turn}],{running:false,turnStartedAt:null})).toEqual([undefined])
 })
 test('starts no timer before the running turn produced a segment',()=>{
  expect(assignTurnClocks([{startedAt:turn}],{running:true,turnStartedAt:turn+1})).toEqual([undefined])
 })
})
describe('streaming delta delivery',()=>{
 // Rust 会把连发的 message_update / tool_execution_update 攒成一批再发（bridge.rs
 // 的 PiEventBatch），JS 侧只是逐条 dispatch。这里锁住"分批投递 == 逐条投递"这个
 // 前提：reduceEvent 是纯 fold，批只是一次多投几条，结果必须逐字节一致。
 const deltas=[0,1,2,3,4,5,6,7].map(index=>({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:String(index)}}))
 test('folding a batch matches folding events one by one',()=>{
  const start=()=>reduceEvent(emptyTranscript(),{type:'message_start',message:{role:'assistant',content:[],timestamp:1}})
  const oneByOne=deltas.reduce(reduceEvent,start())
  const batched=[deltas.slice(0,3),deltas.slice(3,5),deltas.slice(5)].reduce((transcript,batch)=>batch.reduce(reduceEvent,transcript),start())
  // 只比消息内容：message_start 给 assistant 打的 startedAt 是运行时时钟，
  // 两次折叠可能差一毫秒，不属于"分批是否等价"这件事。
  const content=(transcript:ReturnType<typeof reduceEvent>)=>transcript.messages.map(({message})=>({message}))
  expect(content(batched)).toEqual(content(oneByOne))
  expect(batched.active).toBe(oneByOne.active)
 })
 test('a batch preserves the interleaved order of thinking and text deltas',()=>{
  const events=[
   {type:'message_start',message:{role:'assistant',content:[],timestamp:2}},
   {type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'想'}},
   {type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:1,delta:'答'}},
   {type:'message_update',assistantMessageEvent:{type:'thinking_delta',contentIndex:0,delta:'了'}},
   {type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:1,delta:'案'}},
   {type:'message_end',message:{role:'assistant',content:[{type:'text',text:'答案'}],stopReason:'stop'}},
  ]
  const sequential=events.reduce(reduceEvent,emptyTranscript())
  const batched=[[events[0]],[events[1],events[2],events[3],events[4]],[events[5]]].reduce((transcript,batch)=>batch.reduce(reduceEvent,transcript),emptyTranscript())
  const content=(transcript:ReturnType<typeof reduceEvent>)=>transcript.messages.map(({message})=>({message}))
  expect(content(batched)).toEqual(content(sequential))
 })
 test('image tool results keep their media for the chat renderer',()=>{
  const result={content:[{type:'text',text:'已生成 1 张图片'},{type:'image',data:'AAAA',mimeType:'image/jpeg'}]}
  const running=reduceEvent(emptyTranscript(),{type:'tool_execution_start',toolCallId:'c1',toolName:'generate_image',args:{prompt:'一只猫'}})
  const done=reduceEvent(running,{type:'tool_execution_end',toolCallId:'c1',toolName:'generate_image',result})
  expect(done.tools.c1.images).toEqual([{data:'AAAA',mimeType:'image/jpeg'}])
  const hydrated=hydrate([{role:'toolResult',toolCallId:'c1',toolName:'generate_image',content:result.content}])
  expect(hydrated.tools.c1.images).toEqual([{data:'AAAA',mimeType:'image/jpeg'}])
 })
 test('toolResultImages ignores non-image content and reads nested content arrays',()=>{
  expect(toolResultImages('plain')).toEqual([])
  expect(toolResultImages({content:[{type:'text',text:'x'}]})).toEqual([])
  expect(toolResultImages([{type:'image',data:'CC'}])).toEqual([])
  expect(toolResultImages([{type:'image',data:'BB',mimeType:'image/webp'}])).toEqual([{data:'BB',mimeType:'image/webp'}])
 })
})

describe('reuseGroups',()=>{
 const msg=(id:string,role:'user'|'assistant')=>({id,message:{role,content:id}})
 test('未变化的历史组复用旧对象，变化的组用新对象，结果与直接分组一致',()=>{
  const a=msg('a','user'),b=msg('b','assistant'),c=msg('c','user'),d=msg('d','assistant')
  const first=groupDisplayMessages([a,b,c,d])
  const d2={...d,message:{...d.message,content:'d2'}}
  const next=groupDisplayMessages([a,b,c,d2])
  const reused=reuseGroups(first,next)
  expect(reused).toEqual(next)
  expect(reused[0]).toBe(first[0]);expect(reused[1]).toBe(first[1]);expect(reused[2]).toBe(first[2])
  expect(reused[3]).toBe(next[3]);expect(reused[3]).not.toBe(first[3])
 })
 test('新增消息并入末组时该组不复用',()=>{
  const a=msg('a','user'),b=msg('b','assistant'),b2=msg('b2','assistant')
  const first=groupDisplayMessages([a,b])
  const reused=reuseGroups(first,groupDisplayMessages([a,b,b2]))
  expect(reused[0]).toBe(first[0]);expect(reused[1].items).toHaveLength(2)
 })
})
