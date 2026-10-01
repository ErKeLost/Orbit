import {describe,test,expect} from 'bun:test'
import {assignTurnClocks,emptyTranscript,groupDisplayMessages,reduceEvent,hydrate,toolResultText} from '../src/lib/protocol'
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
  // 只比消息内容：message_start 会给 assistant 打一个 Date.now() 的 startedAt，
  // 那是运行时时钟，不属于"分批是否等价"这件事。
  expect(batched.messages).toEqual(oneByOne.messages)
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
  expect(batched.messages).toEqual(sequential.messages)
 })
})
