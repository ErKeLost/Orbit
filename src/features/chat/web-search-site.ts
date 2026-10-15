/** `https://grok.com/share?q=1` → `https://grok.com`; undefined if unparsable. */
export function urlOrigin(url: string | null | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : undefined;
  } catch {
    return undefined;
  }
}

export function urlHost(url: string | null | undefined) {
  return urlOrigin(url)?.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}

const HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}$/;
/** A result is never the engine that returned it, nor the fetch pipeline. */
const ENGINE_HOST = /^(?:[a-z0-9-]+\.)*(?:bing|google|gstatic|googleusercontent|duckduckgo|baidu|yandex|yahoo|ecosia|startpage|brave|qwant|expand)\.[a-z.]{2,}$/;
/** Icon and API hosts the engine's own markup points at. */
const ASSET_HOST = /^(?:th|img|imgs|images|static|cdn|assets|api|fonts)\./;
/** Second-level labels that belong to the public suffix, not the site. */
const MULTI_PART_SUFFIX = /^(?:co|com|org|net|gov|edu|ac)\.[a-z]{2}$/;

/** One entry per site: `pharsight.greyb.com` and `greyb.com` are the same site. */
function registrable(host: string) {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tail = labels.slice(-2).join(".");
  return labels.slice(MULTI_PART_SUFFIX.test(tail) ? -3 : -2).join(".");
}

/** Bing wraps every result link as `…&u=a1<base64url of the target URL>`. */
function wrappedTarget(payload: string) {
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const text = atob(padded);
    return /^https?:\/\//i.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

function accept(hosts: string[], host: string | undefined) {
  const name = host?.toLowerCase().replace(/\.$/, "");
  if (!name || !HOST.test(name) || ENGINE_HOST.test(name) || ASSET_HOST.test(name)) return;
  if (!hosts.some((seen) => registrable(seen) === registrable(name))) hosts.push(name);
}

/**
 * The sites a search actually returned, in result order.
 *
 * The engine's markdown names each result as `host *url*` and hides the real
 * URL in the link's `u=a1…` payload; both are mined per numbered result line so
 * the page's own header and icon hosts never leak into the list.
 */
export function resultSites(text: string, limit = 4): string[] {
  const hosts: string[] = [];
  for (const line of text.split("\n")) {
    if (!/^\s{0,4}\d+\.\s/.test(line)) continue;
    const breadcrumb = /(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,24})\s+\*/.exec(line);
    accept(hosts, breadcrumb?.[1]);
    const wrapped = /[?&]u=a1([A-Za-z0-9_-]{16,})/.exec(line);
    accept(hosts, wrapped ? urlHost(wrappedTarget(wrapped[1])) : undefined);
    if (hosts.length >= limit) return hosts.slice(0, limit);
    // Non-Bing providers (Google, DDG HTML, …) leave plain URLs instead.
    for (const match of line.matchAll(/https?:\/\/((?:[a-z0-9-]+\.)+[a-z]{2,24})/gi)) accept(hosts, match[1]);
    if (hosts.length >= limit) return hosts.slice(0, limit);
  }
  return hosts.slice(0, limit);
}
