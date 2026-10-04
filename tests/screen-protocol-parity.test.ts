/**
 * The screen channel exists twice: once as Rust types the host sends, and once
 * as TypeScript types the phone parses. Nothing at runtime compares them, so a
 * field added on one side and forgotten on the other is silent — the payload
 * simply arrives without it and the client ignores the difference.
 *
 * That is not hypothetical: the client's "have the settings changed?" check
 * compared a hand-written list of five field names and omitted `source`, so
 * switching the preview from one application to the whole screen produced a
 * request the client decided was identical to the last one and never sent. The
 * fix removed the list, but nothing stopped the next list from being written.
 *
 * These tests read the Rust source and the TypeScript types and compare them, so
 * drift fails here instead of on a phone.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const RUST = readFileSync("src-tauri/src/screen/mod.rs", "utf8")
const RUST_PROTOCOL = readFileSync("src/lib/remote-protocol.ts", "utf8")

/** Field names declared in a Rust struct body, in source order. */
function rustStructFields(source: string, name: string): string[] {
  const start = source.indexOf(`pub struct ${name} {`)
  expect(start, `Rust struct ${name} not found`).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf("\n}", start))
  return [...body.matchAll(/^\s*pub\s+([a-z0-9_]+)\s*:/gm)].map(match => match[1]!)
}

/** Field names declared in a TypeScript object type body. */
function tsTypeFields(source: string, name: string): string[] {
  const start = source.indexOf(`export type ${name} = {`)
  expect(start, `TS type ${name} not found`).toBeGreaterThan(-1)
  const body = source.slice(start, source.indexOf("\n}", start))
  return [...body.matchAll(/^\s{2}([a-zA-Z0-9_]+)\??:/gm)].map(match => match[1]!)
}

/** Rust snake_case and TypeScript camelCase name the same field. */
function toCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * Fields whose absence on the other side is deliberate.
 *
 * A list of exceptions is a list that can rot, so it is kept to the minimum and
 * each entry says why it is safe to omit.
 */
const EXCEPTIONS: Record<string, string> = {
  // Rust-only: the client sends `settings` as one object, so the flat request
  // fields exist only on the wire.
  "RemoteScreenSettings.frame_width": "not part of the wire request",
}

describe("screen protocol parity", () => {
  test("ScreenSettings and RemoteScreenSettings declare the same fields", () => {
    // Rust: `pub struct ScreenSettings`. TS: the settings the phone sends.
    const rust = rustStructFields(RUST, "ScreenSettings").map(toCamel).sort()
    const ts = tsTypeFields(RUST_PROTOCOL, "RemoteScreenSettings").sort()
    const missingInTs = rust.filter(field => !ts.includes(field) && !EXCEPTIONS[`RemoteScreenSettings.${field}`])
    const missingInRust = ts.filter(field => !rust.includes(field) && !EXCEPTIONS[`ScreenSettings.${field}`])
    expect({ missingInTs, missingInRust }).toEqual({ missingInTs: [], missingInRust: [] })
  })

  test("ScreenStatus and RemoteScreenStatus declare the same fields", () => {
    const rust = rustStructFields(RUST, "ScreenStatus").map(toCamel).sort()
    const ts = tsTypeFields(RUST_PROTOCOL, "RemoteScreenStatus").sort()
    const missingInTs = rust.filter(field => !ts.includes(field))
    const missingInRust = ts.filter(field => !rust.includes(field))
    expect({ missingInTs, missingInRust }).toEqual({ missingInTs: [], missingInRust: [] })
  })

  test("the frame envelope carries every field the client reads", () => {
    // The envelope is built with `json!({...})` inside the pipeline. Comparing
    // the keys it writes against `RemoteScreenFrame` catches a field the client
    // expects and the host never sends — which reads as "always undefined".
    const envelope = RUST.slice(RUST.indexOf('"type": "screen.frame"'))
    const keys = new Set(
      [...envelope.slice(0, envelope.indexOf("})")).matchAll(/"([a-zA-Z]+)":/g)].map(match => match[1]!),
    )
    const ts = tsTypeFields(RUST_PROTOCOL, "RemoteScreenFrame").filter(field => field !== "type")
    const missing = ts.filter(field => !keys.has(field))
    expect({ missing }).toEqual({ missing: [] })
  })

  test("every settings field is part of the change check", () => {
    // The regression above, stated as an invariant: for each declared field,
    // changing only that field must make the client re-send the request. The
    // implementation compares the objects' own keys, so this holds by
    // construction — the test is what keeps it that way.
    const screen = readFileSync("src/lib/remote-screen.ts", "utf8")
    expect(screen).toContain("function sameSettings(")
    expect(screen).not.toMatch(/\[\s*"maxWidth",\s*"maxFps"/)
    // ...and the objects' own keys are what get compared.
    expect(screen).toMatch(/new Set\(\[\.\.\.Object\.keys\(left\), \.\.\.Object\.keys\(right\)\]\)/)
  })
})
