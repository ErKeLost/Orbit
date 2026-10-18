import { beforeEach, describe, expect, it, test } from "bun:test";
import type { Note } from "../src/features/notes/notes";
import {
  addNoteTag,
  applySavedNote,
  canAddNoteToChat,
  enqueueNoteSave,
  filterNotes,
  hasDroppedFiles,
  isBlankNote,
  isDropThrottled,
  isNoteDirty,
  isPointInRect,
  noteDraft,
  noteUpsertInput,
  parseTagInput,
  pickNoteAfterDelete,
  pickNoteAfterLoad,
  remainingNoteEdits,
  resetNoteSaveQueues,
  resolveNoteTitle,
  resolveNotesEscapeKey,
  resolveTagKeyDown,
  resolveTitleKeyDown,
  sameTags,
  selectVisibleNote,
  sortNotes,
  toClientPoint,
} from "../src/features/notes/model/notesView";

function note(overrides: Partial<Note> & Pick<Note, "id" | "slug" | "title">): Note {
  return {
    body: "",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const auth = note({
  id: "n1",
  slug: "auth",
  title: "Auth approach",
  body: "Keep the token global.",
  tags: ["ideas", "project-docs"],
  sourceCwd: "/Users/me/Code/Auth",
  updatedAt: 3,
});

describe("notes list", () => {
  it("returns the same list for an empty query", () => {
    const notes = [auth];
    expect(filterNotes(notes, "   ")).toBe(notes);
  });

  it("matches title, body, slug, tags and project", () => {
    expect(filterNotes([auth], "approach")).toEqual([auth]);
    expect(filterNotes([auth], "token")).toEqual([auth]);
    expect(filterNotes([auth], "auth")).toEqual([auth]);
    expect(filterNotes([auth], "project-doc")).toEqual([auth]);
    expect(filterNotes([auth], "#ideas")).toEqual([auth]);
    const work = note({ id: "n3", slug: "misc", title: "Scratch", body: "Loose thoughts", sourceCwd: "/Users/me/Code/Orbit" });
    expect(filterNotes([work], "orbit")).toEqual([work]);
    expect(filterNotes([auth], "nothing")).toEqual([]);
  });

  it("sorts newest first with an id tiebreaker", () => {
    const a = note({ id: "b", slug: "b", title: "B", updatedAt: 5 });
    const b = note({ id: "a", slug: "a", title: "A", updatedAt: 5 });
    const c = note({ id: "c", slug: "c", title: "C", updatedAt: 9 });
    expect(sortNotes([a, b, c]).map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("replaces a saved note and re-sorts", () => {
    const older = note({ id: "n1", slug: "auth", title: "Old", updatedAt: 1 });
    const other = note({ id: "n2", slug: "other", title: "Other", updatedAt: 5 });
    const saved = { ...older, title: "New", updatedAt: 9 };
    expect(applySavedNote([older, other], saved)).toEqual([saved, other]);
  });

  it("picks the current selection, then the remembered note, then the first", () => {
    const notes = [note({ id: "a", slug: "a", title: "A" }), note({ id: "b", slug: "b", title: "B" })];
    expect(pickNoteAfterLoad(notes, "b", "a")).toBe("b");
    expect(pickNoteAfterLoad(notes, null, "b")).toBe("b");
    expect(pickNoteAfterLoad(notes, "gone", "gone")).toBe("a");
    expect(pickNoteAfterLoad([], "a", "b")).toBeNull();
  });

  it("keeps the current note unless it was the one deleted", () => {
    const next = [note({ id: "b", slug: "b", title: "B" })];
    expect(pickNoteAfterDelete(next, "a", "b")).toBe("b");
    expect(pickNoteAfterDelete(next, "a", "a")).toBe("b");
    expect(pickNoteAfterDelete([], "a", "a")).toBeNull();
  });

  it("prefers the filtered list, then falls back to the full list", () => {
    const filtered = [note({ id: "a", slug: "a", title: "A" })];
    const all = [auth, ...filtered];
    expect(selectVisibleNote(filtered, all, "a")?.id).toBe("a");
    expect(selectVisibleNote(filtered, all, "n1")?.id).toBe("n1");
    expect(selectVisibleNote(filtered, all, "missing")).toBeNull();
  });
});

describe("note drafts", () => {
  it("treats only an untitled empty body as blank", () => {
    expect(isBlankNote({ body: " \n", title: "Untitled" })).toBe(true);
    expect(isBlankNote({ body: "", title: "Saved" })).toBe(false);
    expect(isBlankNote({ body: "text", title: "Untitled" })).toBe(false);
  });

  it("enables Add to chat only for non-blank bodies", () => {
    expect(canAddNoteToChat("  ")).toBe(false);
    expect(canAddNoteToChat("hello")).toBe(true);
  });

  it("builds the Add-to-chat draft with a fallback title", () => {
    const draft = noteDraft(auth, { title: "  ", body: "# Fresh heading\n\nBody", tags: ["x"], sourceCwd: "/p" });
    expect(draft.title).toBe("Fresh heading");
    expect(draft.body).toBe("# Fresh heading\n\nBody");
    expect(draft.tags).toEqual(["x"]);
    expect(draft.sourceCwd).toBe("/p");
    expect(draft.id).toBe("n1");
  });

  it("keeps a focused blank title but falls back on blur", () => {
    const currentTitle = "Current";
    const body = "# Derived title\n\nBody";
    expect(resolveNoteTitle({ draftTitle: "", currentTitle, body, titleFocused: true })).toBe(currentTitle);
    expect(resolveNoteTitle({ draftTitle: "", currentTitle, body, titleFocused: false })).toBe("Derived title");
    expect(resolveNoteTitle({ currentTitle, body, titleFocused: false })).toBe(currentTitle);
    expect(resolveNoteTitle({ draftTitle: " Typed ", currentTitle, body, titleFocused: true })).toBe("Typed");
  });

  it("detects changes to title, body, tags and project", () => {
    const current = { title: "T", body: "B", tags: ["a"], sourceCwd: "/p" };
    expect(isNoteDirty(current, { title: "T", body: "B", tags: ["a"], projectPath: "/p" })).toBe(false);
    expect(isNoteDirty(current, { title: "T2", body: "B", tags: ["a"], projectPath: "/p" })).toBe(true);
    expect(isNoteDirty(current, { title: "T", body: "B2", tags: ["a"], projectPath: "/p" })).toBe(true);
    expect(isNoteDirty(current, { title: "T", body: "B", tags: ["b"], projectPath: "/p" })).toBe(true);
    expect(isNoteDirty(current, { title: "T", body: "B", tags: ["a"], projectPath: "/q" })).toBe(true);
    expect(isNoteDirty(current, { title: "T", body: "B", tags: ["a"], projectPath: "" })).toBe(true);
    expect(isNoteDirty(current, { title: "T", body: "B", tags: ["a"], projectPath: null })).toBe(false);
  });

  it("clears only the edits included in the accepted save", () => {
    const changes = { title: "T", body: "B", tags: ["a"] };
    expect(remainingNoteEdits(changes, changes, { titleFocused: true })).toEqual({ title: "T" });
    expect(remainingNoteEdits(changes, changes, { titleFocused: false })).toEqual({});
    expect(
      remainingNoteEdits({ ...changes, title: "newer" }, changes, { titleFocused: false }),
    ).toEqual({ title: "newer" });
  });

  it("builds an upsert payload and omits an unset project", () => {
    expect(noteUpsertInput(auth, { title: "T", body: "B", tags: ["a"], projectPath: "/p" })).toEqual({
      id: "n1",
      title: "T",
      body: "B",
      tags: ["a"],
      sourceCwd: "/p",
    });
    expect(noteUpsertInput(auth, { title: "T", body: "B", tags: ["a"], projectPath: null })).toEqual({
      id: "n1",
      title: "T",
      body: "B",
      tags: ["a"],
    });
    expect(noteUpsertInput(auth, { title: "T", body: "B", tags: ["a"], projectPath: "" })).toEqual({
      id: "n1",
      title: "T",
      body: "B",
      tags: ["a"],
      sourceCwd: "",
    });
  });

  it("compares tag lists by order", () => {
    expect(sameTags(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTags(["a", "b"], ["b", "a"])).toBe(false);
    expect(addNoteTag(["ideas"], "#Project Docs")).toEqual(["ideas", "project-docs"]);
  });
});

describe("note input and drops", () => {
  it("parses comma-terminated tag input", () => {
    expect(parseTagInput("ideas,")).toEqual({ action: "add", value: "ideas" });
    expect(parseTagInput("ideas")).toEqual({ action: "draft", value: "ideas" });
  });

  it("maps tag-field keys", () => {
    expect(resolveTagKeyDown({ key: "Enter", value: "", tagCount: 0 })).toBe("add");
    expect(resolveTagKeyDown({ key: ",", value: "x", tagCount: 0 })).toBe("add");
    expect(resolveTagKeyDown({ key: "Backspace", value: "", tagCount: 1 })).toBe("remove-last");
    expect(resolveTagKeyDown({ key: "Backspace", value: "x", tagCount: 1 })).toBeNull();
    expect(resolveTagKeyDown({ key: "a", value: "", tagCount: 0 })).toBeNull();
  });

  it("maps title and overlay keys", () => {
    expect(resolveTitleKeyDown("Enter")).toBe("blur");
    expect(resolveTitleKeyDown("Escape")).toBeNull();
    expect(resolveNotesEscapeKey("Escape")).toBe("close");
    expect(resolveNotesEscapeKey("Enter")).toBeNull();
  });

  it("recognizes file drags only", () => {
    expect(hasDroppedFiles({ types: ["Files"] })).toBe(true);
    expect(hasDroppedFiles({ types: ["application/x-moz-file"] })).toBe(true);
    expect(hasDroppedFiles({ types: ["text/plain"] })).toBe(false);
    expect(hasDroppedFiles(null)).toBe(false);
  });

  it("converts retina coordinates only when they exceed the viewport", () => {
    expect(
      toClientPoint({ x: 1600, y: 1200, devicePixelRatio: 2, innerWidth: 1000, innerHeight: 800 }),
    ).toEqual({ x: 800, y: 600 });
    expect(
      toClientPoint({ x: 400, y: 300, devicePixelRatio: 2, innerWidth: 1000, innerHeight: 800 }),
    ).toEqual({ x: 400, y: 300 });
    expect(
      toClientPoint({ x: 400, y: 300, devicePixelRatio: 0, innerWidth: 1000, innerHeight: 800 }),
    ).toEqual({ x: 400, y: 300 });
  });

  it("tests rect containment inclusively and throttles rapid drops", () => {
    const rect = { left: 10, right: 20, top: 5, bottom: 15 };
    expect(isPointInRect({ x: 10, y: 5 }, rect)).toBe(true);
    expect(isPointInRect({ x: 20, y: 15 }, rect)).toBe(true);
    expect(isPointInRect({ x: 9, y: 10 }, rect)).toBe(false);
    expect(isDropThrottled(1000, 1100)).toBe(true);
    expect(isDropThrottled(1000, 1250)).toBe(false);
    expect(isDropThrottled(1000, 1300, 400)).toBe(true);
  });
});

describe("note save queue", () => {
  beforeEach(() => resetNoteSaveQueues());

  test("serializes saves and hands the previous result to the next one", async () => {
    const order: string[] = [];
    const first = enqueueNoteSave("n1", async () => {
      await Promise.resolve();
      order.push("first");
      return { ...auth, title: "one" };
    });
    const second = enqueueNoteSave("n1", async (latest) => {
      order.push(`second:${latest?.title ?? "none"}`);
      return { ...auth, title: "two" };
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second:one"]);
  });

  test("keeps running after a failed save", async () => {
    const order: string[] = [];
    const first = enqueueNoteSave("n1", async () => {
      order.push("first");
      throw new Error("disk full");
    });
    const second = enqueueNoteSave("n1", async () => {
      order.push("second");
    });
    await expect(first).rejects.toThrow("disk full");
    await expect(second).resolves.toBeUndefined();
    expect(order).toEqual(["first", "second"]);
  });
});
