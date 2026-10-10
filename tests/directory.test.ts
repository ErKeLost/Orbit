import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  DIR_ENTRY_LIMIT,
  directorySummary,
  entrySizeLabel,
  formatEntryDate,
  groupDirectory,
  isImageEntry,
  pathCrumbs,
} from "../src/lib/directory"
import type { DirEntry } from "../src/lib/git"

/**
 * A folder read as a folder.
 *
 * The bug this replaces had no test because the decision it got wrong was not a
 * function: the pane asked the file *name* what a path was, and a directory has
 * no extension that says so. Grouping is that decision, extracted — so it can
 * be held still here instead of only in a screenshot.
 */

const entry = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({
  name,
  path: `/w/${name}`,
  isDir: false,
  ignored: false,
  size: 1024,
  mtimeMs: 0,
  ...extra,
})

describe("grouping a directory listing", () => {
  test("folders, image tiles and everything else, in that order", () => {
    const groups = groupDirectory([
      entry("notes.md"),
      entry("photos", { isDir: true }),
      entry("shot.png"),
      entry("clip.mp4"),
      entry("archive", { isDir: true }),
      entry("cover.JPEG"),
    ])
    expect(groups.folders.map((e) => e.name)).toEqual(["archive", "photos"])
    expect(groups.images.map((e) => e.name)).toEqual(["cover.JPEG", "shot.png"])
    // Video is media but not a tile: a grid of `<img>` cannot draw it.
    expect(groups.files.map((e) => e.name)).toEqual(["clip.mp4", "notes.md"])
  })

  test("names sort numerically, not by character", () => {
    const groups = groupDirectory([entry("img10.png"), entry("img2.png"), entry("img1.png")])
    expect(groups.images.map((e) => e.name)).toEqual(["img1.png", "img2.png", "img10.png"])
  })

  test("case does not decide the order", () => {
    const groups = groupDirectory([entry("readme.md"), entry("App.tsx"), entry("app.ts")])
    expect(groups.files.map((e) => e.name)).toEqual(["app.ts", "App.tsx", "readme.md"])
  })

  test("a folder named like an image stays a folder", () => {
    expect(isImageEntry(entry("screens", { isDir: true, path: "/w/screens" }))).toBe(false)
  })

  test("gitignored entries are listed, not hidden or dimmed", () => {
    // `work/` in this repository is ignored and full of screenshots: dimming
    // every row of a folder someone opened on purpose is noise, not information.
    const groups = groupDirectory([entry("shot.png", { ignored: true })])
    expect(groups.images).toHaveLength(1)
  })
})

describe("summarising a listing", () => {
  test("only counts what is there", () => {
    expect(directorySummary(groupDirectory([entry("a", { isDir: true }), entry("b.png")]))).toBe("1 个文件夹 · 1 张图片")
    expect(directorySummary(groupDirectory([entry("a.md")]))).toBe("1 个文件")
    expect(directorySummary(groupDirectory([]))).toBe("空文件夹")
  })

  test("folders have no size to print", () => {
    expect(entrySizeLabel(entry("photos", { isDir: true, size: 96 }))).toBe("")
    expect(entrySizeLabel(entry("a.txt", { size: 2048 }))).toBe("2.0 KB")
  })

  test("an older Host that sends no size prints nothing, not NaN", () => {
    // A phone can pair with a desktop whose `list_dir` predates these fields.
    const fromOldHost = { ...entry("a.txt"), size: undefined as unknown as number }
    expect(entrySizeLabel(fromOldHost)).toBe("")
    expect(formatEntryDate(undefined as unknown as number)).toBe("")
  })

  test("mirrors git::MAX_DIR_ENTRIES", () => {
    // The listing answers with a bare array, so the only tell that a folder was
    // capped is the count. A constant that drifts would silently stop saying so.
    const rust = readFileSync("src-tauri/src/git.rs", "utf8")
    const limit = rust.match(/const MAX_DIR_ENTRIES: usize = ([^;]+);/)?.[1]
    expect(limit).toBeDefined()
    expect(Number(limit!.replace(/_/g, ""))).toBe(DIR_ENTRY_LIMIT)
  })
})

describe("dates in a listing", () => {
  const noon = new Date(2026, 9, 10, 12, 0, 0).getTime()

  test("today is a clock, this year is a date, older carries the year", () => {
    expect(formatEntryDate(new Date(2026, 9, 10, 17, 52).getTime(), noon)).toBe("17:52")
    expect(formatEntryDate(new Date(2026, 2, 4, 9, 0).getTime(), noon)).toBe("3月4日")
    expect(formatEntryDate(new Date(2025, 11, 31, 23, 0).getTime(), noon)).toBe("2025年12月31日")
  })

  test("an unknown mtime prints nothing rather than 1970", () => {
    expect(formatEntryDate(0, noon)).toBe("")
  })
})

describe("breadcrumbs", () => {
  test("a path inside the workspace is rooted at the workspace", () => {
    expect(pathCrumbs("/w/pi-gui/work/screenshots", "/w/pi-gui")).toEqual([
      { label: "pi-gui", path: "/w/pi-gui" },
      { label: "work", path: "/w/pi-gui/work" },
      { label: "screenshots", path: "/w/pi-gui/work/screenshots" },
    ])
  })

  test("a relative path is resolved against the workspace, never against nothing", () => {
    expect(pathCrumbs("work/assets", "/w/pi-gui")).toEqual([
      { label: "pi-gui", path: "/w/pi-gui" },
      { label: "work", path: "/w/pi-gui/work" },
      { label: "assets", path: "/w/pi-gui/work/assets" },
    ])
  })

  test("deep paths collapse to one crumb that goes up a level", () => {
    const crumbs = pathCrumbs("/w/pi-gui/a/b/c/d", "/w/pi-gui")
    // The root crumb is swallowed by `…` too: the point of the crumb is to reach
    // `b`'s parent, and that is `a`, not the workspace.
    expect(crumbs.map((c) => c.label)).toEqual(["…", "b", "c", "d"])
    expect(crumbs[0].path).toBe("/w/pi-gui/a")
  })

  test("a path outside the workspace keeps its own root", () => {
    expect(pathCrumbs("/System/Library", "/w/pi-gui")[0]).toEqual({ label: "System", path: "/System" })
  })
})
