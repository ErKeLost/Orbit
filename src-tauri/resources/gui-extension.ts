import {dirname,join} from 'node:path'
import {mkdirSync,realpathSync,writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {pathToFileURL} from 'node:url'
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, McpServerConfig, ModelRouteRequest, ToolInfo } from '@earendil-works/pi-coding-agent'
import {registerSubagentTools,SUBAGENT_TOOL_NAMES} from './subagents/index.ts'
import {registerWorkspace} from './workspace.ts'
import {COMPUTER_USE_TOOL_NAMES,registerComputerUseMode} from './computer-use/mode.ts'
import {providerToolChars} from './context-payload.ts'
// Pi official docs/extensions.md: registerCommand, getAllTools, setActiveTools,
// ExtensionCommandContext.navigateTree and setLabel. Loaded only by this GUI.
export const SESSION_META_TYPE='pi-gui-session-meta'
export const SESSION_ICONS=['code','bug','palette','magnifying-glass','book-open','terminal-window','globe','image-square','film-strip','music-notes','database','translate','list-checks','calendar-blank','rocket-launch','lightbulb','chats','chat-teardrop-text'] as const
const COMPUTER_USE_TOOLS=new Set<string>(COMPUTER_USE_TOOL_NAMES)
type SessionIcon=(typeof SESSION_ICONS)[number]
export function parseSessionMetadata(raw:string):{title:string;icon:SessionIcon}|null{
  const match=raw.match(/\{[\s\S]*\}/)
  if(!match)return null
  try{
    const value=JSON.parse(match[0]) as {title?:unknown;icon?:unknown}
    const title=typeof value.title==='string'?Array.from(value.title.replace(/\s+/g,' ').trim()).slice(0,24).join(''):''
    if(!title)return null
    const icon=typeof value.icon==='string'&&SESSION_ICONS.includes(value.icon as SessionIcon)?value.icon as SessionIcon:'chat-teardrop-text'
    return {title,icon}
  }catch{return null}
}
export function applyGuiToolSelection(requested:string[],active:string[]):string[]{
  return [...new Set([...requested.filter(name=>!COMPUTER_USE_TOOLS.has(name)),...active.filter(name=>COMPUTER_USE_TOOLS.has(name))])]
}
function toolChars(tool: ToolInfo) {
  return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length
}
function contextBreakdown(pi: ExtensionAPI, providerChars: number | undefined) {
  const active = new Set(pi.getActiveTools())
  return {
    toolChars: providerChars ?? pi.getAllTools().filter(tool => active.has(tool.name)).reduce((total, tool) => total + toolChars(tool), 0),
  }
}
function sessionText(ctx:ExtensionCommandContext){
  return ctx.sessionManager.getEntries().flatMap(entry=>{
    if(entry.type!=='message'||!['user','assistant'].includes(entry.message.role))return []
    const content=typeof entry.message.content==='string'?entry.message.content:entry.message.content.flatMap(part=>'text'in part&&typeof part.text==='string'?[part.text]:[]).join(' ')
    const text=content.replace(/\s+/g,' ').trim()
    return text?[`${entry.message.role}: ${text}`]:[]
  }).join('\n').slice(-6000)
}
// ---------------------------------------------------------------------------
// Pi 1.0 capability surface. MCP servers, codemode, tool search, image and
// classifier models, and virtual (routing) models are all opaque to the RPC
// protocol, so the GUI reads them through these commands instead.
// ---------------------------------------------------------------------------
export const CAPABILITIES_STATUS='gui-capabilities'
export const MCP_STATUS='gui-mcp'
export const MEDIA_STATUS='gui-media'
export const VIRTUAL_MODEL_STATUS='gui-virtual-models'
export const CACHE_STATUS='gui-cache'
export const SESSION_NAME_STATUS='gui-session-name'
export const VIRTUAL_MODEL_API_ID='pi-virtual'
export const MEDIA_DIR=join(homedir(),'.pi/agent/orbit-media')
const MCP_NAMESPACE_PREFIX='mcp__'
export type MediaModelInfo={provider:string;id:string;name?:string;available:boolean}
export type McpServerInfo={name:string;source:'extension'|'mcp.json';transport:'stdio'|'http'|'unknown';exposure?:string;description?:string;enabled?:boolean;tools:string[];extensionPath?:string}
export type RouteRule={match?:{reason?:string[];model?:string[];thinkingLevel?:string[]};model:{provider:string;id:string;thinkingLevel?:string}}
export type GuiVirtualModelInput={provider:string;id:string;name:string;thinkingLevels?:string[];contextWindow?:number;maxTokens?:number;sticky?:boolean;rules:RouteRule[]}
export type GuiCapabilities=ReturnType<typeof capabilities>
function safe<T>(produce:()=>T,fallback:T):T{try{return produce()}catch{return fallback}}
/** MCP tool names are `mcp__<server>__<tool>`; the namespace carries the server. */
export function mcpNamespace(tool:Pick<ToolInfo,'name'|'namespace'>):string|undefined{
  if(tool.namespace?.name?.startsWith(MCP_NAMESPACE_PREFIX))return tool.namespace.name
  if(!tool.name.startsWith(MCP_NAMESPACE_PREFIX))return undefined
  const [,server]=tool.name.split('__')
  return server?`${MCP_NAMESPACE_PREFIX}${server}`:undefined
}
/** Servers registered by extensions plus every server that exposed tools. */
export function collectMcpServers(pi:ExtensionAPI):McpServerInfo[]{
  const servers=new Map<string,McpServerInfo>()
  for(const server of safe(()=>pi.getMcpServers(),[])){
    const config=server.config as {command?:string;url?:string;enabled?:boolean;exposure?:string;description?:string}
    servers.set(`${MCP_NAMESPACE_PREFIX}${server.name}`,{name:server.name,source:'extension',transport:config.command?'stdio':config.url?'http':'unknown',exposure:config.exposure,description:config.description,enabled:config.enabled!==false,tools:[],extensionPath:server.extensionPath})
  }
  for(const tool of pi.getAllTools()){
    const namespace=mcpNamespace(tool)
    if(!namespace)continue
    const entry=servers.get(namespace)??{name:namespace.slice(MCP_NAMESPACE_PREFIX.length),source:'mcp.json' as const,transport:'unknown' as const,tools:[]}
    entry.tools.push(tool.name)
    servers.set(namespace,entry)
  }
  return [...servers.values()].sort((left,right)=>left.name.localeCompare(right.name))
}
function modelTypeInventory(ctx:ExtensionContext,type:'image'|'classifier'):MediaModelInfo[]{
  return safe(()=>ctx.modelRegistry.getModelsOfType(type).map(model=>({provider:model.provider,id:model.id,name:'name' in model&&typeof model.name==='string'?model.name:undefined,available:ctx.modelRegistry.hasConfiguredAuth(model as never)})),[])
}
function virtualModelInventory(ctx:ExtensionContext){
  return safe(()=>ctx.modelRegistry.getAll().filter(model=>model.api===VIRTUAL_MODEL_API_ID).map(model=>({provider:model.provider,id:model.id,name:model.name,thinkingLevels:model.thinkingLevels??[]})),[])
}
function capabilities(pi:ExtensionAPI,ctx:ExtensionContext){
  const tools=pi.getAllTools(),active=new Set(pi.getActiveTools()),settings=safe(()=>pi.getSettings(),undefined)
  const exposure:Record<string,number>={}
  for(const tool of tools)exposure[tool.exposure]=(exposure[tool.exposure]??0)+1
  const mcp=collectMcpServers(pi)
  const image=modelTypeInventory(ctx,'image'),classifier=modelTypeInventory(ctx,'classifier')
  return {
    tools:{total:tools.length,active:active.size,exposure,codemode:tools.some(tool=>tool.name==='codemode'),toolSearch:tools.some(tool=>tool.name==='tool_search'),mcpTools:mcp.reduce((total,server)=>total+server.tools.length,0)},
    mcp,
    media:{image,classifier},
    virtualModels:virtualModelInventory(ctx),
    settings:settings?{cacheWarming:settings.cacheWarming??null,codemode:settings.codemode??null,defaultTools:settings.defaultTools??null,extensions:settings.extensions??null}:null,
  }
}
export function routeMatches(rule:RouteRule,reason:string,thinkingLevel:string,previousModelId?:string):boolean{
  const match=rule.match
  if(!match)return true
  if(match.reason&&!match.reason.includes(reason))return false
  if(match.thinkingLevel&&!match.thinkingLevel.includes(thinkingLevel))return false
  if(match.model&&(!previousModelId||!match.model.includes(previousModelId)))return false
  return true
}
/** Data-driven router: the GUI describes physical targets, Pi calls `route()` per request. */
export function registerGuiVirtualModel(pi:ExtensionAPI,input:GuiVirtualModelInput):{provider:string;id:string}{
  if(!input?.provider||!input?.id||!input?.name)throw new Error('虚拟模型需要 provider、id 和 name')
  if(!Array.isArray(input.rules)||!input.rules.length)throw new Error('虚拟模型至少需要一条路由规则')
  if(input.rules.some(rule=>!rule?.model?.provider||!rule.model.id))throw new Error('每条路由规则都需要 model.provider 和 model.id')
  const levels=(input.thinkingLevels?.length?input.thinkingLevels:['off'])
  pi.registerVirtualModel({
    provider:input.provider,id:input.id,name:input.name,
    thinkingLevels:levels as never,
    ...(input.contextWindow?{contextWindow:input.contextWindow}:{}),
    ...(input.maxTokens?{maxTokens:input.maxTokens}:{}),
    route(request:ModelRouteRequest,ctx:ExtensionContext){
      const sticky=request.failed??request.previous
      // Continuations and retries stay on the model that handled the turn so the
      // prompt cache and thinking signatures survive.
      if(input.sticky!==false&&request.reason!=='user'&&sticky)return {model:sticky.model,thinkingLevel:(sticky.thinkingLevel??'medium') as never}
      const thinkingLevel=String(request.thinkingLevel??'off')
      const rule=input.rules.find(candidate=>routeMatches(candidate,String(request.reason),thinkingLevel,sticky?.model.id))
      if(!rule)throw new Error(`虚拟模型 ${input.provider}/${input.id} 没有匹配 ${request.reason}/${thinkingLevel} 的路由规则`)
      const model=ctx.modelRegistry.find(rule.model.provider,rule.model.id)
      if(!model)throw new Error(`虚拟模型 ${input.provider}/${input.id} 找不到物理模型 ${rule.model.provider}/${rule.model.id}`)
      return {model,thinkingLevel:(rule.model.thinkingLevel??'medium') as never}
    },
  })
  return {provider:input.provider,id:input.id}
}
export function writeMediaFile(dataBase64:string,index:number):string{
  mkdirSync(MEDIA_DIR,{recursive:true})
  const path=join(MEDIA_DIR,`image-${Date.now()}-${index+1}.png`)
  writeFileSync(path,Buffer.from(dataBase64,'base64'))
  return path
}
export default async function (pi: ExtensionAPI) {
  let latestProviderToolChars: number | undefined
  registerSubagentTools(pi)
  registerWorkspace(pi)
  pi.on('before_provider_request',event=>{latestProviderToolChars=providerToolChars(event.payload)})
  const {SettingsManager}=await import(pathToFileURL(join(dirname(realpathSync(process.argv[1])),'index.js')).href)
  pi.registerCommand('gui-observe',{description:'GUI: observe session configuration',handler:async(_args,ctx)=>{
    const settings=SettingsManager.create(ctx.cwd,undefined,{projectTrusted:ctx.isProjectTrusted()})
    ctx.ui.setStatus('gui-runtime',JSON.stringify({compaction:settings.getCompactionSettings(),retry:settings.getRetrySettings(),providerRetry:settings.getProviderRetrySettings(),transport:settings.getTransport(),thinkingBudgets:settings.getThinkingBudgets(),projectTrusted:ctx.isProjectTrusted(),contextUsage:ctx.getContextUsage(),systemPrompt:ctx.getSystemPrompt(),breakdown:contextBreakdown(pi,latestProviderToolChars),scopedModels:ctx.scopedModels.map(item=>({model:item.model.id,provider:item.model.provider,thinkingLevel:item.thinkingLevel})),idle:ctx.isIdle(),pending:ctx.hasPendingMessages()}))
  }})
  const publishTools = (ctx: ExtensionCommandContext) => { const active=new Set(pi.getActiveTools()); ctx.ui.setStatus('gui-tools', JSON.stringify({
    active: pi.getActiveTools(),
    tools: pi.getAllTools().filter(tool=>!COMPUTER_USE_TOOLS.has(tool.name)).map((tool) => ({name:tool.name,description:tool.description,exposure:tool.exposure,namespace:tool.namespace?.name,active:active.has(tool.name)})),
  })) };
  const publishCapabilities = (ctx: ExtensionContext) => ctx.ui.setStatus(CAPABILITIES_STATUS, JSON.stringify(capabilities(pi,ctx)));
  const publishMcp = (ctx: ExtensionContext) => { const servers=collectMcpServers(pi); ctx.ui.setStatus(MCP_STATUS,JSON.stringify({servers})); return servers };
  const publishMedia = (ctx: ExtensionContext) => { const image=modelTypeInventory(ctx,'image'),classifier=modelTypeInventory(ctx,'classifier'); ctx.ui.setStatus(MEDIA_STATUS,JSON.stringify({image,classifier})); return {image,classifier} };
  registerComputerUseMode(pi, publishTools)
  pi.registerCommand('gui-tools', {description:'GUI: list available tools',handler:async (_args: string,ctx: ExtensionCommandContext) => publishTools(ctx)});
  pi.registerCommand('gui-tools-set', {description:'GUI: change active tools',handler:async (args: string,ctx: ExtensionCommandContext) => {
    await ctx.waitForIdle(); const names=JSON.parse(args);
    if(!Array.isArray(names)||names.some((name:unknown)=>typeof name!=='string'))throw new Error('Expected tool names');
    pi.setActiveTools(applyGuiToolSelection(names,pi.getActiveTools()));publishTools(ctx);
  }});
  pi.registerCommand('gui-agent-mode',{description:'GUI: enable or disable dynamic child agents',handler:async(args:string,ctx:ExtensionCommandContext)=>{
    const value=JSON.parse(args||'{}') as {enabled?:unknown};if(typeof value.enabled!=='boolean')throw new Error('Expected enabled boolean')
    const collaboration=new Set<string>(SUBAGENT_TOOL_NAMES),active=new Set(pi.getActiveTools())
    for(const name of collaboration){if(value.enabled)active.add(name);else active.delete(name)}
    pi.setActiveTools([...active]);ctx.ui.setStatus('gui-agent-mode',value.enabled?'enabled':'disabled');publishTools(ctx)
  }})
  pi.registerCommand('gui-tree', {description:'GUI: navigate a session branch',handler:async (args: string,ctx: ExtensionCommandContext) => {
    await ctx.waitForIdle();const target=JSON.parse(args);const result=await ctx.navigateTree(target.id,{summarize:target.summarize ?? false,customInstructions:target.customInstructions,replaceInstructions:target.replaceInstructions,label:target.label});
    if(result.cancelled)ctx.ui.notify('扩展取消了分支切换','warning');
    if(result.editorText)ctx.ui.setEditorText(result.editorText);
  }});
  pi.registerCommand('gui-label', {description:'GUI: label a session entry',handler:async (args: string,ctx: ExtensionCommandContext) => {const {id,label}=JSON.parse(args);ctx.setLabel(id,label||undefined);}});
  pi.registerCommand('gui-capabilities',{description:'GUI: report Pi 1.0 capabilities (MCP, codemode, tool search, media, virtual models)',handler:async(_args:string,ctx:ExtensionCommandContext)=>{publishCapabilities(ctx);publishMcp(ctx);publishMedia(ctx);ctx.ui.setStatus(VIRTUAL_MODEL_STATUS,JSON.stringify({virtualModels:virtualModelInventory(ctx)}))}})
  pi.registerCommand('gui-mcp',{description:'GUI: list, register, or remove MCP servers',handler:async(args:string,ctx:ExtensionCommandContext)=>{
    const value=JSON.parse(args||'{}') as {action?:string;name?:string;config?:McpServerConfig}
    const action=value.action??'list'
    if(action==='add'){
      if(!value.name||!value.config)throw new Error('添加 MCP 服务器需要 name 和 config')
      pi.registerMcpServer(value.name,value.config)
    }else if(action==='remove'){
      if(!value.name)throw new Error('移除 MCP 服务器需要 name')
      pi.unregisterMcpServer(value.name)
    }else if(action!=='list')throw new Error(`未知的 MCP 操作 ${action}`)
    publishMcp(ctx);publishCapabilities(ctx)
  }})
  pi.registerCommand('gui-virtual-model',{description:'GUI: list, register, or remove routing (virtual) models',handler:async(args:string,ctx:ExtensionCommandContext)=>{
    const value=JSON.parse(args||'{}') as {action?:string;input?:GuiVirtualModelInput;provider?:string;id?:string}
    const action=value.action??'list'
    if(action==='register'){
      if(!value.input)throw new Error('注册虚拟模型需要 input')
      registerGuiVirtualModel(pi,value.input)
    }else if(action==='remove'){
      if(!value.provider||!value.id)throw new Error('移除虚拟模型需要 provider 和 id')
      pi.unregisterVirtualModel(value.provider,value.id)
    }else if(action!=='list')throw new Error(`未知的虚拟模型操作 ${action}`)
    ctx.ui.setStatus(VIRTUAL_MODEL_STATUS,JSON.stringify({virtualModels:virtualModelInventory(ctx)}));publishCapabilities(ctx)
  }})
  pi.registerCommand('gui-media',{description:'GUI: list image and classifier models, generate images, run classifiers',handler:async(args:string,ctx:ExtensionCommandContext)=>{
    const value=JSON.parse(args||'{}') as {action?:string;provider?:string;id?:string;prompt?:string;text?:string;question?:string;criteria?:Record<string,string>}
    const action=value.action??'list'
    if(action==='list'){publishMedia(ctx);return}
    const pick=<T extends {provider:string;id:string}>(models:readonly T[]):T=>{
      const wanted=value.provider&&value.id?models.find(model=>model.provider===value.provider&&model.id===value.id):undefined
      const model=wanted??models[0]
      if(!model)throw new Error(value.provider?`没有可用的 ${value.provider}/${value.id} 模型`:'没有可用的模型或凭据')
      return model
    }
    if(action==='image'){
      if(!value.prompt?.trim())throw new Error('生成图片需要 prompt')
      const model=pick(ctx.modelRegistry.getModelsOfType('image'))
      const result=await ctx.modelRegistry.generateImages(model,{input:[{type:'text',text:value.prompt}]})
      if(result.stopReason!=='stop')throw new Error(result.errorMessage||`图片生成失败（${result.stopReason}）`)
      const paths=result.output.flatMap((part,index)=>part.type==='image'&&'data' in part&&part.data?[writeMediaFile(part.data,index)]:[])
      if(!paths.length)throw new Error('模型没有返回图片')
      ctx.ui.setStatus(MEDIA_STATUS,JSON.stringify({image:modelTypeInventory(ctx,'image'),classifier:modelTypeInventory(ctx,'classifier'),generated:{model:`${result.provider}/${result.model}`,paths,usage:result.usage??null}}))
      ctx.ui.notify(`图片已保存：${paths.join('、')}`,'info');return
    }
    if(action==='classify'){
      if(!value.text?.trim())throw new Error('分类需要 text')
      const criteria=value.criteria??{'是':'符合判断条件','否':'不符合判断条件'}
      const model=pick(ctx.modelRegistry.getModelsOfType('classifier'))
      const result=await ctx.modelRegistry.classify(model,{state:{text:value.text},questions:{answer:{type:'choice',instructions:value.question??'判断这段内容属于哪一类。',criteria}}})
      ctx.ui.setStatus(MEDIA_STATUS,JSON.stringify({image:modelTypeInventory(ctx,'image'),classifier:modelTypeInventory(ctx,'classifier'),classified:{model:`${result.provider}/${result.model}`,answers:result.answers,usage:result.usage??null}}))
      ctx.ui.notify(`分类结果：${JSON.stringify(result.answers)}`,'info');return
    }
    throw new Error(`未知的媒体操作 ${action}`)
  }})
  pi.on('session_start',async(_event,ctx)=>publishCapabilities(ctx))
  pi.on('mcp_servers_change',async(_event,ctx)=>{publishMcp(ctx);publishCapabilities(ctx)})
  pi.on('session_info_changed',async(event,ctx)=>ctx.ui.setStatus(SESSION_NAME_STATUS,JSON.stringify({name:event.name??null})))
  pi.on('cache_warming_decision',async(event,ctx)=>ctx.ui.setStatus(CACHE_STATUS,JSON.stringify({action:event.action,warmCost:event.warmCost,missCost:event.missCost,continuationProbability:event.continuationProbability})))
  pi.registerCommand('gui-session-meta',{description:'GUI: generate durable session title and icon',handler:async(_args:string,ctx:ExtensionCommandContext)=>{
    try{
      const existing=ctx.sessionManager.getEntries().find(entry=>entry.type==='custom'&&entry.customType===SESSION_META_TYPE)
      if(existing||!ctx.model)return
      const conversation=sessionText(ctx)
      if(!conversation)return
      const icons=SESSION_ICONS.join(', ')
      const response=await ctx.modelRegistry.complete(ctx.model,{systemPrompt:`Create compact metadata for a coding-agent conversation. Return JSON only: {"title":"...","icon":"..."}. The title must be specific, in the conversation language, and at most 24 characters. Choose exactly one icon from: ${icons}.`,messages:[{role:'user',content:[{type:'text',text:conversation}],timestamp:Date.now()}]},{maxTokens:100,cacheRetention:'none'})
      const text=response.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('')
      const meta=parseSessionMetadata(text)
      if(!meta)return
      const title=ctx.sessionManager.getSessionName()||meta.title
      pi.setSessionName(title)
      pi.appendEntry(SESSION_META_TYPE,{version:1,title,icon:meta.icon})
    }catch{/* Session replacement or provider failures fall back to the default icon. */}
  }})
}
