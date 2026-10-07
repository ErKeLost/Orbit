import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerHighlight } from "../src/features/chat/ComposerHighlight";
import {
  buildMentionIndex,
  expandMentionLabels,
  fileMentionParts,
  mentionLabel,
  mentionTokenAt,
  projectMentionFiles,
  rankMentionFiles,
  replaceMentionToken,
  type MentionFile,
} from "../src/features/chat/fileMentions";
import { paletteRequest } from "../src/features/chat/ComposerPalette";

const files: MentionFile[] = [
  { name: "App.tsx", relative: "apps/desktop/src/App.tsx", path: "/p/apps/desktop/src/App.tsx", isDir: false },
  { name: "App.tsx", relative: "apps/web/src/App.tsx", path: "/p/apps/web/src/App.tsx", isDir: false },
  { name: "Composer.tsx", relative: "src/chrome/Composer.tsx", path: "/p/src/chrome/Composer.tsx", isDir: false },
  { name: "agent-activity.css", relative: "src/components/agents/agent-activity.css", path: "/p/src/components/agents/agent-activity.css", isDir: false },
];

const index = buildMentionIndex(files);

describe("mentionTokenAt", () => {
  test("reads the @token the cursor is in", () => {
    expect(mentionTokenAt("@Comp", 5)).toEqual({ start: 0, end: 5, query: "Comp" });
    expect(mentionTokenAt("look at @src/App", 16)).toEqual({ start: 8, end: 16, query: "src/App" });
  });

  test("ignores emails and mid-word @", () => {
    expect(mentionTokenAt("nick@example.com", 8)).toBeNull();
    expect(mentionTokenAt("a@b", 3)).toBeNull();
  });

  test("closes after a space", () => {
    expect(mentionTokenAt("@App.tsx now", 12)).toBeNull();
  });
});

describe("replaceMentionToken", () => {
  test("inserts @label and a trailing space", () => {
    expect(replaceMentionToken("@Comp", { start: 0, end: 5, query: "Comp" }, "Composer.tsx")).toBe("@Composer.tsx ");
    expect(replaceMentionToken("x @a y", { start: 2, end: 4, query: "a" }, "App.tsx")).toBe("x @App.tsx y");
  });
});

describe("buildMentionIndex", () => {
  test("labels unique basenames short and ambiguous ones by path", () => {
    expect(mentionLabel(files[2]!, index)).toBe("Composer.tsx");
    expect(mentionLabel(files[0]!, index)).toBe("apps/desktop/src/App.tsx");
  });

  test("keeps a spaced path as a single @ token", () => {
    const spaced: MentionFile[] = [{ name: "read me.md", relative: "docs/read me.md", path: "/p/docs/read me.md", isDir: false }];
    const spacedIndex = buildMentionIndex(spaced);
    expect(mentionLabel(spaced[0]!, spacedIndex)).toBe("docs/read-me.md");
    expect(spacedIndex.labels.get("docs/read-me.md")).toEqual(spaced[0]!);
    expect(spacedIndex.labels.has("read me.md")).toBe(false);
  });

  test("ignores paths that leave the project or break the tokenizer", () => {
    const unsafe = buildMentionIndex([
      { name: "secret", relative: "../secret", path: "/etc/secret", isDir: false },
      { name: "at.md", relative: "see@me.md", path: "/p/see@me.md", isDir: false },
    ]);
    expect(unsafe.labels.size).toBe(0);
  });

  test("adds parent folders so @ can point at a directory", () => {
    expect(index.labels.get("src/components/agents")?.isDir).toBe(true);
    expect(mentionLabel(files[3]!, index)).toBe("agent-activity.css");
  });
});

describe("rankMentionFiles", () => {
  test("prefers a basename hit over a directory-only hit", () => {
    expect(rankMentionFiles(files, "Composer")[0]?.relative).toBe("src/chrome/Composer.tsx");
  });

  test("without a query the shallowest paths lead", () => {
    const shallow: MentionFile[] = [
      { name: "deep.ts", relative: "src/a/b/deep.ts", path: "/p/src/a/b/deep.ts", isDir: false },
      { name: "root.ts", relative: "root.ts", path: "/p/root.ts", isDir: false },
    ];
    const ranked = rankMentionFiles(shallow, "").map((file) => file.relative);
    // Folders come first at equal depth, then the shallowest files.
    expect(ranked[0]).toBe("src");
    expect(ranked.indexOf("root.ts")).toBeLessThan(ranked.indexOf("src/a/b/deep.ts"));
  });

  test("matches loose characters across a path", () => {
    expect(rankMentionFiles(files, "agcss").map((file) => file.relative)).toContain("src/components/agents/agent-activity.css");
  });
});

describe("fileMentionParts", () => {
  test("finds a written @label and peels trailing punctuation", () => {
    const parts = fileMentionParts("look @Composer.tsx, then @src/chrome/Composer.tsx", index.labels);
    expect(parts.filter((part) => part.file).length).toBe(2);
    expect(parts.every((part) => part.text.length > 0)).toBe(true);
  });

  test("leaves unknown @words alone", () => {
    const parts = fileMentionParts("@nope @also-missing", index.labels);
    expect(parts).toEqual([{ text: "@nope @also-missing" }]);
  });
});

describe("expandMentionLabels", () => {
  test("spells the short label back out to a resolvable path", () => {
    expect(expandMentionLabels("read @Composer.tsx please", index.labels)).toBe("read @src/chrome/Composer.tsx please");
  });

  test("keeps paths that are already relative, and plain text", () => {
    expect(expandMentionLabels("read @src/chrome/Composer.tsx", index.labels)).toBe("read @src/chrome/Composer.tsx");
    expect(expandMentionLabels("no mentions here", index.labels)).toBe("no mentions here");
  });
});

describe("paletteRequest", () => {
  test("opens for @ anywhere and / at the start", () => {
    expect(paletteRequest("hey @ag", 7)).toEqual({ kind: "mention", query: "ag", start: 4, end: 7 });
    expect(paletteRequest("/plan", 5)).toEqual({ kind: "slash", query: "plan", start: 0, end: 5 });
  });

  test("stays closed once the token is finished", () => {
    expect(paletteRequest("@agent-activity.css ", 20)).toBeNull();
    expect(paletteRequest("text /plan", 10)).toBeNull();
  });
});

describe("ComposerHighlight", () => {
  const names = new Set(["web-search"]);

  test("paints a picked mention instead of the raw @path", () => {
    const html = renderToStaticMarkup(
      <ComposerHighlight text="@agent-activity.css" names={names} mentions={index.labels} />,
    );
    expect(html).toContain("text-mention");
    expect(html).toContain("agent-activity.css");
    expect(html).toContain("text-transparent");
  });

  test("paints a known skill but not an unknown command", () => {
    expect(renderToStaticMarkup(<ComposerHighlight text="/web-search hi" names={names} mentions={index.labels} />))
      .toContain("text-skill");
    expect(renderToStaticMarkup(<ComposerHighlight text="/nope hi" names={names} mentions={index.labels} />))
      .not.toContain("text-skill");
  });

  test("leaves plain drafts unstyled", () => {
    const html = renderToStaticMarkup(<ComposerHighlight text="just a message" names={names} mentions={index.labels} />);
    expect(html).toBe("just a message");
  });
});

describe("projectMentionFiles", () => {
  test("rebuilds absolute paths from the project root", () => {
    expect(projectMentionFiles(["src/App.tsx"], "/work/pi-gui/")).toEqual([
      { name: "App.tsx", relative: "src/App.tsx", path: "/work/pi-gui/src/App.tsx", isDir: false },
    ]);
  });
});
