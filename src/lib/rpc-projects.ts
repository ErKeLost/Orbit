import { invoke } from "./native";
import { useWorkspace } from "./store";
import { runRemoteHostOperation } from "./remote-runtime";
import { request } from "./rpc-core";
import { mobileRuntime, native, workspaceBackend } from "./runtime";

/** Rust commands that are not connection state: providers, models, MCP,
 *  settings, image and speech configuration, computer-use. */
export type ProviderModel={
  id:string
  name?:string
  type?:string
  context_window?:number
  max_output_tokens?:number
  input_modalities?:string[]
  output_modalities?:string[]
  reasoning?:boolean
  thinking_levels?:Record<string,string>
  pricing?:Record<string,number>
  raw?:Record<string,unknown>
}
export type ProviderProfile={id:string;name?:string;baseUrl?:string;modelsUrl?:string;api?:string;authHeader?:boolean;isDefault:boolean;defaultModel?:string;models?:ProviderModel[];hasApiKey:boolean;modelCount:number}
export async function listProviderModels(provider:string):Promise<{data:ProviderModel[]}> { if(!workspaceBackend()) throw new Error('模型目录设置请在电脑端修改'); return invoke<{data:ProviderModel[]}>('list_provider_models',{provider}) }
export async function listProjectFiles(project=useWorkspace.getState().cwd):Promise<string[]> { if(mobileRuntime())return runRemoteHostOperation<string[]>({name:'project.files',cwd:project});if(!native)throw new Error('文件索引需要桌面应用');return invoke<string[]>('list_project_files',{cwd:project}) }
export async function listProviderProfiles():Promise<ProviderProfile[]> { if(!workspaceBackend()) throw new Error('Provider 配置请在电脑端修改'); return invoke<ProviderProfile[]>('list_provider_profiles') }
export async function probeProviderModels(provider:string,baseUrl:string,api:string,apiKey?:string,authHeader=true,modelsUrl?:string):Promise<{data:ProviderModel[]}> { if(!workspaceBackend()) throw new Error('模型目录设置请在电脑端修改'); return invoke<{data:ProviderModel[]}>('probe_provider_models',{provider,baseUrl,api,apiKey:apiKey||null,authHeader,modelsUrl:modelsUrl||null}) }
export async function saveProvider(input:{provider:string;name?:string;baseUrl:string;modelsUrl?:string;api:string;apiKey?:string;authHeader:boolean}):Promise<{id:string;hasApiKey:boolean}> { if(!workspaceBackend()) throw new Error('Provider 配置请在电脑端修改'); return invoke<{id:string;hasApiKey:boolean}>('save_provider',{provider:input.provider,name:input.name||null,baseUrl:input.baseUrl,modelsUrl:input.modelsUrl||null,api:input.api,apiKey:input.apiKey||null,authHeader:input.authHeader}) }
export async function deleteProvider(provider:string):Promise<{id:string;deleted:boolean}> { if(!workspaceBackend()) throw new Error('Provider 配置请在电脑端修改'); return invoke<{id:string;deleted:boolean}>('delete_provider',{provider}) }
export async function syncProviderModels(provider:string):Promise<{provider:string;count:number;previous:number;firstModelId?:string}> { if(!workspaceBackend()) throw new Error('同步模型请在电脑端执行'); return invoke<{provider:string;count:number;previous:number;firstModelId?:string}>('sync_provider_models',{provider}) }
export async function persistDefaultModel(provider:string,modelId:string):Promise<{provider:string;id:string}> { if(!workspaceBackend()) throw new Error('默认模型请在电脑端设置'); return invoke<{provider:string;id:string}>('set_default_model',{provider,modelId}) }
export type ProjectTrustMode = 'ask' | 'always' | 'never'
export async function getProjectTrustMode():Promise<ProjectTrustMode> { if(!workspaceBackend()) throw new Error('项目权限请在电脑端设置'); return invoke<ProjectTrustMode>('get_project_trust_mode') }
// --- MCP servers (Pi 1.0) -------------------------------------------------
// Pi reads `~/.pi/agent/mcp.json`; the GUI edits that file through Rust and
// reads live connection state through the `gui-mcp` capability status.
export type McpServerView={name:string;transport:'stdio'|'http'|'invalid';command:string|null;args:string[];url:string|null;envKeys:string[];headerKeys:string[];enabled:boolean;exposure:string|null;description:string|null;timeout:number|null}
export type McpServerList={path:string;servers:McpServerView[];authenticated:string[]}
export async function listMcpServers():Promise<McpServerList> { if(!workspaceBackend()) throw new Error('MCP 服务器请在电脑端管理'); return invoke<McpServerList>('list_mcp_servers') }
export async function saveMcpServer(name:string,config:Record<string,unknown>):Promise<McpServerView> { if(!workspaceBackend()) throw new Error('MCP 服务器请在电脑端管理'); return invoke<McpServerView>('save_mcp_server',{name,config}) }
export async function deleteMcpServer(name:string):Promise<{name:string;deleted:boolean}> { if(!workspaceBackend()) throw new Error('MCP 服务器请在电脑端管理'); return invoke<{name:string;deleted:boolean}>('delete_mcp_server',{name}) }
export async function mcpConfigLocation():Promise<{path:string;authPath:string;logPath:string}> { if(!workspaceBackend()) throw new Error('MCP 配置路径需要电脑端'); return invoke<{path:string;authPath:string;logPath:string}>('mcp_config_location') }
/** Pi 1.0 settings Orbit can write: `cacheWarming` and `codemode`. */
export type GuiSettings={path:string;settings:{cacheWarming:string|null;codemode:{mode?:'on'|'only';inlineBudget?:number}|null}}
export async function getGuiSettings():Promise<GuiSettings> { if(!workspaceBackend()) throw new Error('Pi 设置请在电脑端修改'); return invoke<GuiSettings>('get_gui_settings') }
export async function setGuiSetting(key:'cacheWarming'|'codemode',value:unknown):Promise<{key:string;value:unknown}> { if(!workspaceBackend()) throw new Error('Pi 设置请在电脑端修改'); return invoke<{key:string;value:unknown}>('set_gui_setting',{key,value}) }
/** Ask the GUI extension to recompute and republish its capability snapshots. */
export async function refreshCapabilities(target=useWorkspace.getState().cwd){await request({type:'prompt',message:'/gui-capabilities'},30000,target)}
/** Session-scoped MCP registration through the built-in MCP extension. */
export async function registerSessionMcpServer(name:string,config:Record<string,unknown>,target=useWorkspace.getState().cwd){return request({type:'prompt',message:`/gui-mcp ${JSON.stringify({action:'add',name,config})}`},30000,target)}
export async function unregisterSessionMcpServer(name:string,target=useWorkspace.getState().cwd){return request({type:'prompt',message:`/gui-mcp ${JSON.stringify({action:'remove',name})}`},30000,target)}
export async function setProjectTrustMode(mode:ProjectTrustMode):Promise<ProjectTrustMode> { if(!workspaceBackend()) throw new Error('项目权限请在电脑端设置'); return invoke<ProjectTrustMode>('set_project_trust_mode',{mode}) }
export async function computerUseKeyStatus():Promise<{hasKey:boolean}> { if(!workspaceBackend()) throw new Error('Jev Key 请在电脑端设置'); return invoke<{hasKey:boolean}>('computer_use_key_status') }
export async function saveComputerUseKey(apiKey?:string):Promise<{hasKey:boolean}> { if(!workspaceBackend()) throw new Error('Jev Key 请在电脑端设置'); return invoke<{hasKey:boolean}>('save_computer_use_key',{apiKey:apiKey?.trim()||null}) }
export type ComputerUseModel='jev'|'clef-flash'
export type ComputerUseConfig={decisionModel:ComputerUseModel;cloudflareAccountId:string;systemoneBaseUrl:string;keys:{jev:boolean;cloudflare:boolean}}
export type ComputerUseTestResult={ok:boolean;provider:string;model:string;latencyMs:number;answer:Record<string,unknown>|null;usage:{input_tokens?:number;output_tokens?:number}|null}
export async function computerUseConfig():Promise<ComputerUseConfig> { if(!workspaceBackend()) throw new Error('电脑操作请在电脑端设置'); return invoke<ComputerUseConfig>('computer_use_config') }
export async function saveComputerUseConfig(patch:Partial<Pick<ComputerUseConfig,'decisionModel'|'cloudflareAccountId'|'systemoneBaseUrl'>>):Promise<ComputerUseConfig> { if(!workspaceBackend()) throw new Error('电脑操作请在电脑端设置'); return invoke<ComputerUseConfig>('save_computer_use_config',{config:patch}) }
export async function saveComputerUseCloudflareToken(token?:string):Promise<{hasToken:boolean}> { if(!workspaceBackend()) throw new Error('Cloudflare Token 请在电脑端设置'); return invoke<{hasToken:boolean}>('save_computer_use_cloudflare_token',{token:token?.trim()||null}) }
export async function testComputerUseDecision():Promise<ComputerUseTestResult> { if(!workspaceBackend()) throw new Error('电脑操作请在电脑端设置'); return invoke<ComputerUseTestResult>('test_computer_use_decision') }
/**
 * The image-generation endpoint, as the extension resolves it.
 *
 * Pi's own provider config cannot describe an image model — its model schema has
 * no `type` discriminant — so this file is where the endpoint, its models and its
 * size presets live, and `gui-extension.ts` merges it over the built-in Ark
 * defaults. Every key other than the derived ones is optional, and an absent key
 * means "use the built-in", which is why an unconfigured install still works.
 */
/**
 * One capability's parameter. `from` 说的是值从哪来：`sizes` 取该模型自己的尺寸表，
 * `catalog` 取该 kind 的模型列表。没有 `from` 就是一个字面量枚举或数值。
 */
export type ImageConfigParam = {
  from?: "sizes" | "catalog"
  type?: "string" | "integer" | "number" | "boolean"
  enum?: string[]
  min?: number
  max?: number
  default?: unknown
  description?: string
}

/**
 * 一种生成能力。`recipe` 说的是**这次调用怎么发**，不是生成什么：`sync` 直接回字节，
 * `async-task` 起任务再轮询。`enabled` 缺省为开 —— 关掉的能力不注册工具。
 */
export type ImageConfigKind = {
  label?: string
  enabled?: boolean
  recipe?: string
  output?: { ext?: string; dir?: string }
  params?: Record<string, ImageConfigParam>
}

export type ImageConfig = {
  provider?: { id: string; name?: string; baseUrl?: string }
  models?: { id: string; name?: string; sizes?: Record<string, Record<string, string>>; params?: Record<string, ImageConfigParam>; taskTypes?: string[]; status?: string }[]
  sizes?: Record<string, Record<string, string>>
  defaults?: { model?: string; resolution?: string; aspect?: string }
  /** 能力表。缺省时扩展退回内置的一条 `image`。 */
  kinds?: Record<string, ImageConfigKind>
  /** Whether the file says anything at all. */
  configured: boolean
  /** Whether Pi can resolve a key for the configured (or built-in) provider. */
  hasApiKey: boolean
  /** The provider used when the file names none. */
  defaultProviderId: string
}
/**
 * A patch, not a replacement: an absent key keeps what is stored and `null`
 * clears it, so changing the default model cannot delete the endpoint beside it.
 */
export type ImageConfigPatch = {
  provider?: ImageConfig["provider"] | null
  models?: ImageConfig["models"] | null
  sizes?: ImageConfig["sizes"] | null
  defaults?: ImageConfig["defaults"] | null
  kinds?: ImageConfig["kinds"] | null
  /** The flat single-default form the settings page sends. */
  model?: string
  resolution?: string
  aspect?: string
}
export async function imageConfig():Promise<ImageConfig> { if(!workspaceBackend()) throw new Error('图片模型请在电脑端设置'); return invoke<ImageConfig>('image_config') }
export async function saveImageConfig(patch:ImageConfigPatch):Promise<ImageConfig> { if(!workspaceBackend()) throw new Error('图片模型请在电脑端设置'); return invoke<ImageConfig>('save_image_config',{config:patch}) }
/** The key goes to Pi's auth.json under the provider id, like every other key. */
export async function saveImageApiKey(provider:string,apiKey:string|null):Promise<{provider:string;hasApiKey:boolean}> { if(!workspaceBackend()) throw new Error('图片密钥请在电脑端设置'); return invoke('save_image_api_key',{provider,apiKey}) }

export type SpeechConfig={
  transport?:'volcengine-speech'|'openai-compat'
  appid?:string
  provider?:string
  baseUrl?:string
  model?:string
  resourceId?:string
  modelName?:string
  uid?:string
  configured:boolean
  credentialProvider:string
  hasCredential:boolean
}
export async function speechConfig():Promise<SpeechConfig> { if(!workspaceBackend()) throw new Error('语音识别请在电脑端设置'); return invoke<SpeechConfig>('speech_config') }
export async function saveSpeechConfig(patch:Partial<SpeechConfig>):Promise<SpeechConfig> { if(!workspaceBackend()) throw new Error('语音识别请在电脑端设置'); return invoke<SpeechConfig>('save_speech_config',{config:patch}) }
/** Access Token / API Key 落在 auth.json 的 provider 条目下，与其它凭据同一处。 */
export async function saveSpeechApiKey(provider:string|undefined,apiKey:string|null):Promise<{provider:string;hasCredential:boolean}> { if(!workspaceBackend()) throw new Error('语音识别密钥请在电脑端设置'); return invoke('save_speech_api_key',{provider:provider??null,apiKey}) }
/** 录音 base64 → 文字。传输方式由 speech.json 决定（火山语音 / OpenAI 兼容端点）。 */
export async function transcribeAudio(audioBase64:string,mimeType:string):Promise<{text:string;transport:string;noSpeech?:boolean}> { if(!workspaceBackend()) throw new Error('语音输入请在电脑端使用'); return invoke<{text:string;transport:string;noSpeech?:boolean}>('transcribe_audio',{audioBase64,mimeType}) }
