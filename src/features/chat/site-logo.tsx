import { useEffect, useMemo, useState } from "react";
import { Globe } from "../../shared/ui/icons";
import { urlHost } from "./web-search-site";

/** The site's own favicon first; the icon services only run when it refuses. */
const faviconSources = (origin: string, host: string) => [
  `${origin}/favicon.ico`,
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
  `https://icons.duckduckgo.com/ip3/${host}.ico`,
];

/** A small site logo with remote-favicon fallbacks; a globe when all fail. */
export function SiteLogo({ origin }: { origin: string }) {
  const host = urlHost(origin) ?? "";
  const sources = useMemo(() => faviconSources(origin, host), [origin, host]);
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [origin]);
  const src = sources[index];
  return (
    <span className="grid size-3.5 shrink-0 place-items-center overflow-hidden">
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-3.5 rounded-[3px] object-contain"
          onError={() => setIndex((value) => value + 1)}
        />
      ) : (
        <Globe className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
      )}
    </span>
  );
}
