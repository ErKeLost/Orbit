import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("RPM updates use bundled Node without a malformed external requirement", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  expect(config.bundle.linux.rpm.depends).toEqual([])
  expect(config.bundle.resources).toContain("resources/node-runtime")
  const bundle = readFileSync(new URL("../scripts/bundle-pi.mjs", import.meta.url), "utf8")
  expect(bundle).toContain("scripts/sync-node-runtime.mjs")
})
