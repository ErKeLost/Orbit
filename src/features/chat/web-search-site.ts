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
export function registrableHost(host: string) {
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
  if (!hosts.some((seen) => registrableHost(seen) === registrableHost(name))) hosts.push(name);
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

/** A page a turn opened: the site it belongs to, its address, and its own title. */
export type WebSource = { host: string; url?: string; title?: string };

/**
 * The frontmatter a fetched (or highlighted) page opens with. Expand writes the
 * page's own URL and title there, which is the only place a fetch result names
 * what it is — the tool result body is the page's text.
 */
export function pageMeta(text: string): { url?: string; title?: string } {
  const meta: { url?: string; title?: string } = {};
  const head = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!head) return meta;
  for (const line of head[1].split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (match[1].toLowerCase() === "url") meta.url = value;
    else if (match[1].toLowerCase() === "title") meta.title = value;
  }
  return meta;
}
