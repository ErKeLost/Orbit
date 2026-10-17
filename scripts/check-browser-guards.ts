/**
 * The browser guard checks, against a real browser and a local fixture. No
 * network, no model, no paid API.
 *
 * Ported from `jev_ultrafast/scripts/check_guards.py` (MIT), and kept a script
 * for the same reason that project keeps it one: it needs a real browser
 * process, and the offline suite (`tests/browser-use.test.ts`) is what runs
 * everywhere. Those checks exist because the freshness rules are the part of a
 * browser agent that fails silently — the click lands, the page looks fine, and
 * it hit the wrong element. Running the same cases here is what shows Orbit's
 * port kept the behaviour rather than only the shape.
 *
 *   bun run check:browser-guards
 *
 * Exits non-zero and names the failing check, so it can gate a release.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BrowserDriver, StalePage } from "../src-tauri/resources/browser-use/browser-driver"
import type { BrowserAction, BrowserObservation } from "../src-tauri/resources/browser-use/browser-driver"

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find(path => existsSync(path))

const HELPER = [process.env.ORBIT_APP_BINARY, resolve("src-tauri/target/debug/orbit")]
  .filter((path): path is string => Boolean(path))
  .find(path => existsSync(path))

if (!CHROME || !HELPER) {
  console.log(`SKIP: ${!CHROME ? "no Chromium-family browser installed" : "no built Orbit binary at src-tauri/target/debug/orbit"}`)
  process.exit(0)
}

// A dedicated home: this must never touch the profile the user's own browser
// column is signed into, and it is thrown away afterwards.
const home = mkdtempSync(join(tmpdir(), "orbit-browser-guards-"))
process.env.ORBIT_BROWSER_HOME = home
process.env.ORBIT_APP_BINARY = HELPER

const FIRST = `<!doctype html><title>Guard checks</title>
<style>body{margin:30px}button{width:180px;height:50px}#outside{position:absolute;top:3000px}</style>
<p id="context">Cart total: $10</p>
<button id="target" onclick="window.clicks=(window.clicks||0)+1">Continue</button>
<label>City<input id="field" value="Zurich"></label>
<label><input id="toggle" type="checkbox">Refundable</label>
<select aria-label="Category"><option>All</option><option>Design</option></select>
<p id="outside">Unrelated offscreen text</p>`

const SECOND = `<form id="form"><p id="price">Total $10</p>
<button type="button" id="buy">Buy</button>
<label>Search <input id="query" role="combobox" aria-controls="suggestions"></label>
<div role="listbox" id="suggestions"></div>
<label><input id="check" type="checkbox">Enabled</label>
<label><input id="radio" type="radio">Choice</label>
<input id="readonly" aria-label="Read only" readonly>
<input id="secret" type="password" value="never expose this">
<button id="off" disabled>Disabled</button>
<select id="category" aria-label="Category">
<option>All</option><option>Design</option><option disabled>Unavailable</option>
</select><aside id="unrelated">News</aside></form><div id="other">Other form</div>`

const THIRD = `<!doctype html><title>Reachability</title>
<style>#offscreen{position:absolute;top:3000px} .row{cursor:pointer} #hiddenBox{display:none}</style>
<div id="row" class="row">Row action</div>
<span id="chip" style="cursor:pointer">Chip</span>
<div id="handler" onclick="window.handled=(window.handled||0)+1">Handler only</div>
<label for="hiddenBox">Hidden box</label>
<input id="hiddenBox" type="checkbox">
<input id="secret2" type="password" value="never expose this either">
<div id="offscreen"><button id="below">Below the fold</button></div>`

// The page this port exists for: the fixed selector alone finds far more than the
// table's cap (260 real buttons), so the heuristic control that the selector misses
// only survives if the heuristic channel has its own budget rather than taking what
// the selector left. `jsOnly` is the assertion's target.
const denseButtons = Array.from({ length: 260 }, (_, index) => `<button id="dense${index}">Dense ${index}</button>`).join("")
const FOURTH = `<!doctype html><title>Dense selector</title>
<style>button{display:block}</style>
<div id="dense">${denseButtons}</div>
<div id="heuristicHost"><div id="jsOnly" onclick="window.jsOnly=(window.jsOnly||0)+1">Book now</div></div>`

const passed: string[] = []
const failures: string[] = []

function check(label: string, ok: boolean) {
  if (ok) {
    passed.push(label)
    return
  }
  failures.push(label)
}

const server = Bun.serve({
  port: 0,
  fetch: () => new Response(FIRST, { headers: { "content-type": "text/html; charset=utf-8" } }),
})

let browser: BrowserDriver | undefined

/** Evaluate in the page: this script's stand-in for a user or a site. */
async function evaluate<T = unknown>(expression: string): Promise<T> {
  const shim = browser as unknown as { evaluate(expression: string): Promise<T> }
  return shim.evaluate(expression)
}

async function load(body?: string): Promise<void> {
  browser ??= await BrowserDriver.open(`http://127.0.0.1:${server.port}/`)
  if (body) await evaluate(`document.body.innerHTML=${JSON.stringify(body)}`)
  await evaluate("window.clicks=0")
}

/** Put every control back the way the fixture declares it. */
async function reset(): Promise<void> {
  // Every expression is wrapped: `Runtime.evaluate` runs in the page's global
  // scope, so a top-level `const` would collide with itself on the next call.
  await evaluate(`(() => {
    for (const id of ['target','field','toggle']) {
      const node = document.getElementById(id)
      if (!node) continue
      node.style.display = ''
      node.disabled = false
      node.readOnly = false
      if (id === 'target') node.removeAttribute('aria-label')
      if (id === 'field') node.value = 'Zurich'
      if (id === 'toggle') node.checked = false
    }
    const select = document.querySelector('select')
    if (select) { select.value = 'All'; if (select.options[1]) select.options[1].text = 'Design' }
  })()`)
}

function labeled(page: BrowserObservation, label: string): BrowserAction {
  const action = page.actions.find(item => item.label.trim() === label)
  if (!action) throw new Error(`fixture control not found: ${label} (saw ${page.actions.map(item => item.label).join(" | ")})`)
  return action
}

async function main() {
  await load()

  // 1. A moved control is the same page, and the click lands where it is now.
  {
    const driver = browser!
    const page = await driver.observe()
    const target = labeled(page, "Continue")
    await evaluate("document.querySelector('#target').style.transform='translateX(200px)'")
    check("moving target stays fresh (geometry is resolved at input time)", await driver.fresh(page, target))
    await driver.act(target, page)
    check("moving target clicked at its current location", await evaluate<number>("window.clicks") === 1)

    // The guard's scope is the control's form/dialog/row — here, the body — so
    // text that is merely offscreen is still part of it and does invalidate.
    // That costs one decision and never a wrong click, which is the trade the
    // guard is built for.
    await evaluate("(() => { document.querySelector('#outside').textContent='Updated outside the viewport' })()")
    check("rendered text in the same scope invalidates (conservative)", (await driver.fresh(page, target)) === false)

    // Text that is not rendered at all is not in the scope.
    await evaluate("(() => { document.querySelector('#outside').style.display='none' })()")
    const hidden = await driver.observe()
    const hiddenTarget = labeled(hidden, "Continue")
    await evaluate("(() => { document.querySelector('#outside').textContent='Changed while hidden' })()")
    check("unrendered text does not invalidate", await driver.fresh(hidden, hiddenTarget))
    await evaluate("(() => { document.querySelector('#outside').style.display='' ; document.querySelector('#target').style.transform='' })()")
  }

  // 2. Every real change to the target must invalidate the decision.
  for (const [name, expression] of Object.entries({
    "visible context": "document.querySelector('#context').textContent='Cart total: $100'",
    "accessible label": "document.querySelector('#target').setAttribute('aria-label','Delete account')",
    "field property": "document.querySelector('#field').value='London'",
    "checkbox property": "document.querySelector('#toggle').checked=true",
    "disabled target": "document.querySelector('#target').disabled=true",
    "read-only field": "document.querySelector('#field').readOnly=true",
    "hidden target": "document.querySelector('#target').style.display='none'",
    "replaced node": "document.querySelector('#target').outerHTML=document.querySelector('#target').outerHTML",
    "dropdown option": "document.querySelector('select').options[1].text='Coastal'",
  })) {
    await reset()
    const page = await browser!.observe()
    const action = labeled(page, "Continue")
    await evaluate(expression)
    check(`${name} invalidates`, (await browser!.fresh(page, action)) === false)
  }

  // 3. The click guard is scoped: another form's text is unrelated, the same
  //    form's text is not. (Upstream's comment claims offscreen text is
  //    unrelated; in this Chrome it is inside the same scope and does
  //    invalidate, which costs a decision and never a wrong click.)
  await load(SECOND)
  {
    const page = await browser!.observe()
    const buy = labeled(page, "Buy")
    await evaluate("(() => { document.querySelector('#other').textContent='New unrelated news' })()")
    check("text in another form does not invalidate a click", await browser!.fresh(page, buy))
    check("text in another form invalidates the terminal decision", (await browser!.fresh(page)) === false)
    await evaluate("(() => { document.querySelector('#unrelated').textContent='News' })()")

    const scoped = await browser!.observe()
    const scopedBuy = labeled(scoped, "Buy")
    await evaluate("(() => { document.querySelector('#unrelated').textContent='Changed in the same form' })()")
    check("text in the same form invalidates the click guard (conservative)", (await browser!.fresh(scoped, scopedBuy)) === false)
    await evaluate("(() => { document.querySelector('#unrelated').textContent='News' })()")
    for (const [name, expression] of Object.entries({
      "nearby price": "document.querySelector('#price').textContent='Total $100'",
      "form value": "document.querySelector('#query').value='changed'",
      "form toggle": "document.querySelector('#check').checked=true",
      "target replacement": "document.querySelector('#buy').outerHTML=document.querySelector('#buy').outerHTML",
    })) {
      await load(SECOND)
      const before = await browser!.observe()
      const action = labeled(before, "Buy")
      await evaluate(expression)
      check(`${name} invalidates the click guard`, (await browser!.fresh(before, action)) === false)
    }
  }

  // 4. A textless overlay must block input even when the decision is fresh.
  {
    await load(FIRST)
    const page = await browser!.observe()
    const target = labeled(page, "Continue")
    await evaluate("const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(cover)")
    check("textless overlay does not change the decision", await browser!.fresh(page, target))
    let refused = false
    try {
      await browser!.act(target, page)
    } catch (error) {
      refused = error instanceof StalePage
    }
    check("covered target is refused before input", refused)
    check("covered target was not clicked", (await evaluate<number>("window.clicks ?? 0")) === 0)
  }

  // 5. Only supported operations, and no secret value.
  {
    await load(SECOND)
    const page = await browser!.observe()
    for (const role of ["checkbox", "radio"]) {
      const kinds = [...new Set(page.actions.filter(action => action.role === role).map(action => action.kind))]
      check(`${role} exposes only click`, kinds.length === 1 && kinds[0] === "click")
    }
    check("read-only field exposes only click", [...new Set(page.actions.filter(action => action.label === "Read only").map(action => action.kind))].join() === "click")
    check("password value is never exposed", !page.actions.some(action => action.value === "never expose this"))
    check("disabled control is not offered", !page.actions.some(action => action.label === "Disabled"))
    check("a dropdown offers its selectable values", page.actions.filter(action => action.kind === "select").map(action => action.value).join() === "Design")

    // 6. A native select executes, and typing waits for the suggestion popup.
    const select = page.actions.find(action => action.kind === "select")!
    await browser!.act(select, page)
    check("native dropdown selects the observed option", (await evaluate<string>("document.querySelector('#category').value")) === "Design")

    await evaluate("document.querySelector('#query').addEventListener('input',()=>setTimeout(()=>{document.querySelector('#suggestions').innerHTML='<div role=option>Generated</div>'},60))")
    const before = await browser!.observe()
    const field = before.actions.find(action => action.kind === "fill")!
    await browser!.act(field, before, "Generated")
    const after = await browser!.observe()
    check("text replacement leaves exactly the typed value", (await evaluate<string>("document.querySelector('#query').value")) === "Generated")
    check("typing waits for asynchronous suggestions", after.actions.some(action => action.role === "option"))
  }

  // 7. Reachability: controls the fixed selector used to drop, and the two flags
  //    that let a decision scroll or close an overlay before trying to click.
  {
    await load(THIRD)
    const page = await browser!.observe()
    const row = page.actions.find(action => action.label.trim() === "Row action")
    const chip = page.actions.find(action => action.label.trim() === "Chip")
    check("a cursor:pointer box is offered as a control", Boolean(row))
    check("a cursor:pointer span is offered as a control", Boolean(chip))
    check("an element with an onclick handler is offered", page.actions.some(action => action.label.trim() === "Handler only"))
    check("a label for a hidden input is offered as its proxy", page.actions.some(action => action.label.trim() === "Hidden box"))
    const below = page.actions.find(action => action.label.trim() === "Below the fold")
    check("an offscreen control is kept and flagged", Boolean(below) && below!.offscreen === true)
    check("a password field is still never exposed", !page.actions.some(action => action.value === "never expose this either"))
    check("the AX outline is attached on the Chrome path", typeof page.aria === "string" && page.aria.length > 0)

    await evaluate("(() => { const shield=document.createElement('div');shield.style.cssText='position:fixed;left:0;top:0;right:0;height:120px;z-index:99999;background:white';document.body.append(shield) })()")
    const covered = await browser!.observe()
    const coveredRow = covered.actions.find(action => action.label.trim() === "Row action")
    check("a control under an overlay is flagged covered during observation", coveredRow?.covered === true)
    check("the covering element is named", typeof coveredRow?.covered_by === "string" && coveredRow.covered_by.length > 0)
  }

  // 8. The heuristic channel keeps its reserved share of the table even when the
  //    fixed selector alone finds more controls than the table can hold. This is
  //    the regression the table budgets exist to prevent: the selector used to
  //    fill the cap first and the `<div onClick>` was never collected at all.
  {
    await load(FOURTH)
    const page = await browser!.observe()
    const buttons = page.actions.filter(action => action.role === "button" && /^Dense \d+$/.test(action.label.trim()))
    check("the dense selector page really overflows the table", page.omitted_actions > 0)
    check("the selector channel alone could fill the table", buttons.length > 0)
    check("a heuristic control survives a selector that fills the table", page.actions.some(action => action.label.trim() === "Book now"))
    const jsOnly = page.actions.find(action => action.label.trim() === "Book now")
    check("the surviving heuristic control is still actionable", jsOnly?.kind === "click")
  }
}

try {
  await main()
} catch (error) {
  failures.push(`unexpected: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  browser?.close()
  spawnSync(HELPER, ["--browser-close"], { env: process.env })
  server.stop(true)
  await new Promise(resolve => setTimeout(resolve, 200))
  rmSync(home, { recursive: true, force: true })
}

for (const label of passed) console.log(`ok   ${label}`)
for (const label of failures) console.log(`FAIL ${label}`)
if (failures.length) {
  console.log(`\n${failures.length} failed, ${passed.length} passed`)
  process.exit(1)
}
console.log(`\nPASS: ${passed.length} browser guard checks; no model calls`)