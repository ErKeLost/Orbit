import { describe, expect, it } from "bun:test";
import {
  appendNoteReference,
  composeNoteMessage,
  injectNotePrompt,
  noteCardMeta,
  notePreview,
  noteSourceProject,
  noteSlugsInText,
  normalizeNoteTags,
  noteTitle,
  type Note,
} from "../src/features/notes/notes";

function note(
  partial: Partial<Note> & Pick<Note, "id" | "slug" | "title">,
): Note {
  return {
    body: "",
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("noteTitle", () => {
  it("uses the first heading", () => {
    expect(noteTitle("intro\n# Auth approach\n\nbody")).toBe("Auth approach");
  });

  it("falls back to the first prose line", () => {
    expect(noteTitle("Ship the notes overlay first.")).toBe(
      "Ship the notes overlay first.",
    );
  });

  it("returns Untitled when empty", () => {
    expect(noteTitle("   \n```\ncode\n```\n")).toBe("Untitled");
  });
});

describe("normalizeNoteTags", () => {
  it("normalizes, deduplicates, and drops empty tags", () => {
    expect(
      normalizeNoteTags([" Ideas ", "#Project Docs", "ideas", "###"]),
    ).toEqual(["ideas", "project-docs"]);
  });
});

describe("notePreview", () => {
  it("skips the title heading", () => {
    expect(notePreview("# Auth\n\nKeep it global.", "Auth")).toBe(
      "Keep it global.",
    );
  });
});

describe("noteSourceProject", () => {
  it("returns the folder name for real projects", () => {
    expect(noteSourceProject("/Users/me/Code/Auth")).toBe("Auth");
  });

  it("rejects home and bogus paths", () => {
    expect(noteSourceProject("~")).toBeNull();
    expect(noteSourceProject("/")).toBeNull();
    expect(noteSourceProject(undefined)).toBeNull();
  });
});

describe("noteSlugsInText", () => {
  it("finds unique @note/ mentions", () => {
    expect(noteSlugsInText("see @note/auth and @note/auth-2 plus @note/auth")).toEqual([
      "auth",
      "auth-2",
    ]);
  });
});

describe("appendNoteReference", () => {
  it("appends a titled note block", () => {
    expect(appendNoteReference("", "Plan", "do things")).toBe(
      "Note: Plan\n\ndo things\n\n",
    );
  });

  it("skips empty bodies", () => {
    expect(appendNoteReference("draft", "Plan", "   ")).toBe("draft");
  });
});

describe("injectNotePrompt", () => {
  it("appends referenced notes after a separator", () => {
    const text = injectNotePrompt("explain", [
      note({ id: "n1", slug: "auth", title: "Auth", body: "use otp" }),
    ]);
    expect(text).toBe(
      'explain\n\n---\nReferenced note "Auth":\n\nuse otp',
    );
  });
});

describe("composeNoteMessage", () => {
  it("leads with the user text", () => {
    const message = composeNoteMessage(
      {
        id: "n1",
        slug: "auth",
        title: "Auth",
        body: "use otp",
      },
      "review this",
    );
    expect(message.startsWith("review this")).toBe(true);
    expect(message).toContain('Referenced note "Auth"');
  });

  it("falls back to a default lead", () => {
    const message = composeNoteMessage(
      { id: "n1", slug: "auth", title: "Auth", body: "use otp" },
      "  ",
    );
    expect(message.startsWith("Use this note.")).toBe(true);
  });
});

describe("noteCardMeta", () => {
  it("keeps display fields only", () => {
    const meta = noteCardMeta({
      id: "n1",
      slug: "auth",
      title: "Auth",
      body: "secret",
      sourceCwd: "/work/Auth",
    });
    expect(meta).toEqual({
      id: "n1",
      slug: "auth",
      title: "Auth",
      sourceCwd: "/work/Auth",
    });
  });
});
