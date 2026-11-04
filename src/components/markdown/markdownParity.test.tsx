import { beforeEach, describe, expect, test } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../Markdown";
import { newWorkspaceTab, useShell } from "../../features/shell/shellStore";
import { useWorkspace } from "../../lib/store";

/**
 * The parts of t3code's chat markdown that are about *what a thing is*:
 *
 * - a link to a web page carries the site's icon, so ten links in a row read as
 *   ten sites rather than ten identical blue sentences;
 * - a link to a file carries the file-type icon and opens the file, because a
 *   file is a door, not a web page;
 * - `![alt](x)` honours the extension: `png` is a picture, `mp4` is a player,
 *   `wav` is a row with a play button.
 *
 * The assertion is on the rendered DOM, not on the component tree: the bug these
 * guard against is "it renders, but it looks like the old renderer".
 */
beforeEach(() => {
  const workspace = newWorkspaceTab("/repo", "c1");
  useShell.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    activeByProject: {},
    browserTabs: [],
    browserActive: null,
    browserOpen: false,
  });
  useWorkspace.setState({ cwd: "/repo" });
});

async function render(content: string) {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(<Markdown content={content} links="panel" />);
  });
  return host;
}

function click(element: Element) {
  return act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
}

function openFiles() {
  const workspace = useShell.getState().workspaces[0]!;
  return Object.values(workspace.panes).flatMap((pane) => pane.files.map((file) => file.path));
}

describe("markdown parity with t3code", () => {
  test("an external link keeps the site icon and still opens in the panel", async () => {
    const host = await render("see [Google](https://www.google.com)");
    expect(host.querySelector(".md-link-icon")).not.toBeNull();
    await click(host.querySelector("a")!);
    expect(useShell.getState().browserTabs).toHaveLength(1);
  });

  test("a file link becomes a chip with the file-type icon and opens the file", async () => {
    const host = await render("see [README.md](README.md)");
    const chip = host.querySelector("a.md-file-chip")!;
    expect(chip.textContent).toContain("README.md");
    expect(chip.querySelector("span[aria-hidden]")).not.toBeNull();
    await click(chip);
    expect(openFiles()).toContain("/repo/README.md");
  });

  test("a line range survives on the chip", async () => {
    const host = await render("[cfg](vite.config.ts#L1-L10)");
    expect(host.querySelector("a.md-file-chip")?.textContent).toContain("L1-10");
  });

  test("image syntax dispatches on the extension: picture, video, audio", async () => {
    const host = await render("![clip](demo.mp4)\n\n![song](music.wav)\n\n![pic](a.png)");
    expect(host.querySelector("video")?.getAttribute("src")).toBe("/repo/demo.mp4");
    expect(host.querySelector(".md-audio")?.textContent).toContain("song");
    expect(host.querySelector("img.md-media")?.getAttribute("src")).toBe("/repo/a.png");
  });

  test("an unreachable media source says so instead of leaving a broken image", async () => {
    const host = await render("![diagram](https://example.com/missing.png)");
    await act(async () => {
      host.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(host.querySelector(".md-media-unavailable")?.textContent).toContain("diagram");
  });
});
