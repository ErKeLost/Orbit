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

/** One hit on the results grid: a page, not just the site that published it. */
export type SearchHit = {
  id: string;
  title: string;
  url: string;
  host: string;
  snippet?: string;
};

function usableHost(host: string | undefined): host is string {
  const name = host?.toLowerCase().replace(/\.$/, "");
  return Boolean(name && HOST.test(name) && !ENGINE_HOST.test(name) && !ASSET_HOST.test(name));
}

function cleanUrl(raw: string) {
  return raw.replace(/&amp;/g, "&").replace(/[),.;]+$/g, "");
}

function decodeText(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** The page a numbered result actually points at, unwrapping Bing's `u=a1` redirect. */
function resultUrl(blob: string) {
  const wrapped = /[?&]u=a1([A-Za-z0-9_-]{16,})/.exec(blob);
  const fromWrap = wrapped ? wrappedTarget(wrapped[1]) : undefined;
  if (fromWrap && usableHost(urlHost(fromWrap))) return fromWrap;
  const heading = /##\s+\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i.exec(blob);
  if (heading) {
    const url = cleanUrl(heading[1]);
    if (usableHost(urlHost(url))) return url;
  }
  const italic = /\*(https?:\/\/[^\s*]+)\*/.exec(blob);
  if (italic) {
    const url = cleanUrl(italic[1]);
    if (usableHost(urlHost(url))) return url;
  }
  for (const match of blob.matchAll(/https?:\/\/[^\s)\]>"']+/gi)) {
    const url = cleanUrl(match[0]);
    if (usableHost(urlHost(url))) return url;
  }
  return undefined;
}

function resultTitle(blob: string, url: string, host: string) {
  const heading = /##\s+\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(blob);
  if (heading?.[1].trim()) return decodeText(heading[1].trim());
  for (const match of blob.matchAll(/\[([^\]!]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    const text = match[1].trim();
    const link = cleanUrl(match[2]);
    if (!text || /^https?:/i.test(text)) continue;
    if (link === url || urlHost(link) === host) return decodeText(text);
  }
  return host.replace(/^www\./, "");
}

function resultSnippet(lines: string[], title: string) {
  const body = lines
    .slice(1)
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutTitle = body.replace(title, "").replace(/\s+/g, " ").trim();
  const text = withoutTitle.length >= 12 ? withoutTitle : body;
  if (text.length < 12 || text === title) return undefined;
  return text.slice(0, 180);
}

/**
 * The pages a search result lists, in the order the engine returned them.
 *
 * Logos only need hosts. The results grid needs the page title and the URL a
 * click should open, which live on the heading under each numbered line — not
 * in the engine's own icon markup.
 */
export function searchResults(text: string, limit = 12): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (!/^\s{0,4}\d+\.\s/.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s{0,4}\d+\.\s/.test(lines[j])) break;
      if (!lines[j].trim() && block.length > 1) break;
      block.push(lines[j]);
      if (block.length > 8) break;
    }
    const blob = block.join("\n");
    const url = resultUrl(blob);
    const host = url ? urlHost(url) : undefined;
    if (!url || !host || !usableHost(host)) continue;
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const title = resultTitle(blob, url, host);
    hits.push({ id: key, title, url, host, snippet: resultSnippet(block, title) });
  }
  return hits;
}

/** `developer.mozilla.org` reads as "mozilla", the name people say. */
export function siteLabel(url: string) {
  const host = urlHost(url)?.replace(/^www\./, "");
  if (!host) return url;
  return registrableHost(host).split(".")[0] || host;
}

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
