import {dirname,extname,join,resolve} from 'node:path'
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs'
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
    media:{image,classifier,imageOptions:imageOptionsFromSettings()},
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
export function writeMediaFile(dataBase64:string,index:number,mimeType:string):string{
  mkdirSync(MEDIA_DIR,{recursive:true})
  const path=join(MEDIA_DIR,`image-${Date.now()}-${index+1}.${mimeType==='image/png'?'png':'jpg'}`)
  writeFileSync(path,Buffer.from(dataBase64,'base64'))
  return path
}
/** The provider `gui-extension.ts` registers when nothing is configured.
 *
 * Ark speaks the plain OpenAI images endpoint. Pi ships only the OpenRouter
 * image API, so this is registered here as an extension provider and Pi resolves
 * the key from `auth.json` like it does for every other provider. */
export const ARK_IMAGE_PROVIDER={id:'volcengine',name:'火山方舟',baseUrl:'https://ark.cn-beijing.volces.com/api/v3'}
export const ARK_IMAGE_MODELS=[{id:'doubao-seedream-5-0-flash-260915',name:'Seedream 5.0 Flash'},{id:'doubao-seedream-5-0-260128',name:'Seedream 5.0 Lite'},{id:'doubao-seedream-4-5-251128',name:'Seedream 4.5'},{id:'doubao-seedream-4-0-20260415',name:'Seedream 4.0'}]
export const DEFAULT_IMAGE_RESOLUTION='2K'
/** Ark preset sizes per resolution and aspect ratio. The model picks the ratio
 * itself when no aspect is requested, so a bare resolution is also valid. */
export const ARK_IMAGE_SIZES:Record<string,Record<string,string>>={
  '1K':{'1:1':'1024x1024','4:3':'1152x864','3:4':'864x1152','16:9':'1280x720','9:16':'720x1280','3:2':'1248x832','2:3':'832x1248','21:9':'1512x648'},
  '2K':{'1:1':'2048x2048','4:3':'2304x1728','3:4':'1728x2304','16:9':'2848x1600','9:16':'1600x2848','3:2':'2496x1664','2:3':'1664x2496','21:9':'3136x1344'},
  '3K':{'1:1':'3072x3072','4:3':'3456x2592','3:4':'2592x3456','16:9':'4096x2304','9:16':'2304x4096','3:2':'3744x2496','2:3':'2496x3744','21:9':'4704x2016'},
  '4K':{'1:1':'4096x4096','4:3':'4704x3520','3:4':'3520x4704','16:9':'5504x3040','9:16':'3040x5504','3:2':'4992x3328','2:3':'3328x4992','21:9':'6240x2656'},
}

/**
 * Everything the image tool runs against, after the stored config is merged over
 * the built-in Ark defaults.
 *
 * Pi's own provider config cannot describe an image model at all — its model
 * schema has no `type` discriminant — so the endpoint, its models and its size
 * presets are stored in `~/.pi/agent/image.json` (`src-tauri/src/image_config.rs`
 * validates and writes it) and merged here. Every key of that file is optional,
 * which is what makes an unconfigured install behave exactly as it did before
 * the file could name a provider.
 */
/**
 * 一种生成能力的规格。参数项的值可以不是字面量，而是「从哪来」：
 * `sizes` 取该模型自己的尺寸表，`catalog` 取该 kind 的模型列表。
 */
export type MediaParamSpec={
  from?:'sizes'|'catalog'
  type?:'string'|'integer'|'number'|'boolean'
  enum?:string[]
  min?:number
  max?:number
  default?:unknown
  description?:string
}

export type MediaKindSpec={
  label?:string
  /** 调用怎么发，不是生成什么。`sync` 直接回字节；`async-task` 起任务再轮询。 */
  recipe:'sync'|'async-task'
  output?:{ext?:string;dir?:string}
  params:Record<string,MediaParamSpec>
}

export type ImageSettings={
  provider:{id:string;name:string;baseUrl:string}
  models:{
    id:string
    name?:string
    /** 这个模型自己的尺寸表。缺省退回全局 `sizes` —— 「不同模型不一样」落在数据上。 */
    sizes?:Record<string,Record<string,string>>
    /** 这个模型自己的额外参数。端点没有「参数 schema」这个概念，所以只能配。 */
    params?:Record<string,MediaParamSpec>
    /** 端点说的能力（`task_type`）：TextToImage / ImageToImage / … */
    taskTypes?:string[]
    /** 端点说的状态：Retiring / Shutdown。Shutdown 的不进工具 schema。 */
    status?:string
  }[]
  sizes:Record<string,Record<string,string>>
  defaults:{model?:string;resolution:string;aspect?:string}
  /** 能力表。缺省时退回内置的 `image` 一条，所以老配置行为不变。 */
  kinds:Record<string,MediaKindSpec>
}

const isProviderId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9._-]{1,64}$/.test(value)
const isUrl=(value:unknown):value is string=>typeof value==='string'&&/^https?:\/\/[^\s]+$/.test(value)
const text=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value.trim():undefined

/**
 * Resolve what the tool runs against. Pure, so the merge is testable without a
 * file, a provider or a network.
 *
 * The forgiving parts are deliberate. A default that names a model the list no
 * longer has is dropped rather than kept and failed on at generation time: the
 * config is edited by hand as well as by a form, and a stale default is a
 * smaller problem than an error in the middle of a request.
 */
function parseStringArray(value:unknown):string[]|undefined{
  if(!Array.isArray(value))return undefined
  const items=value.filter((item):item is string=>typeof item==='string')
  return items.length?items:undefined
}

/** 尺寸表：`{ "2K": { "16:9": "2848x1600" } }`。空表返回 `{}`，调用方决定退回什么。 */
function parseSizes(value:unknown):Record<string,Record<string,string>>{
  if(!value||typeof value!=='object')return {}
  const out:Record<string,Record<string,string>>={}
  for(const [resolution,aspects] of Object.entries(value as Record<string,unknown>)){
    if(!aspects||typeof aspects!=='object')continue
    const map:Record<string,string>={}
    for(const [aspect,size] of Object.entries(aspects as Record<string,unknown>)){
      const value=text(size)
      if(value)map[aspect]=value
    }
    if(Object.keys(map).length)out[resolution]=map
  }
  return out
}

function parseParams(value:unknown):Record<string,MediaParamSpec>{
  if(!value||typeof value!=='object')return {}
  const out:Record<string,MediaParamSpec>={}
  for(const [name,item] of Object.entries(value as Record<string,unknown>)){
    if(!item||typeof item!=='object')continue
    const raw=item as Record<string,unknown>
    const clean:MediaParamSpec={}
    if(raw.from==='sizes'||raw.from==='catalog')clean.from=raw.from
    if(['string','integer','number','boolean'].includes(String(raw.type)))clean.type=raw.type as MediaParamSpec['type']
    const values=parseStringArray(raw.enum)
    if(values)clean.enum=values
    if(typeof raw.min==='number')clean.min=raw.min
    if(typeof raw.max==='number')clean.max=raw.max
    if('default' in raw)clean.default=raw.default
    if(typeof raw.description==='string')clean.description=raw.description
    out[name]=clean
  }
  return out
}

export function resolveImageSettings(stored:unknown):ImageSettings{
  const raw=(stored&&typeof stored==='object'?stored:{}) as Record<string,unknown>
  const provider=(raw.provider&&typeof raw.provider==='object'?raw.provider:{}) as Record<string,unknown>
  const defaults=(raw.defaults&&typeof raw.defaults==='object'?raw.defaults:{}) as Record<string,unknown>
  const models:ImageSettings['models']=Array.isArray(raw.models)
    ? raw.models.flatMap((entry)=>{
        const item=(entry&&typeof entry==='object'?entry:{}) as Record<string,unknown>
        const id=text(item.id)
        if(!id)return []
        const own=parseSizes(item.sizes)
        const params=parseParams(item.params)
        const taskTypes=parseStringArray(item.taskTypes)
        const status=text(item.status)
        return [{
          id,
          ...(text(item.name)?{name:text(item.name)}:{}),
          ...(Object.keys(own).length?{sizes:own}:{}),
          ...(Object.keys(params).length?{params}:{}),
          ...(taskTypes?{taskTypes}:{}),
          ...(status?{status}:{}),
        }]
      })
    : []
  const parsedKinds=parseKinds(raw.kinds)
  const sizes=parseSizes(raw.sizes)
  const effective:ImageSettings={
    provider:{
      id:isProviderId(provider.id)?provider.id:ARK_IMAGE_PROVIDER.id,
      name:text(provider.name)??ARK_IMAGE_PROVIDER.name,
      baseUrl:(isUrl(provider.baseUrl)?provider.baseUrl:ARK_IMAGE_PROVIDER.baseUrl).replace(/\/+$/,''),
    },
    models:models.length?models:ARK_IMAGE_MODELS,
    sizes:Object.keys(sizes).length?sizes:ARK_IMAGE_SIZES,
    defaults:{resolution:DEFAULT_IMAGE_RESOLUTION},
    kinds:Object.keys(parsedKinds).length?parsedKinds:BUILTIN_KINDS,
  }
  // The flat keys are what this file held before it could name a provider, and
  // what the settings page wrote until it grew the nested form. Nested wins.
  const wantedModel=text(defaults.model)??text(raw.model)
  const wantedResolution=text(defaults.resolution)??text(raw.resolution)
  const wantedAspect=text(defaults.aspect)??text(raw.aspect)
  if(wantedModel&&effective.models.some(model=>model.id===wantedModel))effective.defaults.model=wantedModel
  // 默认值必须落在**默认模型**的表里，不是全局表里 —— 换到一个分辨率更少的模型之后
  // 原来的默认值会变成非法的，留着它就等于每次调用都报错。
  //
  // 顺序是这整段的关键：取表和收敛都必须在 `defaults.model` 定下来**之后**。早一步
  // 读到的就是全局表，于是收敛看着通过、其实一次都没生效。
  const table=paramsFor(effective,'image',effective.defaults.model)
  const resolutions=Object.keys(table)
  const resolution=resolutions.includes(wantedResolution??'')?wantedResolution!:(resolutions.includes(DEFAULT_IMAGE_RESOLUTION)?DEFAULT_IMAGE_RESOLUTION:resolutions[0]!)
  effective.defaults.resolution=resolution
  if(wantedAspect&&Object.hasOwn(table[resolution]??{},wantedAspect))effective.defaults.aspect=wantedAspect
  return effective
}

/** 没配 `kinds` 时的内置能力表 —— 一条，和这个功能只有图片时的行为逐字一致。 */
export const BUILTIN_KINDS:Record<string,MediaKindSpec>={
  image:{
    label:'图片',
    recipe:'sync',
    output:{ext:'png',dir:'orbit-media'},
    params:{
      model:{from:'catalog',default:''},
      resolution:{from:'sizes',default:DEFAULT_IMAGE_RESOLUTION},
      aspect:{from:'sizes',default:''},
    },
  },
}

const RECIPES=['sync','async-task'] as const

function parseKinds(value:unknown):Record<string,MediaKindSpec>{
  if(!value||typeof value!=='object')return {}
  const out:Record<string,MediaKindSpec>={}
  for(const [kind,raw] of Object.entries(value as Record<string,unknown>)){
    if(!raw||typeof raw!=='object')continue
    const spec=raw as Record<string,unknown>
    const recipe=typeof spec.recipe==='string'&&(RECIPES as readonly string[]).includes(spec.recipe)
      ? spec.recipe as MediaKindSpec['recipe']
      : null
    if(!recipe)continue
    const params:Record<string,MediaParamSpec>={}
    if(spec.params&&typeof spec.params==='object'){
      for(const [name,item] of Object.entries(spec.params as Record<string,unknown>)){
        if(!item||typeof item!=='object')continue
        const raw=item as Record<string,unknown>
        const clean:MediaParamSpec={}
        if(raw.from==='sizes'||raw.from==='catalog')clean.from=raw.from
        if(['string','integer','number','boolean'].includes(String(raw.type)))clean.type=raw.type as MediaParamSpec['type']
        if(Array.isArray(raw.enum))clean.enum=raw.enum.filter((v):v is string=>typeof v==='string')
        if(typeof raw.min==='number')clean.min=raw.min
        if(typeof raw.max==='number')clean.max=raw.max
        if('default' in raw)clean.default=raw.default
        if(typeof raw.description==='string')clean.description=raw.description
        params[name]=clean
      }
    }
    const output=spec.output&&typeof spec.output==='object'?spec.output as Record<string,unknown>:{}
    out[kind]={
      ...(typeof spec.label==='string'&&spec.label.trim()?{label:spec.label.trim()}:{}),
      recipe,
      ...(typeof output.ext==='string'||typeof output.dir==='string'
        ?{output:{...(typeof output.ext==='string'?{ext:output.ext}:{}),...(typeof output.dir==='string'?{dir:output.dir}:{})}}
        :{}),
      params,
    }
  }
  return out
}

const IMAGE_CONFIG_PATH=join(homedir(),'.pi/agent/image.json')
/** Preferences written by 设置 → Pi 1.0 能力 → 图片模型. */
function readImageSettings():ImageSettings{
  try{return resolveImageSettings(JSON.parse(readFileSync(IMAGE_CONFIG_PATH,'utf8')))}
  catch{return resolveImageSettings(null)}
}

/** Ark takes reference images as lowercase data URLs, up to 14 per request. */
const REFERENCE_MIME:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'}
const REFERENCE_MAX_BYTES=10*1024*1024
function referenceImage(path:string,cwd:string){
  const file=resolve(cwd,path)
  const mimeType=REFERENCE_MIME[extname(file).slice(1).toLowerCase()]
  if(!mimeType)throw new Error(`参考图只支持 PNG / JPEG / WebP：${path}`)
  const bytes=readFileSync(file)
  if(bytes.byteLength>REFERENCE_MAX_BYTES)throw new Error(`参考图超过 10MB：${path}`)
  return {type:'image' as const,data:bytes.toString('base64'),mimeType}
}

/**
 * The one request an OpenAI-images endpoint is asked for.
 *
 * Pure, and that is the point: the URL, the body and how a reference image rides
 * along are the parts that fail silently against a new endpoint, so they are
 * pinned by tests instead of only exercised by a real call.
 */
export function imageGenerationRequest(settings:ImageSettings,id:string,parts:{type:string;text?:string;data?:string;mimeType?:string}[],size:unknown){
  const prompt=parts.filter(part=>part.type==='text').map(part=>part.text??'').join('\n').trim()
  // Reference images ride along as data URLs; the endpoint reads them as the
  // source image, which is what makes image-to-image work instead of plain
  // text-to-image.
  const image=parts.filter(part=>part.type==='image'&&part.data).map(part=>`data:${part.mimeType};base64,${part.data}`)
  const body:Record<string,unknown>={model:id,prompt,response_format:'b64_json',size:typeof size==='string'&&size?size:settings.defaults.resolution,watermark:false}
  if(image.length)body.image=image
  return {url:`${settings.provider.baseUrl}/images/generations`,body}
}

async function generateImages(model:any,context:any,options:any){
  // The model carries the endpoint Pi composed for it; the setting is the
  // fallback for a call that reaches us without one.
  const settings=readImageSettings()
  const withModel:ImageSettings=typeof model?.baseUrl==='string'&&model.baseUrl?{...settings,provider:{...settings.provider,baseUrl:model.baseUrl.replace(/\/+$/,'')}}:settings
  const {url,body}=imageGenerationRequest(withModel,model.id,context?.input??[],options?.metadata?.size)
  const response=await (options?.fetch??fetch)(url,{
    method:'POST',
    headers:{Authorization:`Bearer ${options?.apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify(body),
    signal:options?.signal,
  })
  const payload=await response.json() as {data?:{b64_json:string;output_format:string}[];error?:{message?:string}}
  if(!response.ok)throw new Error(payload?.error?.message??`图片端点返回 ${response.status}`)
  const first=payload.data?.[0]
  if(!first?.b64_json)throw new Error('图片端点没有返回图片数据')
  const mimeType=first.output_format==='png'?'image/png':'image/jpeg'
  return {api:model.api,provider:model.provider,model:model.id,output:[{type:'image',data:first.b64_json,mimeType}],stopReason:'stop',timestamp:Date.now()}
}

/** The resolution and aspect choices the settings page offers.
 *
 * Reported from the same resolved settings the tool uses, so the page can never
 * offer a resolution the endpoint has no preset for.
 */
/**
 * 一个 kind 在某个模型上的尺寸表。
 *
 * 「不同模型不一样」落地的唯一地方：模型自己有就用自己的，没有就退回全局。
 * `kind` 目前只用来找 `kinds[kind].params` 里 `from:'sizes'` 的项 —— 也就是说
 * **哪种能力用尺寸表是数据说的**，不是这个函数知道的。
 */
export function paramsFor(settings:ImageSettings,kind:string,modelId?:string):Record<string,Record<string,string>>{
  const spec=settings.kinds[kind]
  const usesSizes=spec?Object.values(spec.params).some(param=>param.from==='sizes'):true
  if(!usesSizes)return {}
  const model=modelId?settings.models.find(entry=>entry.id===modelId):undefined
  return model?.sizes&&Object.keys(model.sizes).length?model.sizes:settings.sizes
}

/** 端点说已下线的模型不进工具 schema —— 让模型去选一个调不通的东西是纯损失。 */
function liveModels(settings:ImageSettings){
  const live=settings.models.filter(model=>model.status!=='Shutdown')
  return live.length?live:settings.models
}

/** 这个模型能不能吃参考图。端点没说（取不到 task_type）时按「能」处理：少一个能力
 * 比多一个明确报错的参数更糟。 */
function supportsReference(model?:ImageSettings['models'][number]){
  if(!model?.taskTypes?.length)return true
  return model.taskTypes.some(task=>task==='ImageToImage'||task==='MultimodalToImage'||task==='ImageEditing')
}

/**
 * 一个 kind 在某个模型上的选项。设置页的下拉和工具 schema 共用这一处 —— 所以页面
 * 不可能提供一个端点没有的档位，工具也不可能。
 */
export function optionsFor(settings:ImageSettings,kind:string,modelId?:string){
  const sizes=paramsFor(settings,kind,modelId)
  const resolutions=Object.keys(sizes)
  return {resolutions,aspects:[...new Set(resolutions.flatMap(resolution=>Object.keys(sizes[resolution]??{})))]}
}

/** 兼容旧调用点：默认模型自己的表，不再是全局表。 */
export function imageOptionsFromSettings(settings:ImageSettings=readImageSettings()){
  return optionsFor(settings,'image',settings.defaults.model)
}

function paramHint(model:ImageSettings['models'][number]|undefined,spec:MediaKindSpec){
  const names=Object.keys(model?.params??{}).length?model!.params!:spec.params
  const entries=Object.entries(names??{})
  if(!entries.length)return ''
  return `该模型还支持 options：${entries.map(([key,item])=>{
    const shape=item.enum?item.enum.join('|'):(item.type??'string')
    const range=item.min!==undefined||item.max!==undefined?`（${item.min??''}~${item.max??''}）`:''
    return `${key}: ${shape}${range}${item.description?` — ${item.description}`:''}`
  }).join('；')}。`
}

/**
 * The tool schema for one capability, built from whatever the config resolved to.
 *
 * 一个工具只能有一个扁平 schema —— 模型间差异无法用条件 schema 表达（`oneOf` /
 * `if-then` 在 OpenAI strict mode 被直接拒）。所以这里的取舍是：**schema 按当前默认
 * 模型生成**（常见路径精确），而显式换模型时由 `execute` 按那个模型校验并明确报错。
 *
 * 函数名里没有 "image"：它只认 `kind`。
 */
export function toolSchemaFor(settings:ImageSettings,kind:string){
  const spec=settings.kinds[kind]
  if(!spec)throw new Error(`没有这种能力：${kind}`)
  const models=liveModels(settings)
  const target=settings.defaults.model??models[0]?.id
  const model=models.find(entry=>entry.id===target)??models[0]
  const usesCatalog=Object.values(spec.params).some(param=>param.from==='catalog')
  const usesSizes=Object.values(spec.params).some(param=>param.from==='sizes')
  const {resolutions,aspects}=optionsFor(settings,kind,model?.id)
  const properties:Record<string,unknown>={}
  for(const [name,param] of Object.entries(spec.params)){
    if(name==='model'&&usesCatalog){
      properties.model={type:'string',enum:models.map(entry=>entry.id),description:`可选模型 id，默认 ${model?.id??''}。换模型后其余选项会随之变化。`}
      continue
    }
    if((name==='resolution'||name==='aspect')&&usesSizes){
      const table=name==='resolution'?resolutions:aspects
      properties[name]={type:'string',enum:table,description:`${name==='resolution'?'分辨率':'画幅比例'}，默认 ${param.default??''}。仅当前模型支持的档位。`}
      continue
    }
    if(param.enum)properties[name]={type:'string',enum:param.enum,...(param.description?{description:param.description}:{})}
    else if(param.type)properties[name]={type:param.type==='integer'?'number':param.type,...(param.description?{description:param.description}:{})}
  }
  const canReference=supportsReference(model)
  if(canReference)properties.references={type:'array',items:{type:'string'},minItems:1,maxItems:14,description:'可选：本地参考图路径（相对项目或绝对路径，最多 14 张）。传了就按参考图生成/修改。'}
  return {
    type:'object',
    properties:{
      prompt:{type:'string',description:spec.label?`${spec.label}描述，越具体越好。`:'描述，越具体越好。'},
      ...properties,
      ...(paramHint(model,spec)?{options:{type:'object',additionalProperties:true,description:`模型专属参数。${paramHint(model,spec)}`}}:{}),
    },
    required:['prompt'],
    additionalProperties:false,
  } as const
}

/** 一个参数值是否符合它声明的形状。返回错误文案，或 `null` 表示通过。 */
function checkParam(name:string,value:unknown,spec:MediaParamSpec):string|null{
  if(spec.enum&&!spec.enum.includes(String(value)))return `参数 ${name} 只能是 ${spec.enum.join(' / ')}，收到 ${JSON.stringify(value)}`
  if(spec.type==='integer'&&!Number.isInteger(value))return `参数 ${name} 必须是整数，收到 ${JSON.stringify(value)}`
  if(spec.type==='number'&&typeof value!=='number')return `参数 ${name} 必须是数字，收到 ${JSON.stringify(value)}`
  if(spec.type==='boolean'&&typeof value!=='boolean')return `参数 ${name} 必须是布尔值，收到 ${JSON.stringify(value)}`
  if(spec.type==='string'&&typeof value!=='string')return `参数 ${name} 必须是字符串，收到 ${JSON.stringify(value)}`
  if(typeof value==='number'){
    if(spec.min!==undefined&&value<spec.min)return `参数 ${name} 不能小于 ${spec.min}`
    if(spec.max!==undefined&&value>spec.max)return `参数 ${name} 不能大于 ${spec.max}`
  }
  return null
}

/**
 * 按「实际要用的那个模型」校验，而不是按 schema 生成时用的那个。
 *
 * 这是这一层存在的全部理由：schema 是启动时按默认模型算的，而一次调用可以从
 * `model` 参数换到另一个模型。以前这些情况会**静默兜底**（尺寸查不到就退回分辨率
 * 名，用户拿到一张画幅不对的图且不知道为什么）；现在它们明确报错。
 */
export function validateCall(settings:ImageSettings,kind:string,modelId:string,input:{resolution?:string;aspect?:string;options?:Record<string,unknown>}){
  const model=settings.models.find(entry=>entry.id===modelId)
  if(!model)return `配置里没有模型 ${modelId}`
  const sizes=paramsFor(settings,kind,modelId)
  const resolutions=Object.keys(sizes)
  if(input.resolution&&!resolutions.includes(input.resolution)){
    return `模型 ${modelId} 不支持分辨率 ${input.resolution}。支持：${resolutions.join(' / ')||'（无）'}`
  }
  const resolution=input.resolution??settings.defaults.resolution
  const aspect=input.aspect&&input.aspect!==''?input.aspect:undefined
  if(aspect&&!Object.hasOwn(sizes[resolution]??{},aspect)){
    return `模型 ${modelId} 在 ${resolution} 下不支持画幅 ${aspect}。支持：${Object.keys(sizes[resolution]??{}).join(' / ')||'（无）'}`
  }
  // 两种 params 是两个不同的东西，校验要看合并后的：
  //   kinds.<kind>.params  这种能力**要**什么（接口）
  //   models[].params      这个模型**额外**支持什么，并覆盖接口上的默认约束
  // 只看模型那份，`duration` 这种「能力要的」会被误判成「模型不支持」。
  const declared={...(settings.kinds[kind]?.params??{}),...(model.params??{})}
  for(const [key,value] of Object.entries(input.options??{})){
    if(value===undefined)continue
    const spec=declared[key]
    if(!spec)return `模型 ${modelId} 不支持参数 ${key}。支持：${Object.keys(declared).join(' / ')||'（无）'}`
    const problem=checkParam(key,value,spec)
    if(problem)return problem
  }
  return null
}

const MODELS_CONFIG_PATH=join(homedir(),'.pi/agent/models.json')
const AUTH_CONFIG_PATH=join(homedir(),'.pi/agent/auth.json')

function readJsonFile(path:string):unknown{
  try{return JSON.parse(readFileSync(path,'utf8'))}catch{return null}
}

/**
 * 每一个「值得问一次它有没有出图模型」的 provider。
 *
 * 从 Pi 自己的配置里读，因为那是 provider 的唯一真相 —— `image.json` 只描述默认那一个。
 * 你说的「Tare 里那 5 个图片模型」，它们之所以现在看不见，就是因为 `Tare` 从没被注册成
 * 一个 image 类型的 provider；而 `models.json` 里有它。
 *
 * `hasKey` 决定要不要问：没有凭据的 provider，`/models` 只会回 401，白跑一趟还可能
 * 拖慢启动。凭据本身不读出来（`auth.json` 只用来判断存在），因为它由 Pi 在请求时解。
 *
 * 纯函数，所以 provider 列表可以拿真实配置直接钉。
 */
export function imageProvidersFrom(modelsConfig:unknown,authConfig:unknown){
  const models=(modelsConfig&&typeof modelsConfig==='object'?modelsConfig:{}) as Record<string,unknown>
  const providers=(models.providers&&typeof models.providers==='object'?models.providers:{}) as Record<string,unknown>
  const auth=(authConfig&&typeof authConfig==='object'?authConfig:{}) as Record<string,unknown>
  const baseUrlOf=(entry:unknown)=>(entry&&typeof entry==='object'?(entry as Record<string,unknown>).baseUrl:undefined)
  const out:{id:string;name?:string;baseUrl?:string;api?:string;hasKey:boolean}[]=[]
  for(const [id,entry] of Object.entries(providers)){
    if(!isProviderId(id))continue
    const url=baseUrlOf(entry)
    // 没有 baseUrl 就没有可问的端点；Pi 自己的内置 provider 不在这个文件里。
    if(!isUrl(url))continue
    const key=id.trim().toLowerCase()
    const hasKey=Object.keys(auth).some(name=>name.trim().toLowerCase()===key)
    const spec=(entry&&typeof entry==='object'?entry:{}) as Record<string,unknown>
    out.push({
      id,
      ...(text(spec.name)?{name:text(spec.name)}:{}),
      baseUrl:url.replace(/\/+$/,''),
      ...(text(spec.api)?{api:text(spec.api)}:{}),
      hasKey,
    })
  }
  return out.sort((left,right)=>left.id.localeCompare(right.id))
}

/**
 * 从端点自己的模型目录里挑出「输出图片」的那些，并转成 Pi 的模型条目。
 *
 * 判据按可靠性排序，因为不同家给的东西不一样：
 *   1. `modalities.output_modalities` —— Ark 和 OpenRouter 都有，最准
 *   2. 顶层的 `output_modalities` —— 有些中转站这么给
 *   3. `domain === 'ImageGeneration'` —— Ark 的分类字段
 * 三者都没有就**不收**。按模型 id 猜（`-image`、`gpt-image`）看着聪明，但它会把
 * 一个恰好叫这名字的对话模型收进来，而那种错误到调用时才暴露。
 *
 * `Shutdown` 的丢掉：`/models` 会把下线模型一起返回（Ark 那 135 条里只有 52 条在售），
 * 让它们进 schema 只是给模型多几个必然失败的选项。
 *
 * 纯函数：没有网络、没有文件，所以端点返回的形状可以直接拿真实目录来钉。
 */
export function imageModelsFromCatalog(items:unknown[],providerId:string){
  const output:unknown[]=[];
  const seen=new Set<string>();
  for(const item of items){
    if(!item||typeof item!=='object')continue
    const entry=item as Record<string,unknown>
    const id=text(entry.id)
    if(!id||seen.has(id))continue
    if(text(entry.status)==='Shutdown')continue
    const modalities=(entry.modalities&&typeof entry.modalities==='object'?entry.modalities:{}) as Record<string,unknown>
    const declared=parseStringArray(modalities.output_modalities)??parseStringArray(entry.output_modalities)
    const isImage=declared?declared.includes('image'):entry.domain==='ImageGeneration'
    if(!isImage)continue
    const inputs=parseStringArray(modalities.input_modalities)??parseStringArray(entry.input_modalities)??['text']
    seen.add(id)
    output.push({
      id,
      ...(text(entry.name)?{name:text(entry.name)}:{}),
      provider:providerId,
      type:'image' as const,
      api:'openai-images',
      input:(inputs.includes('image')?['text','image']:['text']) as ('text'|'image')[],
      output:['image'] as ('text'|'image')[],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
    })
  }
  return output;
}

/**
 * 注册每一种已配置的能力。**循环 `kinds`，函数里没有 "image" 这个字面量。**
 *
 * 所以「加视频」= 往配置里加一条 `kinds.video`。这也是为什么注册要放在一个循环里，
 * 而不是每个能力一个 `registerXxx`。
 */
export function registerImages(pi:ExtensionAPI):void{
  const settings=readImageSettings()
  const models=liveModels(settings)
  pi.registerProvider(settings.provider.id,{
    name:settings.provider.name,
    baseUrl:settings.provider.baseUrl,
    api:'openai-images',
    authHeader:true,
    images:{'openai-images':{generateImages}},
    models:models.map(model=>({
      id:model.id,
      ...(model.name?{name:model.name}:{}),
      type:'image' as const,
      api:'openai-images',
      input:['text','image'] as ('text'|'image')[],
      output:['image'] as ('text'|'image')[],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
    })),
  })
  for(const [kind,spec] of Object.entries(settings.kinds)){
    if(!models.length)continue
    pi.registerTool({
      name:`generate_${kind}`,
      label:`生成${spec.label??kind}`,
      description:`用 ${settings.provider.name} 生成${spec.label??kind}，并把结果直接返回给用户。传 references 时按参考图生成。`,
      promptGuidelines:[`用户要求${spec.label??kind}、插画、海报、图标、配图时，直接用 generate_${kind} 并传入详细的 prompt；不要为此使用 codemode。`,`换 model 前先看该模型支持的参数；传了它不支持的组合会明确报错，不要重试同一个组合。`],
      parameters:toolSchemaFor(settings,kind),
      async execute(_toolCallId:string,params:unknown,signal:AbortSignal|undefined,_onUpdate:unknown,ctx:any){
        const input=params as {prompt:string;model?:string;resolution?:string;aspect?:string;references?:string[];options?:Record<string,unknown>}
        if(spec.recipe!=='sync')throw new Error(`能力 ${kind} 用的是 ${spec.recipe} 调用，其实现尚未接入`)
        const effective=readImageSettings()
        const available=await ctx.modelRegistry.getAvailableOfType('image') as {provider:string;id:string}[]
        const wanted=input.model??effective.defaults.model
        const model=wanted?available.find(candidate=>candidate.id===wanted):available[0]
        if(!model)throw new Error(wanted?`没有可用的模型 ${wanted}`:'没有可用的模型')
        // 先按「实际要用的模型」校验，再发请求 —— 静默兜底换成明确报错的那一步。
        const problem=validateCall(effective,kind,model.id,{resolution:input.resolution,aspect:input.aspect,options:input.options})
        if(problem)throw new Error(problem)
        const sizes=paramsFor(effective,kind,model.id)
        const resolution=input.resolution??effective.defaults.resolution
        const aspect=input.aspect&&input.aspect!==''?input.aspect:undefined
        const size=aspect?sizes[resolution]?.[aspect]:resolution
        const parts=[{type:'text' as const,text:input.prompt},...(input.references??[]).map(path=>referenceImage(path,ctx.cwd))]
        const result=await ctx.modelRegistry.generateImages(model,{input:parts},{signal,metadata:{size}})
        if(result.stopReason!=='stop')throw new Error(result.errorMessage??'生成失败')
        const images=(result.output as {type:string;data:string;mimeType:string}[]).filter(part=>part.type==='image')
        if(!images.length)throw new Error('模型没有返回图片')
        const paths=images.map((part,index)=>writeMediaFile(part.data,index,part.mimeType))
        return {
          content:[...images.map(part=>({type:'image' as const,data:part.data,mimeType:part.mimeType})),{type:'text' as const,text:`已生成 ${paths.length} 张图片：${paths.join('、')}`}],
          details:{kind,model:`${model.provider}/${model.id}`,prompt:input.prompt,resolution,aspect:aspect??null,size,paths,references:input.references??[],options:input.options??null},
        }
      },
    })
  }
}

export default async function (pi: ExtensionAPI) {
  let latestProviderToolChars: number | undefined
  registerSubagentTools(pi)
  registerWorkspace(pi)
  registerImages(pi)
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
      const paths=result.output.flatMap((part,index)=>part.type==='image'&&'data' in part&&part.data?[writeMediaFile(part.data,index,part.mimeType)]:[])
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
