import type { Part, Tool } from "../../lib/protocol";
import { toolResultText } from "../../lib/protocol";
import { toolLabel, type TurnStep } from "./turnModel";
import { pageMeta, registrableHost, urlHost, type WebSource } from "./web-search-site";

/**
 * One page a turn opened, reduced to what the sources row needs.
 *
 * `key` is stable across renders (the page's URL) so React can animate the list
 * without remounting rows.
 */
export type TurnSource = WebSource & { url: string; key: string };

/** A reply that opened a dozen pages does not need to print all of them. */
const MAX_SOURCES = 12;

function partSource(part: Part, tools: Record<string, Tool>): WebSource | undefined {
  const tool = tools[part.id ?? ""];
  if (!tool || tool.running || tool.isError) return undefined;
  const label = toolLabel(part, tools);
  // Only a page the turn actually opened counts. A search lists candidates the
  // agent never read — it read the ones it then fetched, and those are here.
  if (!label.web || !label.href) return undefined;
  const meta = pageMeta(toolResultText(tool.result));
  const url = meta.url && /^https?:\/\//i.test(meta.url) ? meta.url : label.href;
  const host = urlHost(url);
  return host ? { host, title: meta.title, url } : undefined;
}

/**
 * The pages behind one answer, in the order the turn opened them.
 *
 * The work fold is closed once the turn settles, so this is the only place the
 * pages survive: one row per fetched page, deduped by URL.
 */
export function turnSources(steps: TurnStep[], tools: Record<string, Tool>): TurnSource[] {
  const sources: TurnSource[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.part?.type !== "toolCall") continue;
    const source = partSource(step.part, tools);
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push({ ...source, url: source.url, key: source.url });
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

/** The distinct sites behind the row, for the favicon avatars on the chip. */
export function sourceSites(sources: TurnSource[], limit = 4) {
  const sites: string[] = [];
  for (const source of sources) {
    const site = registrableHost(source.host);
    if (sites.includes(site)) continue;
    sites.push(site);
    if (sites.length >= limit) break;
  }
  return sites;
}
