import { describe, expect, test } from "bun:test"
import { navigatesWebview, opensExternally } from "../src/lib/link-safety"

/**
 * 应用自己的 webview 不能被一个链接换掉。
 *
 * 原生 `<a href>` 的默认行为是替换当前文档。Orbit 没有地址栏也没有后退键，所以
 * 「换掉」等于界面没了；而带 XML MIME 的目标（`data:image/svg+xml,…`）解析失败时，
 * 用户看到的是浏览器自己的解析错误页：
 *
 *     error on line 1 at column 2: StartTag: invalid element name
 *
 * 这是从一张真实截图里回来的：`image/svg+xml` 的文档被当作文档打开。
 */
describe("links that would replace the app's webview", () => {
  test("a data: URL carrying an SVG document is not navigable", () => {
    expect(navigatesWebview("data:image/svg+xml;utf8,%3Csvg%2F%3E")).toBe(true)
    expect(navigatesWebview("data:image/svg+xml;base64,PHN2Zy8+")).toBe(true)
  })

  test("other document-bearing schemes are not navigable either", () => {
    expect(navigatesWebview("blob:http://localhost/1234")).toBe(true)
    expect(navigatesWebview("file:///home/me/hero.svg")).toBe(true)
    expect(navigatesWebview("asset://localhost/home/me/hero.svg")).toBe(true)
    expect(navigatesWebview("orbitartifact://localhost/abc")).toBe(true)
    expect(navigatesWebview("//example.com/x")).toBe(true)
  })

  test("internet and mail links are left to the system", () => {
    expect(navigatesWebview("https://example.com")).toBe(false)
    expect(navigatesWebview("http://example.com")).toBe(false)
    expect(navigatesWebview("mailto:someone@example.com")).toBe(false)
    expect(opensExternally("mailto:someone@example.com")).toBe(true)
    expect(opensExternally("https://example.com")).toBe(true)
    expect(opensExternally("data:text/html,hi")).toBe(false)
  })

  test("in-document and relative links are not a navigation away", () => {
    expect(navigatesWebview("#section")).toBe(false)
    expect(navigatesWebview("")).toBe(false)
    expect(navigatesWebview("src/app.tsx")).toBe(false)
    expect(navigatesWebview("C:\\repo\\a.ts")).toBe(true)
  })
})
