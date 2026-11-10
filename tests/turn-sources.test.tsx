import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Part, Tool } from "../src/lib/protocol";
import type { TurnStep } from "../src/features/chat/turnModel";
import { pageMeta } from "../src/features/chat/web-search-site";
import { sourceSites, turnSources } from "../src/features/chat/turn-sources";

const fetchMarkdown = (url: string, title: string, body = "Page text.") =>
  [`---\nurl: "${url}"\ntitle: "${title}"\n---`, body].join("\n");

const webCall = (id: string, args: Record<string, string>): Part => ({ type: "toolCall", id, name: "web_search", arguments: args });
const step = (part: Part): TurnStep => ({ key: part.id!, kind: "tool", part, messageIndex: 0, live: false });
const done = (result: string): Tool => ({ name: "web_search", running: false, result });

const fetchStep = (id: string, url: string, title: string) => step(webCall(id, { mode: "fetch", url }));

describe("page metadata", () => {
  test("reads the frontmatter a fetch writes", () => {
    expect(pageMeta(fetchMarkdown("https://grok.com/pricing", "Grok pricing"))).toEqual({
      url: "https://grok.com/pricing",
      title: "Grok pricing",
    });
  });

  test("is empty when the page has none", () => {
    expect(pageMeta("plain page text")).toEqual({});
  });
});

describe("turn sources", () => {
  test("lists the pages a turn opened, in order", () => {
    const steps = [fetchStep("a", "https://grok.com/pricing", "Grok pricing"), fetchStep("b", "https://tanstack.com/start", "TanStack Start")];
    const tools = {
      a: done(fetchMarkdown("https://grok.com/pricing", "Grok pricing")),
      b: done(fetchMarkdown("https://tanstack.com/start", "TanStack Start")),
    };
    expect(turnSources(steps, tools)).toEqual([
      { host: "grok.com", title: "Grok pricing", url: "https://grok.com/pricing", key: "https://grok.com/pricing" },
      { host: "tanstack.com", title: "TanStack Start", url: "https://tanstack.com/start", key: "https://tanstack.com/start" },
    ]);
    expect(sourceSites(turnSources(steps, tools))).toEqual(["grok.com", "tanstack.com"]);
  });

  test("a search alone is not a source: nothing was opened", () => {
    const steps = [step(webCall("s", { mode: "search", query: "tanstack start" }))];
    const tools = {
      s: done('---\nurl: "https://www.bing.com/search?q=tanstack"\ntitle: "Search"\n---\n1. tanstack.com *https://tanstack.com/start*\n   ## [TanStack Start](https://tanstack.com/start)'),
    };
    expect(turnSources(steps, tools)).toEqual([]);
  });

  test("a highlights read counts as an opened page", () => {
    const steps = [step(webCall("h", { mode: "highlights", url: "https://example.com/a", query: "realtime" }))];
    const tools = { h: done(fetchMarkdown("https://example.com/a", "Example")) };
    expect(turnSources(steps, tools)).toHaveLength(1);
  });

  test("the same page twice is one source", () => {
    const steps = [fetchStep("a", "https://grok.com/pricing", "Grok pricing"), fetchStep("b", "https://grok.com/pricing", "Grok pricing")];
    const tools = { a: done(fetchMarkdown("https://grok.com/pricing", "Grok pricing")), b: done(fetchMarkdown("https://grok.com/pricing", "Grok pricing")) };
    expect(turnSources(steps, tools)).toHaveLength(1);
  });

  test("the page's own address wins over the one the agent typed", () => {
    const steps = [fetchStep("a", "https://grok.com/share?q=1", "Grok pricing")];
    const tools = { a: done(fetchMarkdown("https://grok.com/pricing", "Grok pricing")) };
    expect(turnSources(steps, tools)[0]).toMatchObject({ url: "https://grok.com/pricing", host: "grok.com" });
  });

  test("local reads, failed calls and running calls are not sources", () => {
    const read: Part = { type: "toolCall", id: "r", name: "read", arguments: { path: "src/main.tsx" } };
    const failed = webCall("f", { mode: "fetch", url: "https://example.com/gone" });
    const running = webCall("w", { mode: "fetch", url: "https://example.com/wip" });
    const steps = [step(read), step(failed), step(running)];
    const tools = {
      r: { name: "read", running: false, result: "file contents" },
      f: { name: "web_search", running: false, isError: true, result: "404" },
      w: { name: "web_search", running: true },
    };
    expect(turnSources(steps, tools)).toEqual([]);
  });

  test("caps the list", () => {
    const steps = Array.from({ length: 20 }, (_, index) => fetchStep(`t${index}`, `https://example.com/${index}`, `Page ${index}`));
    const tools = Object.fromEntries(steps.map((item, index) => [item.part!.id!, done(fetchMarkdown(`https://example.com/${index}`, `Page ${index}`))]));
    expect(turnSources(steps, tools)).toHaveLength(12);
  });
});

describe("the sources chip", () => {
  test("stacks one avatar per site and counts the pages", async () => {
    const { SourcesRow } = await import("../src/features/chat/SourcesChip");
    const sources = turnSources(
      [fetchStep("a", "https://grok.com/pricing", "Grok pricing"), fetchStep("b", "https://grok.com/docs", "Grok docs")],
      {
        a: done(fetchMarkdown("https://grok.com/pricing", "Grok pricing")),
        b: done(fetchMarkdown("https://grok.com/docs", "Grok docs")),
      },
    );
    const html = renderToStaticMarkup(<SourcesRow sources={sources} />);
    expect(html).toContain("2 个来源");
    expect(html).toContain('aria-expanded="false"');
    // One site, one avatar — two pages of it still make a single mark.
    expect(html.match(/favicon\.ico/g)).toHaveLength(1);
    // The list itself is a hover surface: it is not in the document until asked.
    expect(html).not.toContain("Grok docs</span>");
  });

  test("renders nothing when the turn opened no page", async () => {
    const { SourcesRow } = await import("../src/features/chat/SourcesChip");
    expect(renderToStaticMarkup(<SourcesRow sources={[]} />)).toBe("");
  });
});
