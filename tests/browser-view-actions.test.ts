import { describe, expect, test } from "bun:test"
import { browserFixture } from "./browser-fixture"

describe("direct browser page operations", () => {
  test("typing preserves the whole literal search value", () => {
    const f = browserFixture('<form><label>Search<input></label></form>')
    try {
      const input = f.document.querySelector("input")!
      f.hit(input)
      const { ref } = f.snapshot().elements.find(e => e.name === "Search")!
      f.run("type", { ref, text: "现在就出发 完整查询" })
      expect(input.value).toBe("现在就出发 完整查询")
    } finally { f.close() }
  })
  test("typing and pressing Enter can reuse the same ref", () => {
    const f = browserFixture('<form><input aria-label="Query"></form>')
    try {
      let submitted = 0
      f.document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); submitted++ })
      const ref = f.snapshot().elements[0]!.ref
      f.run("type", { ref, text: "现在就出发" })
      f.run("press", { ref, key: "Enter" })
      expect(f.document.querySelector("input")!.value).toBe("现在就出发")
      expect(submitted).toBe(1)
    } finally { f.close() }
  })
  test("textarea and rich text preserve multiline text and append", () => {
    for (const html of ['<textarea>old</textarea>', '<div contenteditable="true">old</div>']) {
      const f = browserFixture(html)
      try {
        const ref = f.snapshot().elements[0]!.ref
        f.run("type", { ref, text: "first\nsecond" })
        f.run("type", { ref, text: "\nthird", clear: false })
        const element = f.document.body.firstElementChild!
        expect(element.tagName === "TEXTAREA" ? (element as unknown as HTMLTextAreaElement).value : element.textContent).toBe("first\nsecond\nthird")
      } finally { f.close() }
    }
  })
  test("a controlled field that rejects the value returns an error", () => {
    const f = browserFixture('<input value="original">')
    try {
      const element = f.document.querySelector("input")!
      element.addEventListener("input", () => { element.value = "original" })
      expect(() => f.run("type", { ref: f.snapshot().elements[0]!.ref, text: "new" })).toThrow("rejected")
    } finally { f.close() }
  })
  test("select exposes actual options and chooses by exact label", () => {
    const f = browserFixture('<select aria-label="Category"><option value="all">All</option><option value="shows">Shows</option></select>')
    try {
      const ref = f.snapshot().elements[0]!.ref
      f.run("select", { ref, label: "Shows" })
      expect(f.document.querySelector("select")!.value).toBe("shows")
    } finally { f.close() }
  })
  test("changed targets and replaced DOM nodes invalidate refs, unrelated text does not", () => {
    const f = browserFixture('<button>Continue</button><aside>Clock</aside>')
    try {
      const button = f.document.querySelector("button")!
      let clicks = 0
      button.addEventListener("click", () => clicks++)
      const ref = f.snapshot().elements[0]!.ref
      f.document.querySelector("aside")!.textContent = "new clock value"
      f.run("click", { ref })
      expect(clicks).toBe(1)
      button.textContent = "Delete account"
      expect(() => f.run("click", { ref })).toThrow("Stale")
      const next = f.snapshot().elements[0]!.ref
      button.replaceWith(button.cloneNode(true))
      expect(() => f.run("click", { ref: next })).toThrow("Stale")
      expect(clicks).toBe(1)
    } finally { f.close() }
  })
  test("another snapshot invalidates previous refs", () => {
    const f = browserFixture('<button>Go</button>')
    try {
      const ref = f.snapshot().elements[0]!.ref
      f.snapshot()
      expect(() => f.run("click", { ref })).toThrow("Stale")
    } finally { f.close() }
  })
  test("covered or disabled targets never receive a click", () => {
    const f = browserFixture('<button>Go</button><div>Overlay</div>')
    try {
      const ref = f.snapshot().elements[0]!.ref
      f.hit(f.document.querySelector("div")! as unknown as Element)
      expect(() => f.run("click_point", { ref })).toThrow("covered")
      f.hit(undefined)
      f.document.querySelector("button")!.disabled = true
      expect(() => f.run("click_point", { ref })).toThrow("disabled")
    } finally { f.close() }
  })
  test("native click returns an object and selectors must identify one element", () => {
    const f = browserFixture('<button>One</button><button>Two</button>')
    try {
      expect(f.run("click_point", { ref: f.snapshot().elements[0]!.ref })).toEqual({ x: 60, y: 35 })
      expect(() => f.run("click", { selector: "button" })).toThrow("2 elements")
      expect(f.run("wait", { selector: "#not-yet-present" })).toEqual({ matched: false })
    } finally { f.close() }
  })
  test("passwords are masked and actual media state is exposed", () => {
    const f = browserFixture('<input type="password" value="secret"><a href="/watch/123">Show</a><video></video>')
    try {
      const result = f.snapshot()
      expect(JSON.stringify(result)).not.toContain("secret")
      expect(result.elements.find(e => e.role === "link")!.href).toBe("https://fixture.test/watch/123")
      expect(result.media[0]).toMatchObject({ paused: true, currentTime: 0 })
    } finally { f.close() }
  })
})
