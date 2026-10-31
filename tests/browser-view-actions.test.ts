import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { viewActionScript, viewClickPointScript } from "../src-tauri/resources/browser-use/view-driver"
import type { BrowserAction } from "../src-tauri/resources/browser-use/browser-driver"

function page(html: string) {
  const window = new Window({url:"https://example.test"})
  const document=window.document
  document.body.innerHTML=html
  const element=document.body.firstElementChild! as unknown as HTMLElement
  element.style.opacity="1"
  Object.defineProperty(document,"execCommand",{value:()=>false,configurable:true})
  element.getBoundingClientRect=()=>({x:10,y:20,width:100,height:30,top:20,left:10,right:110,bottom:50,toJSON(){}})
  element.scrollIntoView=()=>{}
  Object.defineProperty(document,"elementFromPoint",{value:()=>element,configurable:true})
  ;(window as unknown as {__jevFast:unknown}).__jevFast={nodes:new Map([[1,element]])}
  const evaluate=(script:string)=>new Function("window","document",`return (${script})`)(window,document)
  const run=(text:string)=>{
    const action:BrowserAction={id:"e1",kind:"fill",node:1,label:"Editor"}
    return new Function("window","document","getComputedStyle","innerWidth","innerHeight","HTMLTextAreaElement","HTMLInputElement","Event","MouseEvent",`return (${viewActionScript(action,text)})`)(window,document,window.getComputedStyle.bind(window),800,600,window.HTMLTextAreaElement,window.HTMLInputElement,window.Event,window.MouseEvent) as {ok:boolean;reason?:string}
  }
  return {window,document,element,run,evaluate}
}

describe("browser view field input",()=>{
  test("contenteditable receives the requested text and an input event",()=>{
    const {window,element,run}=page('<div contenteditable="true">old text</div>')
    let events=0;element.addEventListener("input",()=>events++)
    expect(run("new text")).toMatchObject({ok:true})
    expect(element.textContent).toBe("new text")
    expect(events).toBe(1);window.close()
  })
  test("a controlled input that restores its value cannot report success",()=>{
    const {window,element,run}=page('<input value="original">')
    element.addEventListener("input",()=>{(element as HTMLInputElement).value="original"})
    expect(run("new text")).toMatchObject({ok:false,reason:"fill-unconfirmed"})
    expect((element as HTMLInputElement).value).toBe("original");window.close()
  })
  test("a normal textarea preserves the full multiline value",()=>{
    const {window,element,run}=page('<textarea>old</textarea>')
    expect(run("first\nsecond")).toMatchObject({ok:true})
    expect((element as HTMLTextAreaElement).value).toBe("first\nsecond");window.close()
  })
  test("a same-origin iframe field is hit-tested and filled in its own document",()=>{
    const {window,document,element:frame,run}=page('<iframe></iframe>')
    const inner=(frame as HTMLIFrameElement).contentDocument!
    inner.body.innerHTML='<input value="old">'
    const input=inner.querySelector('input')!
    input.style.opacity='1';input.scrollIntoView=()=>{}
    input.getBoundingClientRect=()=>({x:5,y:6,width:40,height:20,top:6,left:5,right:45,bottom:26,toJSON(){}})
    Object.defineProperty(inner,'elementFromPoint',{value:()=>input,configurable:true})
    Object.defineProperty(inner,'execCommand',{value:()=>false,configurable:true})
    ;(window as unknown as {__jevFast:unknown}).__jevFast={nodes:new Map([[1,input]])}
    expect(run('inside the frame')).toMatchObject({ok:true})
    expect(input.value).toBe('inside the frame')
    expect(document.body.firstElementChild).toBe(frame);window.close()
  })
})

describe("browser view native click coordinates",()=>{
  test("the bridge receives a coordinate object instead of a JSON string",()=>{
    const {window,evaluate}=page('<button>Go</button>')
    expect(evaluate(viewClickPointScript(1))).toEqual({x:60,y:35});window.close()
  })
  test("a target covered after observation cannot receive a native click",()=>{
    const {window,document,evaluate}=page('<button>Go</button>')
    const cover=document.createElement('div');document.body.append(cover)
    Object.defineProperty(document,'elementFromPoint',{value:()=>cover,configurable:true})
    expect(evaluate(viewClickPointScript(1))).toBeNull();window.close()
  })
  test("an iframe click includes the frame offset and checks the outer page for overlays",()=>{
    const {window,document,element:frame,evaluate}=page('<iframe></iframe>')
    const inner=(frame as HTMLIFrameElement).contentDocument!
    // happy-dom exposes contentDocument but does not wire frameElement back.
    Object.defineProperty(inner.defaultView!,'frameElement',{value:frame,configurable:true})
    inner.body.innerHTML='<button>Go</button>'
    const button=inner.querySelector('button')!
    button.scrollIntoView=()=>{}
    button.getBoundingClientRect=()=>({x:5,y:6,width:40,height:20,top:6,left:5,right:45,bottom:26,toJSON(){}})
    Object.defineProperty(inner,'elementFromPoint',{value:()=>button,configurable:true})
    ;(window as unknown as {__jevFast:unknown}).__jevFast={nodes:new Map([[1,button]])}
    expect(evaluate(viewClickPointScript(1))).toEqual({x:35,y:36})
    const overlay=document.createElement('div');document.body.append(overlay)
    Object.defineProperty(document,'elementFromPoint',{value:()=>overlay,configurable:true})
    expect(evaluate(viewClickPointScript(1))).toBeNull();window.close()
  })
})
