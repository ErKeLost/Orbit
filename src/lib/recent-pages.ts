/**
 * Recently opened pages, newest first, for the new-tab page.
 *
 * A browser's start page is only as good as what it remembers, and Orbit had
 * nothing to remember with: tabs live in memory and disappear on quit. This
 * keeps the last few real pages in localStorage — same shape a browser uses for
 * "recently visited" — so the start page can offer them back instead of a logo.
 *
 * Only `http(s)` pages are stored: `about:blank`, empty tabs and app-internal
 * pages are not places you want to return to.
 */

const STORAGE_KEY = "orbit.browser.recentPages";
const LIMIT = 8;

export type RecentPage = {
  /** Full URL, newest wins. */
  url: string;
  /** Page title when the page gave one, otherwise the host. */
  title: string;
  /** Epoch milliseconds of the last visit. */
  visitedAt: number;
};

/** Host without `www.`, which is what a tile label should say. */
export function pageHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function readRecentPages(): RecentPage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentPage =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentPage).url === "string" &&
        /^https?:\/\//i.test((entry as RecentPage).url),
    );
  } catch {
    return [];
  }
}

/** Record a visit. Called for every page a tab actually settles on. */
export function recordRecentPage(url: string, title: string | undefined) {
  if (!/^https?:\/\//i.test(url)) return;
  const entry: RecentPage = {
    url,
    title: (title ?? "").trim() || pageHost(url),
    visitedAt: Date.now(),
  };
  const rest = readRecentPages().filter((page) => page.url !== url);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...rest].slice(0, LIMIT)));
  } catch {
    /* storage unavailable: the start page just stays empty */
  }
  window.dispatchEvent(new Event("orbit:browser-recent"));
}

export function forgetRecentPage(url: string) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(readRecentPages().filter((page) => page.url !== url)),
    );
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event("orbit:browser-recent"));
}
