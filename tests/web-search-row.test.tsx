import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Part } from "../src/lib/protocol";
import { SiteLogo } from "../src/features/chat/site-logo";
import { isSearchWidget, toolLabel } from "../src/features/chat/turnModel";
import { resultSites, searchResults, siteLabel, urlHost, urlOrigin } from "../src/features/chat/web-search-site";

const webCall = (args: Record<string, string>): Part => ({ type: "toolCall", id: "t1", name: "web_search", arguments: args });

describe("web search tool rows", () => {
  test("a query row names the search, not a file, and asks for a site chip", () => {
    const label = toolLabel(webCall({ mode: "search", query: "Grok Voice 3.0 API pricing" }), {});
    expect(label).toEqual({ action: "Search", target: "Grok Voice 3.0 API pricing", file: false, web: true, href: undefined });
  });

  test("a fetch row shows the page URL and the site it came from", () => {
    const label = toolLabel(webCall({ mode: "fetch", url: "https://grok.com/pricing?from=search" }), {});
    expect(label.action).toBe("Fetch");
    expect(label.target).toBe("https://grok.com/pricing?from=search");
    expect(label.web).toBe(true);
    expect(urlHost(label.href)).toBe("grok.com");
  });

  test("a highlights row still reads as a fetch", () => {
    const label = toolLabel(webCall({ mode: "highlights", url: "https://example.com/a", query: "realtime" }), {});
    expect(label).toMatchObject({ action: "Fetch", target: "https://example.com/a", web: true });
  });

  test("local searches keep the old grammar but never say Find", () => {
    const grep = toolLabel({ type: "toolCall", name: "grep", arguments: { pattern: "TODO" } }, {});
    expect(grep).toMatchObject({ action: "Search", target: "TODO", file: false });
    expect(grep.web).toBeUndefined();
    const list = toolLabel({ type: "toolCall", name: "list_files", arguments: { path: "src" } }, {});
    expect(list.action).toBe("List");
  });
});

describe("site origins", () => {
  test("parses and normalizes", () => {
    expect(urlOrigin("https://www.bing.com/search?q=a")).toBe("https://www.bing.com");
    expect(urlOrigin("grok.com")).toBe("https://grok.com");
    expect(urlOrigin("not a url")).toBeUndefined();
    expect(urlHost("https://icons.duckduckgo.com/ip3/x.ico")).toBe("icons.duckduckgo.com");
  });

  test("the logo prefers the site's own favicon", () => {
    const html = renderToStaticMarkup(<SiteLogo origin="https://www.bing.com" />);
    expect(html).toContain('src="https://www.bing.com/favicon.ico"');
    expect(html).not.toContain("s2/favicons");
  });
});

/** One numbered Bing result line, shaped exactly like Expand's markdown. */
function bingResult(host: string, url: string) {
  const wrapped = Buffer.from(url, "utf8").toString("base64url");
  return `[![Global web icon](https://th.bing.com/th/id/ODLS.A2?w=32&h=32) ${host} *${url}*](/ck/a?!&&p=abc123&u=a1${wrapped})\n   ## [Title](${url})\n   Snippet text.`;
}

const searchMarkdown = [
  '---\nurl: "https://www.bing.com/search?q=TanStack+Start+v1&rdr=1"\ntitle: "TanStack Start v1 - Search"\n---',
  "About 10,800 results",
  `1. ${bingResult("tanstack.com", "https://tanstack.com/start")}`,
  `2. ${bingResult("dev.to", "https://dev.to/codeparrot/tanstack-for-beginners")}`,
  `3. ${bingResult("github.com", "https://github.com/TanStack/router")}`,
  `4. ${bingResult("betterstack.com", "https://betterstack.com/community/guides/scaling-nodejs/tanstack-for-beginners/")}`,
].join("\n");

describe("searched sites", () => {
  test("lists the sites the search returned, in result order", () => {
    expect(resultSites(searchMarkdown)).toEqual(["tanstack.com", "dev.to", "github.com", "betterstack.com"]);
  });

  test("never reports the engine, its icon hosts, or the page header", () => {
    expect(resultSites(searchMarkdown)).not.toContain("www.bing.com");
    expect(resultSites(searchMarkdown)).not.toContain("th.bing.com");
  });

  test("counts a site once even when a subdomain is cited", () => {
    const markdown = [
      `1. ${bingResult("greyb.com", "https://pharsight.greyb.com/drug/xarelto")}`,
      `2. ${bingResult("www.drugpatentwatch.com", "https://www.drugpatentwatch.com/tradename/XARELTO")}`,
    ].join("\n");
    expect(resultSites(markdown)).toEqual(["greyb.com", "www.drugpatentwatch.com"]);
  });

  test("honors the limit and ignores prose", () => {
    expect(resultSites(searchMarkdown, 2)).toEqual(["tanstack.com", "dev.to"]);
    expect(resultSites("Expand Web Search：query\n\n没有结果")).toEqual([]);
  });
});

describe("search result cards", () => {
  test("reads the page title, url and snippet, not the engine", () => {
    const hits = searchResults(searchMarkdown);
    expect(hits.map((hit) => hit.host)).toEqual(["tanstack.com", "dev.to", "github.com", "betterstack.com"]);
    expect(hits[0]).toMatchObject({ title: "Title", url: "https://tanstack.com/start", snippet: "Snippet text." });
    expect(hits.some((hit) => hit.host.includes("bing"))).toBe(false);
  });

  test("keeps two pages on one site, and drops a repeated url", () => {
    const markdown = [
      "1. [Spring animations](https://motion.dev/docs/spring)",
      "   Keeps its velocity when interrupted.",
      "2. [React springs](https://motion.dev/docs/react)",
      "   useSpring for anything interruptible.",
      "3. [Spring animations](https://motion.dev/docs/spring)",
      "   Duplicate of the first hit.",
    ].join("\n");
    expect(searchResults(markdown).map((hit) => hit.url)).toEqual([
      "https://motion.dev/docs/spring",
      "https://motion.dev/docs/react",
    ]);
    expect(searchResults(markdown)[0].title).toBe("Spring animations");
  });

  test("names a site the way people say it", () => {
    expect(siteLabel("https://developer.mozilla.org/en-US/docs/Web/CSS")).toBe("mozilla");
    expect(siteLabel("https://motion.dev/docs")).toBe("motion");
    expect(searchResults("Expand Web Search：query\n\n没有结果")).toEqual([]);
  });
});

describe("search widget", () => {
  test("a query is the card strip; a fetch stays a row", async () => {
    const { WebSearchTool } = await import("../src/features/chat/web-search");
    const search = webCall({ mode: "search", query: "spring animations react" });
    const fetch = webCall({ mode: "fetch", url: "https://motion.dev/docs" });
    expect(isSearchWidget(search, {})).toBe(true);
    expect(isSearchWidget(fetch, {})).toBe(false);
    expect(isSearchWidget(search, { t1: { name: "web_search", running: false, isError: true, result: "nope" } })).toBe(false);

    const html = renderToStaticMarkup(
      <WebSearchTool
        part={search}
        tools={{
          t1: {
            name: "web_search",
            running: false,
            result: [
              "Expand Web Search：spring animations react",
              "",
              "1. [Spring animations: physics based](https://motion.dev/docs/spring)",
              "   Keeps its velocity.",
              "2. [prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)",
              "   CSS media feature.",
            ].join("\n"),
          },
        }}
      />,
    );
    expect(html).toContain("Searched 2 sites");
    expect(html).toContain("Spring animations: physics based");
    expect(html).toContain("mozilla");
    expect(html).toContain('data-status="done"');
    expect(html).toContain("motion.dev/favicon.ico");
  });

  test("a running search names the query and holds empty slots", async () => {
    const { WebSearchTool } = await import("../src/features/chat/web-search");
    const html = renderToStaticMarkup(
      <WebSearchTool part={webCall({ mode: "search", query: "spring animations react" })} tools={{ t1: { name: "web_search", running: true } }} />,
    );
    expect(html).toContain("Searching");
    expect(html).toContain("spring animations react");
    expect(html).toContain('data-status="searching"');
    expect(html).not.toContain("Searched");
  });
});
