// @vitest-environment node
import { describe, expect, it } from "vitest"
import { assignRefs, frameSnapshotText, inspectTarget, observeTree, rewriteRefs, type RefEntry } from "./refs.ts"

const tree = `- button "Submit" [ref=e1] [box=1,2,3,4]
- link "Docs" [ref=e2]:
  - /url: https://example.com/docs
- button "Delete" [ref=e3]
- button "Delete" [ref=e4]`

describe("stable refs", () => {
  it("keeps a unique control and does not reuse a duplicated label", () => {
    const first = assignRefs(new Map(), observeTree(tree), 1)
    expect(rewriteRefs(tree, first.publicOf)).toContain("[ref=e1]")
    expect(first.refs.get("e1")?.identity).toBe('- button "Submit"')
    expect(first.refs.get("e2")?.identity).toContain("/url: https://example.com/docs")
    const again = observeTree(tree.replace("[ref=e1]", "[ref=e9]").replace("[ref=e2]", "[ref=e8]"))
    const second = assignRefs(first.refs, again, first.nextId)
    expect(second.refs.get("e1")?.native).toBe("e9")
    expect(second.refs.get("e2")?.native).toBe("e8")
    expect(second.publicOf.get("e3")).toBe("e3")
    expect(second.publicOf.get("e4")).toBe("e4")
    const removed = assignRefs(first.refs, observeTree(tree.replace(/- button "Delete" \[ref=e4\]\n?/, "")), first.nextId)
    expect(removed.refs.has("e3")).toBe(false)
    expect(removed.refs.has("e4")).toBe(false)
  })

  it("does not recycle an id after navigation clears the map", () => {
    const first = assignRefs(new Map(), observeTree('- button "Submit" [ref=e1]'), 1)
    const afterNav = assignRefs(new Map<string, RefEntry>(), observeTree('- button "Other" [ref=e1]'), first.nextId)
    expect(afterNav.publicOf.get("e1")).toBe("e2")
    expect(afterNav.refs.has("e1")).toBe(false)
  })
})

describe("snapshot text", () => {
  it("keeps a child frame and drops the main document dump", () => {
    expect(frameSnapshotText([
      { main: true, text: "A".repeat(8000) },
      { main: false, text: "子框架" },
    ])).toBe("子框架")
  })
})

describe("hit test", () => {
  const box = { x: 10, y: 10, width: 20, height: 20 }
  function element(hit: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
    const self = {
      tagName: "BUTTON",
      id: "",
      className: "",
      disabled: false,
      textContent: "Submit",
      getAttribute: () => null,
      matches: () => false,
      closest: () => null,
      contains: () => false,
      getBoundingClientRect: () => box,
      ownerDocument: {
        defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({ visibility: "visible" }) },
        elementFromPoint: () => hit,
      },
      ...extra,
    }
    return self
  }

  it("names the element that would receive the click", () => {
    const message = inspectTarget(element({ tagName: "DIV", id: "consent-banner", className: "", closest: () => null }), '- button "Submit"')
    expect(message).toContain("covered by <div#consent-banner>")
  })

  it("allows a label that owns the control", () => {
    const input = element(null)
    const label: Record<string, unknown> = { tagName: "LABEL", id: "", className: "" }
    label.closest = (selector: string) => selector === "label" ? label : null
    label.contains = (node: unknown) => node === input
    label.control = input
    input.ownerDocument = { ...input.ownerDocument, elementFromPoint: () => label }
    expect(inspectTarget(input, null)).toBeNull()
  })

  it("rejects a control whose observed name changed", () => {
    expect(inspectTarget(element(null, { textContent: "Loading" }), '- button "Submit"')).toMatch(/observed target changed/)
  })
})
