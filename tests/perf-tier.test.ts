import { describe, expect, test } from "bun:test"
import { decidePerfTier } from "../src/lib/perf-tier"
import { gitPollInterval } from "../src/lib/git"

describe("mobile effect budget", () => {
  test("a phone is low unless the user forces high", () => {
    expect(decidePerfTier({ cores: 8, memory: 8, reduced: false, handheld: true })).toBe("low")
    expect(decidePerfTier({ forced: "high", cores: 8, reduced: false, handheld: true })).toBe("high")
    expect(decidePerfTier({ cores: 8, memory: 16, reduced: false, handheld: false })).toBe("high")
  })

  test("a phone stretches git polling after one quiet round", () => {
    expect(gitPollInterval(true, 0, true)).toBe(15_000)
    expect(gitPollInterval(true, 1, true)).toBe(30_000)
    expect(gitPollInterval(false, 0, true)).toBe(false)
  })
})
