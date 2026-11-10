import { useEffect, useState } from "react";
import { currentShortcut, shortcutTokens } from "../../lib/keybindings";
import { forgetRecentPage, readRecentPages, type RecentPage } from "../../lib/recent-pages";
import { useWorkspace } from "../../lib/store";
import { FileScript, PanelRightToggle, Search, Terminal, X } from "../../shared/ui/icons";
import { useShell } from "../shell/shellStore";

/**
 * The new-tab page.
 *
 * A new tab used to be the app's logo and nothing else — one more empty screen
 * in a workspace that already has the galaxy. This is the two things a start
 * page is actually for: the shortcuts you would otherwise hunt through menus
 * for, keycaps included, and the pages you were just on.
 *
 * Nothing here is invented: the tools dispatch the same commands their
 * keybindings do, and the recommendations come from this window's own visits
 * (`lib/recent-pages.ts`), so with no visits the second section is simply absent.
 */
export function BrowserStart({ onOpen }: { onOpen: (url: string) => void }) {
  const recent = useRecentPages();
  return (
    <div className="browser-start">
      <div className="browser-start-inner">
        <Section label="工具">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TOOLS.map((tool) => (
              <button
                key={tool.command}
                type="button"
                onClick={tool.run}
                className="group flex h-11 items-center gap-2.5 rounded-card border border-line bg-surface-card px-3 text-left hover:border-line-strong hover:bg-surface-raised"
              >
                <tool.icon className="size-4 shrink-0 text-ink-3 group-hover:text-ink-2" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate text-ui text-ink-2 group-hover:text-ink-1">{tool.label}</span>
                <Keycaps chord={currentShortcut(tool.command)} />
              </button>
            ))}
          </div>
        </Section>

        {recent.length > 0 ? (
          <Section label="最近">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {recent.map((page) => (
                <RecentTile key={page.url} page={page} onOpen={onOpen} />
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}

const TOOLS = [
  {
    command: "App: Quick Open",
    label: "转到文件",
    icon: FileScript,
    run: () => useShell.getState().setQuickOpen(true),
  },
  {
    command: "App: Search",
    label: "搜索全部",
    icon: Search,
    run: () => useWorkspace.getState().set({ panel: "search" }),
  },
  {
    command: "Terminal: Toggle",
    label: "终端",
    icon: Terminal,
    run: () => useShell.getState().setTerminalOpen(true),
  },
  {
    command: "Panel: Toggle Inspector",
    label: "检视栏",
    icon: PanelRightToggle,
    run: () => useShell.getState().setInspectorOpen(true),
  },
] as const;

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-0.5 text-2xs leading-4 text-ink-3">{label}</h2>
      {children}
    </section>
  );
}

/** A shortcut as keycaps: one box per key, the way the settings list shows it. */
function Keycaps({ chord }: { chord: string }) {
  const keys = shortcutTokens(chord);
  if (keys.length === 0) return null;
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-0.5">
      {keys.map((key, index) => (
        <kbd
          key={`${key}-${index}`}
          className="grid h-5 min-w-5 place-items-center rounded-keycap border border-line bg-fill-weak px-1 text-2xs leading-none text-ink-3"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function useRecentPages() {
  const [pages, setPages] = useState<RecentPage[]>(() => readRecentPages());
  useEffect(() => {
    const refresh = () => setPages(readRecentPages());
    window.addEventListener("orbit:browser-recent", refresh);
    return () => window.removeEventListener("orbit:browser-recent", refresh);
  }, []);
  return pages;
}

function RecentTile({ page, onOpen }: { page: RecentPage; onOpen: (url: string) => void }) {
  const [iconBroken, setIconBroken] = useState(false);
  const host = pageHost(page.url);
  return (
    <div className="group relative">
      <button
        type="button"
        title={page.url}
        onClick={() => onOpen(page.url)}
        className="flex w-full flex-col items-center gap-2 rounded-card px-2 py-3 hover:bg-fill"
      >
        <span className="grid size-9 place-items-center overflow-hidden rounded-card border border-line bg-surface-card">
          {iconBroken ? (
            <span className="text-ui text-ink-3">{host.slice(0, 1).toUpperCase()}</span>
          ) : (
            <img
              src={`https://${host}/favicon.ico`}
              alt=""
              width={20}
              height={20}
              className="size-5 object-contain"
              onError={() => setIconBroken(true)}
            />
          )}
        </span>
        <span className="w-full truncate text-center text-2xs leading-4 text-ink-3 group-hover:text-ink-2">
          {page.title || host}
        </span>
      </button>
      <button
        type="button"
        aria-label={`从最近访问中移除 ${page.title || host}`}
        title="从最近访问中移除"
        onClick={() => forgetRecentPage(page.url)}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-keycap text-ink-3 opacity-0 hover:bg-fill-strong hover:text-ink-1 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <X className="size-3" strokeWidth={1.75} />
      </button>
    </div>
  );
}

function pageHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
