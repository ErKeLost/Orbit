import {describe,expect,test} from "bun:test"
import {BrowserService,type BrowserTransport,type NativeConnector} from "../src-tauri/resources/browser-use/browser-service"
function fixture(){
 const calls:Record<string,unknown>[]=[],actions:{tab:string;operation:string;input:Record<string,unknown>}[]=[]
 const tabs=new Map<string,{scope:string;owner?:string;url:string;visible:boolean}>(),current=new Map<string,string>()
 let sequence=0,hook:((input:Record<string,unknown>)=>void)|undefined
 const transport:BrowserTransport=async<T>(input:Record<string,unknown>)=>{
  calls.push(input);hook?.(input)
  const id=String(input.tab),tab=tabs.get(id)
  let value:unknown
  switch(input.op){
   case "tabs":value={currentTabId:current.get(String(input.scope))??null,tabs:[...tabs].filter(([,tab])=>tab.scope===input.scope).map(([tab,state])=>({tab,open:true,...state}))};break
   case "open":{const id=`browser:${++sequence}`;tabs.set(id,{scope:String(input.scope),owner:String(input.owner),url:String(input.url||"about:blank"),visible:true});current.set(String(input.scope),id);value={tab:id};break}
   case "acquire":if(!tab||tab.owner||tab.scope!==input.scope)throw new Error("Tab unavailable");tab.owner=String(input.owner);value={tab:id};break
   case "status":value={tab:id,open:!!tab,...tab};break
   case "present":if(tab)tab.visible=true;break
   case "release":if(tab?.owner===input.owner)delete tab.owner;break
   case "releaseOwner":for(const tab of tabs.values())if(tab.owner===input.owner)delete tab.owner;break
   case "cdp":value={url:"ws://127.0.0.1",token:"fixture",tab:id,owner:input.owner};break
   default:throw new Error(`Unexpected native command ${input.op}`)
  }
  return value as T
 }
 const connect:NativeConnector=async endpoint=>({
  owner:endpoint.owner,connected:true,close:async()=>{},
  page:{url:()=>tabs.get(endpoint.tab)!.url,goto:async(url:string)=>{tabs.get(endpoint.tab)!.url=url}} as any,
  driver:{snapshot:async()=>({url:tabs.get(endpoint.tab)!.url,accessibilityTree:"fixture"}),action:async(operation:string,input:Record<string,unknown>,signal:AbortSignal)=>{
   signal.throwIfAborted();actions.push({tab:endpoint.tab,operation,input});if(input.ref==="stale")throw new Error("Stale reference");return{delivered:true}
  }} as any,
 })
 return{calls,actions,tabs,transport,connect,service:new BrowserService(transport,connect),hook:(value:typeof hook)=>{hook=value}}
}
describe("native Chromium service boundaries",()=>{
 test("status allocates nothing and an action requires a session page",async()=>{
  const f=fixture();expect(await f.service.run("a","status",{})).toMatchObject({engine:"chromium-native",tabs:[]});await expect(f.service.run("a","snapshot",{})).rejects.toThrow("browser_open");expect(f.tabs.size).toBe(0)
 })
 test("navigation reuses the exact page; a new service recovers session identity",async()=>{
  const f=fixture();const opened=await f.service.run("a","open",{url:"https://one.test/"}) as {tabId:string}
  expect((await f.service.run("a","open",{url:"https://two.test/"}) as any).tabId).toBe(opened.tabId)
  expect(f.tabs.get(opened.tabId)!.url).toBe("https://two.test/")
  expect((await new BrowserService(f.transport,f.connect).run("a","snapshot",{}) as any).tabId).toBe(opened.tabId)
  await f.service.run("a","open",{reuseExistingTab:false});expect(f.tabs.size).toBe(2)
 })
 test("cross session access and a busy target fail without replacing a page",async()=>{
  const f=fixture(),opened=await f.service.run("a","open",{}) as {tabId:string}
  await expect(f.service.run("b","click",{tabId:opened.tabId,selector:"button"})).rejects.toThrow("does not own")
  f.tabs.get(opened.tabId)!.owner="another";await expect(f.service.run("a","snapshot",{})).rejects.toThrow("unavailable");expect(f.tabs.size).toBe(1)
 })
 test("background input uses the same native page and releases its lease after an error",async()=>{
  const f=fixture(),opened=await f.service.run("a","open",{}) as {tabId:string};f.tabs.get(opened.tabId)!.visible=false;f.calls.length=0
  await f.service.run("a","click",{selector:"button"});expect(f.actions).toEqual([{tab:opened.tabId,operation:"click",input:{selector:"button"}}]);expect(f.tabs.get(opened.tabId)!.visible).toBe(false)
  await expect(f.service.run("a","type",{ref:"stale",text:"x"})).rejects.toThrow("Stale");expect(f.tabs.get(opened.tabId)!.owner).toBeUndefined();expect(f.calls.some(call=>["present","clickAt","eval","close"].includes(String(call.op)))).toBe(false)
 })
 test("cancellation before input releases ownership and performs no action",async()=>{
  const f=fixture();await f.service.run("a","open",{});const controller=new AbortController();f.hook(request=>{if(request.op==="status")controller.abort()})
  await expect(f.service.run("a","type",{selector:"input",text:"cancelled"},controller.signal)).rejects.toThrow();expect(f.actions).toHaveLength(0);expect([...f.tabs.values()][0].owner).toBeUndefined()
 })
 test("invalid URLs are refused before touching the native browser",async()=>{
  const f=fixture();await expect(f.service.run("a","open",{url:"javascript:alert(1)"})).rejects.toThrow("HTTP");expect(f.calls).toHaveLength(0)
 })
})
