import { useEffect, useMemo, useState } from "react";
import { Globe } from "../../shared/ui/icons";
import { urlHost } from "./web-search-site";

/** The site's own favicon first; the icon services only run when it refuses. */
const faviconSources = (origin: string, host: string) => [
  `${origin}/favicon.ico`,
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
  `https://icons.duckduckgo.com/ip3/${host}.ico`,
];

/**
 * The source that worked, per origin.
 *
 * A search result puts the same host on screen a dozen times, and each row would
 * otherwise start from "unknown" — a skeleton on every re-mount, even though the
 * icon is already in the webview's cache. Remembering the working source makes a
 * repeat row render instantly and leaves the skeleton for a first, real load.
 *
 * Only successes are remembered: one failed attempt (a flaky network, an icon
 * service timing out) must not turn a site into a globe for the rest of the
 * session — the next row retries from the first source.
 */
const RESOLVED = new Map<string, number>();

const startIndex = (origin: string) => RESOLVED.get(origin) ?? 0;

/**
 * A small site logo with remote-favicon fallbacks.
 *
 * Three states, and the empty box was the bug: while the favicon is on its way the
 * slot holds a skeleton instead of nothing (a row of blank squares reads as broken
 * icons), it fades in when it arrives, and only when every source has refused does
 * the globe stand in.
 */
export function SiteLogo({ origin }: { origin: string }) {
  const host = urlHost(origin) ?? "";
  const sources = useMemo(() => faviconSources(origin, host), [origin, host]);
  const [index, setIndex] = useState(() => startIndex(origin));
  // `undefined` until this instance has heard back from the image; a host with a
  // known answer skips straight to it.
  const [settled, setSettled] = useState<number | null | undefined>(() => RESOLVED.get(origin));

  useEffect(() => {
    setIndex(startIndex(origin));
    setSettled(RESOLVED.get(origin));
  }, [origin]);

  const failed = settled === null;
  const src = sources[settled ?? index];
  const ready = typeof settled === "number";

  if (!host || failed || !src) {
    return (
      <span className="grid size-3.5 shrink-0 place-items-center overflow-hidden">
        <Globe className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
      </span>
    );
  }

  return (
    <span className="relative grid size-3.5 shrink-0 place-items-center overflow-hidden">
      {/* 14px is small for a placeholder: the app's row skeleton (`bg-content/6`)
          disappears at this size, so this box uses the tone the title bar's own
          loading block uses. */}
      {ready ? null : <span aria-hidden className="absolute inset-0 animate-pulse rounded-[3px] bg-content/15" />}
      <img
        src={src}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={`size-3.5 rounded-[3px] object-contain transition-opacity duration-150 ${ready ? "opacity-100" : "opacity-0"}`}
        onLoad={() => {
          RESOLVED.set(origin, index);
          setSettled(index);
        }}
        onError={() => {
          // The next source is the next attempt; the last refusal is what makes
          // this a globe rather than an endless skeleton.
          if (index + 1 < sources.length) setIndex(index + 1);
          else setSettled(null);
        }}
      />
    </span>
  );
}
