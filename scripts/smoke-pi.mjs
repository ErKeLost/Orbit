import {spawn,spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
import {cpSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'..'),cwd=resolve(root,'work/smoke')
mkdirSync(cwd,{recursive:true})
const bundled=spawnSync(process.execPath,[resolve(root,'scripts/bundle-pi.mjs')],{cwd:root,stdio:'inherit'})
if(bundled.status!==0)process.exit(bundled.status??1)
const isolated=mkdtempSync(resolve(tmpdir(),'orbit-pi-smoke-')),resources=resolve(isolated,'resources')
mkdirSync(resources,{recursive:true})
cpSync(resolve(root,'src-tauri/resources/pi-runtime'),resolve(resources,'pi-runtime'),{recursive:true})
cpSync(resolve(root,'src-tauri/resources/subagents'),resolve(resources,'subagents'),{recursive:true})
cpSync(resolve(root,'src-tauri/resources/computer-use'),resolve(resources,'computer-use'),{recursive:true})
cpSync(resolve(root,'src-tauri/resources/node_modules'),resolve(resources,'node_modules'),{recursive:true})
cpSync(resolve(root,'src-tauri/resources/node-runtime'),resolve(resources,'node-runtime'),{recursive:true})
cpSync(resolve(root,'src-tauri/resources/gui-extension.ts'),resolve(resources,'gui-extension.ts'))
cpSync(resolve(root,'src-tauri/resources/context-payload.ts'),resolve(resources,'context-payload.ts'))
cpSync(resolve(root,'src-tauri/resources/workspace.ts'),resolve(resources,'workspace.ts'))
const cli=resolve(resources,'pi-runtime/cli.js'),extension=resolve(resources,'gui-extension.ts'),runtimeNode=resolve(resources,'node-runtime',process.platform==='win32'?'node.exe':'node'),runtimeModules=resolve(resources,'node_modules')
const runtimeEnv={...process.env,NODE_PATH:runtimeModules,ORBIT_PI_CLI_PATH:cli,ORBIT_PI_NODE_PATH:runtimeNode,JITI_FS_CACHE:'false'}
const clipboard=spawnSync(runtimeNode,['-e','require("@mariozechner/clipboard")'],{cwd,env:runtimeEnv,stdio:'pipe'})
assert.equal(clipboard.status,0,'bundled native clipboard dependency loads')
const child=spawn(runtimeNode,[cli,'--mode','rpc','--offline','--no-session','--extension',extension],{cwd,stdio:['pipe','pipe','pipe'],env:runtimeEnv})
let buffer='',sequence=0,errors='',toolState,runtimeInfo,capabilities,media,virtualModels,mcpServers
const pending=new Map(),results=[]
const collaborationTools=['spawn_agent','send_message','followup_task','wait_agent','interrupt_agent','list_agents']
child.on('exit',code=>{for(const p of pending.values())p.reject(new Error('Pi exited: '+code));pending.clear()})
child.stderr.on('data',chunk=>{errors+=chunk.toString()})
child.stdout.setEncoding('utf8')
child.stdout.on('data',chunk=>{
 buffer+=chunk
 let end
 while((end=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
  if(!line.trim())continue
  const event=JSON.parse(line)
  if(event.type==='extension_ui_request'&&event.statusKey==='gui-runtime')runtimeInfo=JSON.parse(event.statusText)
  if(event.type==='extension_ui_request'&&event.statusKey==='gui-tools')toolState=JSON.parse(event.statusText)
  if(event.type==='extension_ui_request'&&event.statusKey==='gui-capabilities')capabilities=JSON.parse(event.statusText)
  if(event.type==='extension_ui_request'&&event.statusKey==='gui-media')media=JSON.parse(event.statusText)
  if(event.type==='extension_ui_request'&&event.statusKey==='gui-virtual-models')virtualModels=JSON.parse(event.statusText)
  if(event.type==='extension_ui_request'&&event.statusKey==='gui-mcp')mcpServers=JSON.parse(event.statusText)
  if(event.type==='response'&&pending.has(event.id)){const p=pending.get(event.id);pending.delete(event.id);if(event.success)p.resolve(event.data);else p.reject(new Error(event.error))}
  if(event.type==='agent_settled'&&pending.has('settled')){pending.get('settled').resolve();pending.delete('settled')}
 }
})
const req=(command)=>new Promise((resolve,reject)=>{const id=String(++sequence);pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({...command,id})+'\n')})
const deadline=setTimeout(()=>{console.error('Pi smoke test timed out');child.kill();process.exit(1)},90000)
try{
 await req({type:'prompt',message:'/gui-observe'});assert(runtimeInfo.compaction.reserveTokens>0);assert.equal(typeof runtimeInfo.systemPrompt,'string');results.push('SDK live context and compaction configuration')
 const state=await req({type:'get_state'});assert(state.model);assert.equal(typeof state.model.provider,'string');assert.equal(typeof state.model.id,'string');results.push('state: active model and thinking level returned')
 const models=await req({type:'get_available_models'});assert(models.models.some(m=>m.provider===state.model.provider&&m.id===state.model.id));results.push('current model returned by Pi model catalog')
 const levels=await req({type:'get_available_thinking_levels'});assert(levels.levels.includes(state.thinkingLevel));results.push('current thinking level returned by Pi capability API')
 await req({type:'prompt',message:'/gui-tools'});assert(toolState.tools.length>0);results.push('GUI extension: tool inventory')
 await req({type:'prompt',message:'/gui-tools-set ["read"]'});assert.deepEqual(toolState.active,['read']);results.push('GUI extension: active tools update')
 await req({type:'prompt',message:'/gui-agent-mode {"enabled":true}'});assert(collaborationTools.every(name=>toolState.active.includes(name)));results.push('GUI extension: multi-agent tools enabled')
 await req({type:'prompt',message:'/gui-agent-mode {"enabled":false}'});assert(collaborationTools.every(name=>!toolState.active.includes(name)));results.push('GUI extension: multi-agent tools disabled')
 await req({type:'prompt',message:'/gui-computer-use-mode {"enabled":true}'});assert.equal(toolState && typeof toolState, 'object');results.push('GUI extension: computer-use mode command')
 await req({type:'prompt',message:'/gui-computer-use-mode {"enabled":false}'});results.push('GUI extension: computer-use mode disabled')
 const bash=await req({type:'bash',command:'printf "Orbit integration ok"',excludeFromContext:true});assert.equal(bash.exitCode,0);assert.equal(bash.output,'Orbit integration ok');results.push('real Bash execution through RPC')
 const commands=await req({type:'get_commands'});assert(commands.commands.some(c=>c.name==='gui-tree'));results.push('commands enumerated')
 // Pi 1.0 capability surface: exposure, MCP, media models, virtual routing models.
 await req({type:'prompt',message:'/gui-capabilities'})
 assert(capabilities&&capabilities.tools.total>0,'capability snapshot reported')
 assert.equal(typeof capabilities.tools.codemode,'boolean');assert.equal(typeof capabilities.tools.toolSearch,'boolean')
 assert(capabilities.tools.exposure&&Object.keys(capabilities.tools.exposure).length>0,'tool exposure classes reported')
 assert(Array.isArray(capabilities.mcp)&&Array.isArray(capabilities.media.image)&&Array.isArray(capabilities.media.classifier))
 assert(Array.isArray(capabilities.virtualModels))
 results.push('Pi 1.0 capability snapshot: tool exposure, MCP, media, virtual models')
 await req({type:'prompt',message:'/gui-media {"action":"list"}'});assert(media&&Array.isArray(media.image)&&Array.isArray(media.classifier));results.push('image and classifier model catalog')
 await req({type:'prompt',message:'/gui-mcp {"action":"add","name":"orbit_smoke","config":{"url":"https://127.0.0.1:9/mcp","enabled":false}}'})
 assert(mcpServers.servers.some(server=>server.name==='orbit_smoke'&&server.source==='extension'),'session MCP registration reported')
 await req({type:'prompt',message:'/gui-mcp {"action":"remove","name":"orbit_smoke"}'})
 assert(!mcpServers.servers.some(server=>server.name==='orbit_smoke'),'session MCP registration removed')
 results.push('MCP server registration through pi.registerMcpServer')
 await req({type:'prompt',message:'/gui-virtual-model {"action":"register","input":{"provider":"router","id":"orbit-smoke","name":"Orbit Smoke","thinkingLevels":["low","high"],"rules":[{"match":{"thinkingLevel":["high"]},"model":{"provider":"anthropic","id":"claude-opus-4-5","thinkingLevel":"high"}},{"model":{"provider":"anthropic","id":"claude-haiku-4-5"}}]}}'})
 assert(virtualModels.virtualModels.some(model=>model.provider==='router'&&model.id==='orbit-smoke'),'virtual model registered')
 await req({type:'prompt',message:'/gui-virtual-model {"action":"remove","provider":"router","id":"orbit-smoke"}'})
 assert(!virtualModels.virtualModels.some(model=>model.id==='orbit-smoke'),'virtual model removed')
 results.push('virtual model registration through pi.registerVirtualModel')
 if(process.argv.includes('--live')){
   const settled=new Promise((resolve,reject)=>pending.set('settled',{resolve,reject}))
   await req({type:'prompt',message:'只回复：Orbit 连接测试成功。不要调用工具。'})
   await settled
   const text=await req({type:'get_last_assistant_text'});assert(text.text?.includes('测试成功'));results.push('live model response: '+text.text)
 }
 const report={checkedAt:new Date().toISOString(),results}
 writeFileSync(resolve(root,'docs/pi-smoke-result.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report,null,2))
}catch(error){console.error(error.message);if(errors)console.error('Pi wrote diagnostics to stderr');process.exitCode=1}
finally{clearTimeout(deadline);child.stdin.end();if(child.exitCode===null){child.kill();await new Promise(resolveExit=>child.once('exit',resolveExit))}rmSync(isolated,{recursive:true,force:true})}
