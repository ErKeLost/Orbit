import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteLogo } from "../src/features/chat/site-logo";

/**
 * The favicon slot has to say something in every state.
 *
 * The bug was the empty state: while a favicon was on its way (or when both icon
 * services refused), the slot rendered a bare `<span>` — a row of those reads as
 * broken icons rather than as icons that have not arrived.
 */
describe("site logo", () => {
  test("holds a skeleton in the slot while the favicon is unknown", () => {
    const html = renderToStaticMarkup(<SiteLogo origin="https://www.binance.com" />);
    // The placeholder...
    expect(html).toContain("animate-pulse");
    // ...and the image that will replace it, invisible until it loads, so the
    // row never changes size when the icon arrives.
    expect(html).toContain("opacity-0");
    expect(html).toContain("https://www.binance.com/favicon.ico");
  });

  test("falls back to a globe when there is no host to ask", () => {
    const html = renderToStaticMarkup(<SiteLogo origin="" />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("animate-pulse");
  });

  test("asks the site itself first, then the icon services", () => {
    const html = renderToStaticMarkup(<SiteLogo origin="https://x.com" />);
    expect(html).toContain("https://x.com/favicon.ico");
    expect(html).not.toContain("google.com/s2"); // only on error, one source at a time
  });
});
