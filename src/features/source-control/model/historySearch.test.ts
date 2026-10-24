import { describe, expect, test } from "bun:test";
import type { GitHistoryCommit } from "../../../platform/tauri/fs";
import {
  filterHistoryCommits,
  matchHistoryCommit,
  matchPositions,
  parseHistoryQuery,
} from "./historySearch";

function commit(over: Partial<GitHistoryCommit> & { sha?: string } = {}): GitHistoryCommit {
  const sha = over.sha ?? "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents: [],
    author: "Nick",
    timestamp: 1_700_000_000,
    subject: "Fix the diff worker pool",
    refs: [],
    head: false,
    ...over,
  };
}

describe("history query parsing", () => {
  test("splits on whitespace and lowercases", () => {
    expect(parseHistoryQuery("  Nick   Worker ")).toEqual(["nick", "worker"]);
    expect(parseHistoryQuery("   ")).toEqual([]);
  });
});

describe("history matching", () => {
  test("an empty query keeps every commit and claims no field", () => {
    const commits = [commit(), commit({ sha: "b".repeat(40) })];
    const matches = filterHistoryCommits(commits, "");
    expect(matches).toHaveLength(2);
    expect(matches[0].fields).toEqual([]);
    // 下标指向原始列表，图表仍按完整历史布局。
    expect(matches.map((match) => match.index)).toEqual([0, 1]);
  });

  test("matches subject, author, sha prefix and ref names", () => {
    expect(matchHistoryCommit(commit(), ["worker"])).toEqual(["subject"]);
    expect(matchHistoryCommit(commit(), ["nick"])).toEqual(["author"]);
    expect(matchHistoryCommit(commit(), ["a1b2c3"])).toEqual(["sha"]);
    expect(matchHistoryCommit(commit(), ["a1b2c3d4e5f6"])).toEqual(["sha"]);
    expect(
      matchHistoryCommit(commit({ refs: [{ name: "feature/graph", kind: "local" }] }), [
        "graph",
      ]),
    ).toEqual(["ref"]);
  });

  test("several terms must all match, in any field", () => {
    const target = commit({ refs: [{ name: "main", kind: "local" }] });
    expect(matchHistoryCommit(target, ["nick", "worker"])).toEqual([
      "subject",
      "author",
    ]);
    expect(matchHistoryCommit(target, ["nick", "main"])).toEqual(["author", "ref"]);
    expect(matchHistoryCommit(target, ["nick", "nope"])).toBeNull();
  });

  test("no match yields nothing rather than everything", () => {
    expect(filterHistoryCommits([commit(), commit()], "zzz")).toEqual([]);
  });

  test("filtering keeps original order and indexes", () => {
    const commits = [
      commit({ sha: "1".repeat(40), subject: "alpha" }),
      commit({ sha: "2".repeat(40), subject: "beta" }),
      commit({ sha: "3".repeat(40), subject: "alphabet" }),
    ];
    const matches = filterHistoryCommits(commits, "alpha");
    expect(matches.map((match) => match.commit.subject)).toEqual([
      "alpha",
      "alphabet",
    ]);
    expect(matches.map((match) => match.index)).toEqual([0, 2]);
  });
});

describe("match positions", () => {
  test("marks every occurrence but keeps the original casing", () => {
    expect(matchPositions("Fix fix FIX", ["fix"])).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10]);
  });

  test("merges overlapping terms into one run", () => {
    expect(matchPositions("abcdef", ["abc", "cde"])).toEqual([0, 1, 2, 3, 4]);
  });

  test("marks nothing when the term is absent or the query is empty", () => {
    expect(matchPositions("abcdef", ["zzz"])).toEqual([]);
    expect(matchPositions("abcdef", [])).toEqual([]);
    expect(matchPositions("", ["a"])).toEqual([]);
  });
});
