/** Runs inside the selected page. No network, models or application APIs. */
export function browserPage(operation: string, input: Record<string, unknown>) {
  type CachedNode = { element: Element; signature: string }
  type Cache = { revision: number; document: Document; nodes: Map<string, CachedNode>; next: number; prefix: string; userEpoch: number; observedEpoch: number }
  const host = window as typeof window & { __orbitBrowser?: Cache; __orbitAutomationClickUntil?: number }
  const cache = host.__orbitBrowser ??= { document, revision: 0, nodes: new Map(), next: 0, prefix: Math.random().toString(36).slice(2, 9), userEpoch: 0, observedEpoch: 0 }
  if (cache.document !== document) { cache.document = document; cache.nodes.clear() }
  if (!cache.revision) {
    const bump = (event: Event) => { if (event.isTrusted && (host.__orbitAutomationClickUntil ?? 0) < Date.now()) cache.userEpoch++ }
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(name, bump, { capture: true, passive: true })
  }
  const label = (e: Element): string => {
    const refs = (e.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map(id=>e.ownerDocument.getElementById(id)?.textContent ?? "").join(" ")
    return (refs || e.getAttribute("aria-label") || e.getAttribute("alt") || e.getAttribute("title") || e.getAttribute("placeholder") || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent || "").replace(/\s+/g," ").trim().slice(0,220)
  }
  const signature = (e: Element) => JSON.stringify([e.tagName,e.getAttribute("role"),e.getAttribute("href"),e.getAttribute("type"),e.getAttribute("name"),label(e),(e as HTMLInputElement).value,(e as HTMLInputElement).checked])
  const visible = (e: Element) => {
    const r=e.getBoundingClientRect(), style=e.ownerDocument.defaultView!.getComputedStyle(e)
    return r.width>0 && r.height>0 && style.visibility!=="hidden" && style.display!=="none" && style.opacity!=="0" && !e.closest('[hidden],[inert],[aria-hidden="true"]')
  }
  const documents: Document[] = [document]
  for (let i=0;i<documents.length && i<16;i++) {
    for (const frame of documents[i]!.querySelectorAll<HTMLIFrameElement>("iframe,frame")) {
      try { if(frame.contentDocument?.body) documents.push(frame.contentDocument) } catch { /* Cross-origin frames are reported below. */ }
    }
  }
  const target = (optional=false): Element | undefined => {
    const ref = typeof input.ref==="string" ? input.ref.replace(/^aria-ref=/,"") : ""
    let e: Element | undefined
    if(ref) {
      if (cache.observedEpoch !== cache.userEpoch) throw new Error("The user changed this page. Take a new browser_snapshot before acting.")
      const item=cache.nodes.get(ref)
      if(!item || !item.element.isConnected || item.signature!==signature(item.element)) throw new Error("Stale element reference. Take a new browser_snapshot before acting.")
      e=item.element
    } else if(typeof input.selector==="string") {
      const matches=documents.flatMap(doc=>[...doc.querySelectorAll(input.selector as string)])
      if(matches.length!==1) throw new Error(`Selector matched ${matches.length} elements; use one exact snapshot ref.`)
      e=matches[0]
    } else if(!optional) throw new Error("Pass an observed ref or a unique selector.")
    return e
  }
  const point = (e: Element) => {
    if(!visible(e)) throw new Error("The target is hidden. Read a fresh snapshot.")
    if ((e as HTMLInputElement).disabled || e.getAttribute("aria-disabled") === "true") throw new Error("The target is disabled")
    e.scrollIntoView({block:"center",inline:"center",behavior:"instant"})
    const r=e.getBoundingClientRect(), doc=e.ownerDocument
    let x=r.left+r.width/2, y=r.top+r.height/2
    const hit=doc.elementFromPoint(x,y)
    if(hit && hit!==e && !e.contains(hit)) throw new Error(`Target is covered by ${label(hit)||hit.tagName}. Inspect before retrying.`)
    let win=doc.defaultView
    while(win && win.document!==document) {
      const frame=win.frameElement
      if(!frame) throw new Error("Frame is no longer attached")
      const box=frame.getBoundingClientRect();x+=box.left;y+=box.top
      const outer=frame.ownerDocument.elementFromPoint(x,y)
      if(outer && outer!==frame && !frame.contains(outer)) throw new Error("Frame is covered by another element")
      win=frame.ownerDocument.defaultView
    }
    return {x,y}
  }
  const snapshot = () => {
    cache.revision++;cache.nodes.clear();cache.next=0;cache.observedEpoch=cache.userEpoch
    const elements: Record<string,unknown>[]=[]
    const media: Record<string,unknown>[]=[]
    const frames: Record<string,unknown>[]=[]
    let omitted=0
    let elementBytes=0
    for(const doc of documents) {
      for(const e of doc.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,summary,video,audio,[role],[contenteditable=true],[onclick],[tabindex]')) {
        if(!visible(e)) continue
        if(elements.length>=220 || elementBytes>=40000) {omitted++;continue}
        const ref=`${cache.prefix}-${cache.revision}-${++cache.next}`
        cache.nodes.set(ref,{element:e,signature:signature(e)})
        const field=e as HTMLInputElement
        const rect=e.getBoundingClientRect()
        const masked=field.type==="password" || /disc|circle|square/.test(doc.defaultView!.getComputedStyle(e).getPropertyValue("-webkit-text-security"))
        const role=e.getAttribute("role") || ({A:"link",BUTTON:"button",INPUT:field.type==="search"?"searchbox":"textbox",TEXTAREA:"textbox",SELECT:"combobox",VIDEO:"video",AUDIO:"audio",SUMMARY:"button"} as Record<string,string>)[e.tagName] || "control"
        const entry={ref,role,name:label(e),...(e.hasAttribute("href")?{href:(e as HTMLAnchorElement).href.slice(0,2000)}:{}),...("value" in e?{value:masked?"[hidden]":field.value.slice(0,1000)}:{}),...(field.disabled?{disabled:true}:{}),...(e.hasAttribute("aria-expanded")?{expanded:e.getAttribute("aria-expanded")}:{}),...(e.tagName === "SELECT"?{options:[...(e as HTMLSelectElement).options].slice(0,80).map(o=>({value:o.value.slice(0,200),label:(o.label??o.textContent??"").slice(0,200),selected:o.selected,disabled:o.disabled}))}:{}),...(rect.bottom<0 || rect.top>doc.defaultView!.innerHeight?{offscreen:true}:{}),...(doc!==document?{frame:true}:{})}
        elementBytes+=JSON.stringify(entry).length;elements.push(entry)
      }
      // A dense navigation menu must not consume the media budget: playback
      // is observable even when its element falls beyond the control limit.
      for (const m of doc.querySelectorAll<HTMLMediaElement>("video,audio")) {
        if (media.length>=50) break
        const ref=[...cache.nodes].find(([,item])=>item.element===m)?.[0]
        media.push({ref,kind:m.tagName.toLowerCase(),visible:visible(m),paused:m.paused,ended:m.ended,currentTime:m.currentTime,duration:Number.isFinite(m.duration)?m.duration:null,readyState:m.readyState,muted:m.muted,volume:m.volume,error:m.error?{code:m.error.code,message:m.error.message}:null})
      }
      for(const frame of doc.querySelectorAll<HTMLIFrameElement>("iframe")) {try {if(!frame.contentDocument)frames.push({url:frame.src,title:frame.title,accessible:false})}catch {frames.push({url:frame.src,title:frame.title,accessible:false})}}
    }
    return {url:location.href,title:document.title,readyState:document.readyState,text:(document.body?.innerText ?? "").slice(0,16000),elements,media,frames,omitted,viewport:{width:innerWidth,height:innerHeight},scroll:{x:scrollX,y:scrollY,height:document.documentElement.scrollHeight}}
  }
  if(operation==="snapshot") return snapshot()
  if(operation==="wait") {
    // A not-yet-present selector is a pending condition, not an action error.
    const e=input.selector && !input.ref ? documents.flatMap(doc=>[...doc.querySelectorAll(String(input.selector))]).find(visible) : target(true)
    return {matched:(!input.ref && !input.selector || !!e && visible(e)) && (!input.text || (document.body?.innerText ?? "").includes(String(input.text))) && (!input.url || location.href.includes(String(input.url)))}
  }
  if(operation==="scroll") {
    const e=target(true)
    ;(e ?? window).scrollBy({left:Number(input.deltaX)||0,top:Number(input.deltaY)||0,behavior:"instant"})
    return {ok:true}
  }
  const e=target(operation==="press") as HTMLElement | undefined
  const doc=e?.ownerDocument ?? document, win=doc.defaultView!
  if(e) point(e)
  if(operation==="click_point") {host.__orbitAutomationClickUntil=Date.now()+1500;return point(e!)}
  if(operation==="click") {
    host.__orbitAutomationClickUntil=Date.now()+1500
    e!.click();return {ok:true}
  }
  if(operation==="hover") {
    for(const name of ["pointerover","mouseover","pointermove","mousemove"])e!.dispatchEvent(new win.MouseEvent(name,{bubbles:true,composed:true}))
    return {ok:true}
  }
  if(operation==="type") {
    e!.focus();const text=String(input.text ?? ""), field=e as HTMLInputElement
    if(e!.isContentEditable) {
      if(input.clear!==false)e!.textContent=""
      const selection=win.getSelection(),range=doc.createRange();range.selectNodeContents(e!);range.collapse(false);selection?.removeAllRanges();selection?.addRange(range)
      if(!doc.execCommand?.("insertText",false,text)) {e!.textContent=(input.clear===false?e!.textContent:"")+text;e!.dispatchEvent(new win.InputEvent("input",{bubbles:true,composed:true,inputType:"insertText",data:text}))}
    } else {
      if(!["INPUT","TEXTAREA"].includes(e!.tagName) || field.disabled || field.readOnly || ["file","hidden"].includes(field.type)) throw new Error("Target is not an editable text field")
      const value=input.clear===false?field.value+text:text
      const prototype=e!.tagName==="TEXTAREA"?win.HTMLTextAreaElement.prototype:win.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype,"value")!.set!.call(e,value)
      e!.dispatchEvent(new win.InputEvent("input",{bubbles:true,composed:true,inputType:"insertText",data:text}))
      e!.dispatchEvent(new win.Event("change",{bubbles:true}))
      if(field.value!==value)throw new Error("The page rejected the input value. Inspect before retrying.")
    }
    for (const item of cache.nodes.values()) if (item.element===e) item.signature=signature(e!)
    return {ok:true}
  }
  if(operation==="select") {
    if(e!.tagName!=="SELECT")throw new Error("Use browser_click for a custom dropdown")
    const select=e as HTMLSelectElement,option=[...select.options].find(o=>typeof input.value==="string" && o.value===input.value || typeof input.label==="string" && (o.label??o.textContent)===input.label)
    if(!option || option.disabled || option.closest('optgroup[disabled]'))throw new Error("No enabled option matches")
    select.value=option.value;select.dispatchEvent(new win.Event("input",{bubbles:true}));select.dispatchEvent(new win.Event("change",{bubbles:true}))
    if(select.value!==option.value)throw new Error("The page rejected the selection")
    for (const item of cache.nodes.values()) if (item.element===e) item.signature=signature(e!)
    return {ok:true,value:select.value}
  }
  if(operation==="press") {
    const at=e ?? doc.activeElement as HTMLElement ?? doc.body
    at.focus();const key=String(input.key),code=key===" "?"Space":key,keyCode=({Enter:13,Escape:27,Tab:9," ":32,ArrowDown:40,ArrowUp:38} as Record<string,number>)[key] ?? 0
    const options={key,code,keyCode,which:keyCode,bubbles:true,cancelable:true,composed:true}
    const accepted=at.dispatchEvent(new win.KeyboardEvent("keydown",options))
    if(accepted && key==="Enter") {
      if(at instanceof win.HTMLInputElement && at.form)at.form.requestSubmit()
      else if(at.tagName==="BUTTON" || at.tagName==="A")at.click()
    }
    at.dispatchEvent(new win.KeyboardEvent("keyup",options));return {ok:true}
  }
  throw new Error(`Unsupported browser operation: ${operation}`)
}
export function pageScript(operation: string,input: Record<string,unknown> = {}) {
  return `(() => { try {return {ok:true,value:(${browserPage.toString()})(${JSON.stringify(operation)},${JSON.stringify(input)})}} catch(error) {return {ok:false,error:String(error?.message ?? error)}} })()`
}
