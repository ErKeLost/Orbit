import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  setSearchQuery,
} from "@codemirror/search"
import type { EditorState } from "@codemirror/state"
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view"

/**
 * The find widget, with the shape people already have in their fingers.
 *
 * `@codemirror/search` ships a panel, but it is a single row of English button
 * labels with a replace field always open and — the part that matters — no match
 * count: "3/12" or "无结果" is how a search answers "is it worth pressing Enter".
 * So the panel is this class, and the search *engine* is still CodeMirror's: the
 * query, the highlighter, and the keymap are the library's, which is why Ctrl+F,
 * F3, ⌘G and Escape all keep working.
 *
 * The `main-field` attribute is not decoration: it is how `openSearchPanel`
 * finds the field to focus when Ctrl+F is pressed with the panel already open.
 */
export class OrbitFindPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private readonly input: HTMLInputElement
  private readonly result: HTMLElement
  private readonly caseButton: HTMLButtonElement
  private readonly wordButton: HTMLButtonElement
  private readonly regexButton: HTMLButtonElement
  private readonly previousButton: HTMLButtonElement
  private readonly nextButton: HTMLButtonElement

  private readonly view: EditorView

  constructor(view: EditorView) {
    this.view = view
    this.input = element("input", { class: "orbit-find-input", type: "text", placeholder: "查找", spellcheck: "false" })
    // Tagged for `openSearchPanel`, which focuses `[main-field]`.
    this.input.setAttribute("main-field", "true")
    this.input.setAttribute("aria-label", "查找")
    this.result = element("span", { class: "orbit-find-count", "aria-live": "polite" })
    this.caseButton = toggle("Aa", "区分大小写")
    this.wordButton = toggle("ab", "全字匹配")
    this.regexButton = toggle(".*", "正则表达式")
    this.previousButton = iconButton("↑", "上一个匹配")
    this.nextButton = iconButton("↓", "下一个匹配")
    const close = iconButton("✕", "关闭查找")

    this.input.addEventListener("input", () => this.commit())
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        if (event.shiftKey) this.step(findPrevious)
        else this.step(findNext)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        closeSearchPanel(this.view)
        this.view.focus()
      }
    })
    this.caseButton.addEventListener("click", () => this.toggle("caseSensitive"))
    this.wordButton.addEventListener("click", () => this.toggle("wholeWord"))
    this.regexButton.addEventListener("click", () => this.toggle("regexp"))
    this.previousButton.addEventListener("click", () => this.step(findPrevious))
    this.nextButton.addEventListener("click", () => this.step(findNext))
    close.addEventListener("click", () => {
      closeSearchPanel(this.view)
      this.view.focus()
    })

    this.dom = element("div", { class: "orbit-find", role: "search" }, [
      this.input,
      this.result,
      this.caseButton,
      this.wordButton,
      this.regexButton,
      separator(),
      this.previousButton,
      this.nextButton,
      close,
    ])
  }

  mount() {
    const query = getSearchQuery(this.view.state)
    if (query.search && this.input.value !== query.search) this.input.value = query.search
    this.input.focus()
    this.input.select()
    this.refresh()
  }

  update(update: ViewUpdate) {
    // Anything that can change what the count means: the text, the caret (which
    // match is "current"), or the query itself arriving from outside.
    if (!update.docChanged && !update.selectionSet && !update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setSearchQuery)))) return
    this.refresh()
  }

  /** Publish the field's text as the query and jump to the next match. */
  private commit() {
    this.publish({ search: this.input.value })
    if (this.input.value) this.step(findNext)
  }

  /**
   * Run one search command, then keep the field usable.
   *
   * Every search command ends by re-selecting the field's text when it holds
   * the focus (`selectSearchInput` in `@codemirror/search`) — the right thing
   * after Enter in the library's own panel, but fatal for typing: the next
   * key would replace the whole query, which is why the field could only ever
   * hold one letter. Putting the caret back at the end keeps the query intact
   * while the view still follows every keystroke, and refocusing after a
   * button click means ↑ ↓ never strand the keyboard outside the field.
   */
  private step(command: (view: EditorView) => boolean) {
    command(this.view)
    this.input.focus()
    const end = this.input.value.length
    this.input.setSelectionRange(end, end)
  }

  private toggle(flag: "caseSensitive" | "wholeWord" | "regexp") {
    const query = getSearchQuery(this.view.state)
    this.publish({ search: this.input.value, [flag]: !query[flag] })
    this.refresh()
  }

  /**
   * Replace the query, keeping the flags the user already chose.
   *
   * Built from the public fields rather than the query's internal spec: the
   * spec is not part of the library's API, and a new `SearchQuery` is the
   * documented way to change one.
   */
  private publish(patch: Partial<{ search: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>) {
    const query = getSearchQuery(this.view.state)
    this.view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: patch.search ?? query.search,
          caseSensitive: patch.caseSensitive ?? query.caseSensitive,
          wholeWord: patch.wholeWord ?? query.wholeWord,
          regexp: patch.regexp ?? query.regexp,
          replace: query.replace,
          literal: query.literal,
          test: query.test,
        }),
      ),
    })
  }

  private refresh() {
    const query = getSearchQuery(this.view.state)
    const pressed = {
      caseSensitive: query.caseSensitive,
      wholeWord: query.wholeWord,
      regexp: query.regexp,
    }
    setPressed(this.caseButton, pressed.caseSensitive)
    setPressed(this.wordButton, pressed.wholeWord)
    setPressed(this.regexButton, pressed.regexp)

    // An invalid regular expression cannot be counted, and saying so is the
    // whole value of the widget: an empty result would look like "no hits".
    const invalid = query.search !== "" && !query.valid
    const total = invalid ? 0 : countMatches(this.view.state, query)
    const current = invalid ? -1 : currentMatch(this.view.state, query)
    const disabled = invalid || total === 0
    this.previousButton.disabled = disabled
    this.nextButton.disabled = disabled

    if (invalid) {
      this.result.dataset.state = "invalid"
      this.result.textContent = "无效表达式"
    } else if (!query.search) {
      this.result.dataset.state = ""
      this.result.textContent = ""
    } else if (total === 0) {
      this.result.dataset.state = "empty"
      this.result.textContent = "无结果"
    } else {
      this.result.dataset.state = "found"
      this.result.textContent = `${current < 0 ? 1 : current + 1}/${total}`
    }
  }
}

/**
 * The editors ⌘F may target, and the one that gets it.
 *
 * `@codemirror/search` binds `Mod-f` *inside* the editor, so the key is only
 * answered while the editor has the focus. A file pane is usually visible long
 * before it is focused — the user opens a file and reaches for ⌘F without
 * clicking the text first — so each mounted editor registers itself here, and
 * one window-level capture listener routes the key to the editor the user last
 * touched (the most recently mounted one, before any touch). `⇧⌘F` stays free
 * for the workspace search, and the library's own keymap still covers the
 * focused case; this is the bridge for every other one.
 */
const findables = new Set<EditorView>()
let lastFocused: EditorView | null = null
let findKeyHandler: ((event: KeyboardEvent) => void) | null = null

/** Start answering ⌘F with this view; returns the unregister function. */
export function registerFindTarget(view: EditorView): () => void {
  findables.add(view)
  const noteFocus = () => {
    lastFocused = view
  }
  view.dom.addEventListener("focusin", noteFocus)
  findKeyHandler ??= (event) => {
    if (event.shiftKey || event.altKey) return
    if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return
    const target = lastFocused && findables.has(lastFocused) ? lastFocused : [...findables].at(-1)
    if (!target) return
    event.preventDefault()
    openSearchPanel(target)
  }
  window.addEventListener("keydown", findKeyHandler, true)
  return () => {
    findables.delete(view)
    if (lastFocused === view) lastFocused = null
    view.dom.removeEventListener("focusin", noteFocus)
    if (findables.size === 0 && findKeyHandler) {
      window.removeEventListener("keydown", findKeyHandler, true)
      findKeyHandler = null
    }
  }
}

/** How many matches the query has, capped: a count is not worth a hang. */
export const COUNT_LIMIT = 10_000

/**
 * Count the query's matches.
 *
 * Takes a state rather than a view so the count can be tested without a DOM:
 * this is the number the user reads ("3/12" or "无结果"), and it is the one part
 * of the widget a browser would not tell us about.
 */
export function countMatches(state: EditorState, query: SearchQuery): number {
  let count = 0
  const cursor = query.getCursor(state)
  for (let next = cursor.next(); !next.done && count < COUNT_LIMIT; next = cursor.next()) count += 1
  return count
}

/** The index of the match the selection is on, or -1 when it is not on one. */
export function currentMatch(state: EditorState, query: SearchQuery): number {
  const selection = state.selection.main
  let index = 0
  const cursor = query.getCursor(state)
  for (let next = cursor.next(); !next.done && index < COUNT_LIMIT; next = cursor.next()) {
    if (next.value.from === selection.from && next.value.to === selection.to) return index
    index += 1
  }
  return -1
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string>, children: HTMLElement[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value)
  for (const child of children) node.appendChild(child)
  return node
}

function toggle(label: string, title: string): HTMLButtonElement {
  const button = element("button", { type: "button", class: "orbit-find-toggle", title, "aria-label": title, "aria-pressed": "false" }, [])
  button.textContent = label
  return button
}

function iconButton(label: string, title: string): HTMLButtonElement {
  const button = element("button", { type: "button", class: "orbit-find-button", title, "aria-label": title }, [])
  button.textContent = label
  return button
}

function separator(): HTMLElement {
  return element("span", { class: "orbit-find-separator", "aria-hidden": "true" })
}

function setPressed(button: HTMLButtonElement, pressed: boolean) {
  button.setAttribute("aria-pressed", pressed ? "true" : "false")
}
