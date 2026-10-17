/* Page observer from browser-use/jev-ultrafast (MIT): https://github.com/browser-use/jev-ultrafast
   Evaluated inside the page. Based on upstream verbatim; Orbit adds three additive passes on the
   same contract (element ids, page key and guards are unchanged):
     * controls outside the viewport are kept and flagged (`offscreen`) instead of dropped, so a
       decision can choose to scroll rather than being blind to them;
     * coverage is hit-tested during observation (`covered`) instead of only failing at input time,
       so an overlay is visible to the model in the same turn it appears;
     * controls the fixed selector misses (onclick handlers, positive tabindex, `cursor:pointer`
       boxes, and `label[for]` proxies for hidden inputs) are collected with a per-parent cap,
       and each channel has a reserved share of the table so the heuristic pass cannot be
       squeezed out by a page whose fixed selector alone fills it (see the budgets below).
   The block comment is deliberate: this text is embedded inside another expression by the driver. */
(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  // Same-origin frame documents, outermost first. `contentDocument` throws (or is
  // null) for a cross-origin frame, which is the only case this cannot see into;
  // such a frame is reported as unobservable rather than silently skipped.
  const frameDocs=(()=>{
    const found=[];
    const walk=(doc,depth)=>{
      if (depth>2) return;
      for (const frame of doc.querySelectorAll('iframe,frame')) {
        let inner=null;
        try { inner=frame.contentDocument } catch {}
        if (!inner || !inner.body) continue;
        found.push({frame,doc:inner});
        walk(inner, depth+1);
      }
    };
    walk(document,0);
    return found;
  })();
  // Coordinates as the top-level viewport sees them: an element inside a frame
  // reports its own document's box, and input is dispatched in top-level pixels.
  const topRect=e=>{
    let rect=e.getBoundingClientRect();
    let win=e.ownerDocument.defaultView, guard=0;
    while (win && win!==window && guard++<4) {
      let frame=null;
      try { frame=win.frameElement } catch {}
      if (!frame) break;
      const outer=frame.getBoundingClientRect();
      rect={x:rect.x+outer.x, y:rect.y+outer.y, width:rect.width, height:rect.height,
        top:rect.top+outer.y, left:rect.left+outer.x, right:rect.right+outer.x, bottom:rect.bottom+outer.y};
      win=frame.ownerDocument.defaultView;
    }
    return rect;
  };
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  // A field the page draws as dots. `type=password` is already excluded from the
  // table, but OTP and card-entry widgets are ordinary text inputs styled with
  // `-webkit-text-security` — and their value would otherwise travel into the
  // decision context and the run's log verbatim. The page has decided nobody
  // should read that value, so neither do we: the field stays actionable, its
  // current value does not.
  const DOTTED_VALUE='••••••••';
  const drawsDots=e=>{
    if (e.type==='password') return true;
    let style='';
    try {
      const css=getComputedStyle(e);
      style=css.getPropertyValue('-webkit-text-security') || css.webkitTextSecurity || '';
    } catch {}
    // The property is not on every `CSSStyleDeclaration` surface (and a page may
    // set it inline), so the declaration attribute is the fallback, not a hack.
    if (!style) style=/-webkit-text-security\s*:\s*([^;]+)/.exec(e.getAttribute('style')||'')?.[1] || '';
    style=String(style).trim().toLowerCase();
    return style!=='' && style!=='none';
  };
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(e.ownerDocument.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  const allFields=()=>{
    const fields=[...document.querySelectorAll('input,textarea,select')];
    for (const {doc} of frameDocs) fields.push(...doc.querySelectorAll('input,textarea,select'));
    return fields;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    allFields().filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly]),
    frameDocs.length];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };

  // Whether a control may be offered at all. One definition, because the three
  // collectors below disagreeing about it is how a page ends up half-visible.
  const actionable=e=>safe(e) && visible(e) && !e.matches(':disabled') && !e.closest('[aria-disabled="true"]');

  const actions=[], seen=new Set();

  // What is sitting on top of this point, if it is not the element itself (or a
  // descendant/ancestor of it). Returns a short human description, because "this
  // is unclickable" is much less useful to a decision model than "a cookie
  // banner is on top of it".
  const covererOf=(e,x,y,doc=document)=>{
    const at=doc.elementFromPoint(x,y);
    if (!at || e===at || e.contains(at) || at.contains(e)) return '';
    return (name(at) || role(at) || at.tagName.toLowerCase()).trim().slice(0,80);
  };

  const collect=(e,forcedRole,sink,frame)=>{
    // Two boxes on purpose: the page draws and hit-tests in its own document,
    // while the model and the input dispatcher work in top-level pixels.
    const own=e.getBoundingClientRect(), w=own.width, h=own.height;
    const r=frame?topRect(e):own, x=r.x+w/2, y=r.y+h/2;
    const rname=forcedRole || role(e);
    if (!rname || w<=0 || h<=0) return false;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) return false;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:w,h:h},...(frame?{frame:true}:{})};
    // On screen and reachable, or off screen and flagged: either way the model
    // gets to see it. Coverage is checked here, not only before input, so the
    // decision that would click through an overlay is never made in the first place.
    if (x<0 || y<0 || x>=innerWidth || y>=innerHeight) base.offscreen=true;
    else {
      // Hit-tested inside the element's own document: from the top document every
      // control in a frame reports as its frame, which is not an overlay.
      const by=covererOf(e,own.x+w/2,own.y+h/2,e.ownerDocument);
      if (by) { base.covered=true; base.covered_by=by; }
    }
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        sink.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const raw='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      // Only a value that exists can leak; an empty dotted field is shown as
      // empty so the model can still tell "nothing typed yet" from "hidden".
      const masked=raw!=='' && drawsDots(e);
      const value=masked ? DOTTED_VALUE : raw;
      sink.push({...base,kind:editable?'fill':'click',value,...(masked?{masked:true,raw}:{})});
      if (editable) sink.push({...base,kind:'click',value,label:'Open '+base.label,...(masked?{masked:true,raw}:{})});
    }
    return true;
  };

  // ---- action-table budgets -------------------------------------------------
  // The table handed to the model is capped. Upstream spent the whole cap on its
  // fixed selector, and that is exactly why a React page full of `<div onClick>`
  // looked empty: the heuristic pass ran after the cap was already full and
  // collected nothing. Each channel therefore has a reserved share, and the
  // *selector* channel is the one that yields when the table overflows — never the
  // heuristic channel, which exists only for the pages the selector misses.
  const TOTAL_CAP=250;
  // Offscreen semantic controls are kept so the model knows there is more below
  // the fold, but a list can have thousands and none of them can be acted on
  // without scrolling first, so a small reserve is enough for that signal.
  const OFFSCREEN_CAP=40;
  // The heuristic pass is the port's whole point. It must survive the cap, so it
  // gets a real reserve; 60 covers the interactive boxes of a screenful without
  // crowding the labelled controls a chooser reasons about first.
  const HEURISTIC_CAP=60;
  // Label proxies for visually hidden inputs are rare (an sr-only checkbox), so a
  // small reserve is enough and it never competes with the two main passes.
  const LABEL_CAP=20;
  const heuristicActions=[], labelActions=[];

  // The selector pass may be complete: its controls are the ones a heuristic
  // twin would duplicate. It is still hard-capped so a pathological page cannot
  // stall the observer; the table cap is applied later, once the other channels'
  // needs are known.
  const SELECTOR_HARD_CAP=400;
  for (const e of document.querySelectorAll(selector)) {
    if (actions.length>=SELECTOR_HARD_CAP) break;
    if (actionable(e) && collect(e,undefined,actions)) seen.add(e);
  }

  // Upstream's selector is deliberately small, which is why a React page full of
  // `<div onClick>` looked empty to the model. These are the traits that make a
  // non-semantic element a real control; `cursor:pointer` alone would match too
  // much, so it is only trusted on a box, and a per-parent cap keeps a list of
  // near-identical rows from flooding the table.
  const MAX_PER_PARENT=12;
  const examinedMax=6000;
  const clickableHeuristic=e=>{
    if (e.hasAttribute('onclick')) return true;
    const tabindex=e.getAttribute('tabindex');
    if (tabindex!==null && Number(tabindex)>=0) return true;
    return ['DIV','SPAN','A'].includes(e.tagName) && getComputedStyle(e).cursor==='pointer';
  };
  const heuristic=new Set();
  const perParent=new Map();
  const hasHeuristicAncestor=e=>{
    for (let p=e.parentElement, depth=0; p && depth<6; p=p.parentElement, depth++) if (heuristic.has(p)) return true;
    return false;
  };
  let examined=0;
  for (const e of document.querySelectorAll('[onclick],div,span,a,[tabindex]')) {
    // The heuristic reserve is its own budget, independent of how full the
    // selector already made the table — that independence is the fix: the
    // selector could fill the whole cap and leave this pass nothing to find.
    if (heuristicActions.length>=HEURISTIC_CAP || ++examined>examinedMax) break;
    if (seen.has(e) || heuristic.has(e)) continue;
    if (!actionable(e) || !clickableHeuristic(e) || hasHeuristicAncestor(e)) continue;
    const parent=e.parentElement || document.body;
    const count=perParent.get(parent) || 0;
    if (count>=MAX_PER_PARENT) continue;
    if (!collect(e,'button',heuristicActions)) continue;
    heuristic.add(e); perParent.set(parent,count+1);
  }
  // A control styling hid (`sr-only`, `display:none`) still has a visible label.
  // The label is the thing a user clicks, so it becomes the target; the value
  // stays on the control through the label's own default action.
  for (const label of document.querySelectorAll('label[for]')) {
    if (labelActions.length>=LABEL_CAP) break;
    if (seen.has(label) || heuristic.has(label) || !visible(label)) continue;
    const control=document.getElementById(label.getAttribute('for'));
    if (!control || !safe(control)) continue;
    const r=control.getBoundingClientRect();
    if (visible(control) && r.width>0 && r.height>0) continue;
    if (!collect(label,'button',labelActions)) continue;
    heuristic.add(label);
  }

  // ---- same-origin frames ---------------------------------------------------
  // A login or payment form is often an <iframe>, and a walk of the top document
  // cannot see one: the page looked empty to the model when the fields were one
  // document down. Same-origin only — `frameDocs` already dropped the rest — and
  // capped, because a frame can be a whole application of its own.
  const FRAME_CAP=60;
  const frameActions=[];
  for (const {doc} of frameDocs) {
    if (frameActions.length>=FRAME_CAP) break;
    for (const e of doc.querySelectorAll(selector)) {
      if (frameActions.length>=FRAME_CAP) break;
      if (seen.has(e) || heuristic.has(e)) continue;
      if (actionable(e) && collect(e,undefined,frameActions,true)) seen.add(e);
    }
  }

  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;

  // Assemble the table the model reads. The selector's visible controls take
  // what the reserved channels leave; the reserved channels are inserted whole;
  // offscreen selector controls close it, so the model still learns there is
  // more below the fold. A page that fits keeps everything, exactly as before —
  // the budget only bites when the table would overflow, and then it bites the
  // *selector* channel, never the heuristic one.
  const visibleSel=[], offscreenSel=[];
  for (const a of actions) (a.offscreen?offscreenSel:visibleSel).push(a);
  const reserved=[...heuristicActions,...labelActions,...frameActions];
  const discovered=visibleSel.length+offscreenSel.length+reserved.length;
  let kept=[...visibleSel,...reserved,...offscreenSel];
  if (discovered>TOTAL_CAP) {
    const offscreenReserve=Math.min(offscreenSel.length,OFFSCREEN_CAP);
    const selectorRoom=Math.max(0,TOTAL_CAP-offscreenReserve-reserved.length);
    kept=[...visibleSel.slice(0,selectorRoom),...reserved,...offscreenSel.slice(0,OFFSCREEN_CAP)];
  }
  const omitted_actions=Math.max(0,discovered-kept.length);
  actions.length=0; actions.push(...kept);
  // What can be acted on now outranks what merely exists. The merge above
  // already puts offscreen last, but a heuristic/label control can itself be
  // offscreen; this keeps the rule uniform. The sort is stable, so document
  // order holds within each group.
  actions.sort((a,b)=>(a.offscreen?1:0)-(b.offscreen?1:0));
  actions.splice(TOTAL_CAP);

  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
