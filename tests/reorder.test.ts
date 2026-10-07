import { describe, expect, test } from "bun:test";
import { moveItem, orderByIds } from "../src/shared/lib/reorder";
import { reorderProjects, type Project } from "../src/lib/projects";

describe("moveItem", () => {
  test("moves an item forward and backward", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  });

  test("returns the same array for no-op or out-of-range moves", () => {
    const items = [1, 2, 3];
    expect(moveItem(items, 1, 1)).toBe(items);
    expect(moveItem(items, -1, 0)).toBe(items);
    expect(moveItem(items, 0, 3)).toBe(items);
  });
});

describe("orderByIds", () => {
  test("reorders to match ids and appends unknown items", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderByIds(items, ["c", "a"]).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  test("ignores unknown and duplicate ids", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(orderByIds(items, ["zz", "b", "b"]).map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("reorderProjects", () => {
  const projects: Project[] = [
    { path: "/a", name: "a" },
    { path: "/b", name: "b" },
    { path: "/c", name: "c" },
  ];

  test("reorders by path and keeps unsaved projects at the end", () => {
    const next = reorderProjects(projects, ["/c", "/a"]);
    expect(next.map((project) => project.path)).toEqual(["/c", "/a", "/b"]);
  });

  test("ignores unknown paths", () => {
    const next = reorderProjects(projects, ["/nope", "/b"]);
    expect(next.map((project) => project.path)).toEqual(["/b", "/a", "/c"]);
  });
});
