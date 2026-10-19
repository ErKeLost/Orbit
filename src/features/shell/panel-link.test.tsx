import { beforeEach, describe, expect, test } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../../components/Markdown";
import { browserTabPaths, newWorkspaceTab, useShell } from "./shellStore";

/**
 * A markdown link in the transcript belongs to the browser panel beside the
 * conversation, not to the system browser.
 *
 * `tests/link-surface.test.ts` covers the store rule ("first link opens a
 * browser pane, the next one navigates it"). This covers the other half: that a
 * click on the rendered anchor actually reaches that rule — the part that breaks
 * silently, because a link that opens nothing looks exactly like a link nobody
 * clicked.
 */
const browserTabs = () => browserTabPaths(useShell.getState().browserTabs);

beforeEach(() => {
  const workspace = newWorkspaceTab("/repo", "c1");
  useShell.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id, activeByProject: {}, browserTabs: [], browserActive: null, browserOpen: false });
});

async function render(content: string, links: "panel" | "external") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Markdown content={content} links={links} />);
  });
  return host;
}

function click(anchor: Element, init: MouseEventInit = {}) {
  return act(async () => {
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
}

describe("markdown links in a panel surface", () => {
  test("a click opens the page in the browser panel", async () => {
    const host = await render("see [the page](https://example.com/a)", "panel");
    expect(host.querySelector('[data-link-surface="panel"]')).not.toBeNull();
    const anchor = host.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("https://example.com/a");
    await click(anchor);
    expect(browserTabs()).toHaveLength(1);
    expect(useShell.getState().browserTabs[0]?.url).toBe("https://example.com/a");
  });

  test("a second link navigates the panel instead of opening another one", async () => {
    const first = await render("[one](https://a.example/one)", "panel");
    await click(first.querySelector("a")!);
    const second = await render("[two](https://b.example/two)", "panel");
    await click(second.querySelector("a")!);
    expect(browserTabs()).toHaveLength(1);
  });

  test("a surface that is not a panel keeps its link out of the panel", async () => {
    // A README in a file pane, or an issue body in the inbox, opens in the
    // user's own browser: no browser tab appears here.
    const host = await render("[doc](https://example.com/doc)", "external");
    await click(host.querySelector("a")!);
    expect(browserTabs()).toEqual([]);
  });
});
