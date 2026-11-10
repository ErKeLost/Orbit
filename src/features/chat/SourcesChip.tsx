import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useShell } from "../shell/shellStore";
import { Popover } from "../../shared/ui/Popover";
import { ExternalLink } from "../../shared/ui/icons";
import { SiteLogo } from "./site-logo";
import { sourceSites, type TurnSource } from "./turn-sources";

/**
 * One page in the open list, named by its title and anchored by its site.
 *
 * A click lands where every other link in the transcript lands — the browser
 * panel beside the conversation — unless the click asks for the system browser.
 */
function SourceRow({ source }: { source: TurnSource }) {
  const title = source.title?.trim();
  return (
    <button
      type="button"
      className="group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill"
      title={`${title || source.host} · ${source.url}`}
      onClick={(event) => {
        const url = source.url;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          void openUrl(url).catch(() => undefined);
          return;
        }
        useShell.getState().openLink(url);
      }}
    >
      <SiteLogo origin={`https://${source.host}`} />
      <span className="min-w-0 flex-1 truncate font-sans text-ui text-ink-2">{title || source.host}</span>
      {title ? <span className="shrink-0 font-sans text-2xs text-ink-3">{source.host}</span> : null}
      <ExternalLink
        className="size-3 shrink-0 text-ink-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        strokeWidth={1.75}
      />
    </button>
  );
}

/**
 * The pages behind an answer, as a stack of favicons at the foot of the reply.
 *
 * Searches and fetches fold away with the rest of the work, and the answer that
 * cited them keeps no trace of where it came from. This is that trace: the
 * sites' own marks, how many pages were opened, and — on hover, or pinned by a
 * click — each page by name. Only pages the turn actually opened count, so a
 * turn that never fetched says nothing at all.
 */
export function SourcesRow({ sources }: { sources: TurnSource[] }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  // The list sits above the chip: the pointer has to cross a few pixels of gap
  // to reach it, so "left" waits a moment instead of closing under the cursor.
  const closeTimer = useRef<number | null>(null);
  const keepOpen = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setHovered(true);
  };
  const scheduleClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHovered(false);
    }, 160);
  };
  useEffect(() => () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  }, []);

  if (!sources.length) return null;
  const open = hovered || pinned;
  const sites = sourceSites(sources);
  const pages = `${sources.length} 个来源`;
  return (
    <div className="flex min-w-0 px-4 pb-1 pt-2">
      <button
        ref={chip}
        type="button"
        aria-expanded={open}
        aria-label={open ? "收起来源" : pages}
        onMouseEnter={keepOpen}
        onMouseLeave={scheduleClose}
        onClick={() => {
          // A pinned chip stays until it is clicked again: the pointer is still
          // on it, so clearing only the pin would leave the list sitting open.
          if (pinned) {
            setPinned(false);
            setHovered(false);
            return;
          }
          setPinned(true);
        }}
        className="group flex max-w-full items-center gap-1.5 rounded-full border border-line bg-fill-weak py-1 pl-1 pr-2.5 text-ink-3 transition-colors duration-150 hover:bg-fill hover:text-ink-2"
      >
        {/* Avatar group: overlapping marks, one per site, cut off at four —
            the count next to them says how many pages are behind it. */}
        <span className="flex shrink-0 items-center -space-x-1.5">
          {sites.map((site) => (
            <span
              key={site}
              className="grid size-4 place-items-center rounded-full bg-surface-card ring-1 ring-line transition-transform duration-150 group-hover:ring-line-strong"
            >
              <SiteLogo origin={`https://${site}`} />
            </span>
          ))}
        </span>
        <span className="min-w-0 truncate font-sans text-2xs tabular-nums">{pages}</span>
      </button>
      {open ? (
        <Popover
          anchor={chip}
          side="top"
          align="start"
          gap={6}
          onDismiss={() => {
            setPinned(false);
            setHovered(false);
          }}
          onMouseEnter={keepOpen}
          onMouseLeave={scheduleClose}
          className="w-[21rem] p-1"
        >
          <div className="max-h-64 min-w-0 overflow-y-auto">
            {sources.map((source) => (
              <SourceRow key={source.key} source={source} />
            ))}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
