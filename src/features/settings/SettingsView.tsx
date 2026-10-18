import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "../../lib/store";
import { useAppearance } from "../../lib/appearance";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { PageHeader } from "../../shared/ui/controls";
import { RotateCcw, Search } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { IS_MAC, TrafficLightSpacer } from "../shell/chrome";
import { sectionOf } from "./SettingsNav";
import { jumpToSetting, searchSettings } from "./model/settings";
import { AppearancePage } from "./AppearancePage";
import { SkillsPage } from "./SkillsPage";
import { ChatPage } from "./ChatPage";
import { BrowserPage } from "./BrowserPage";
import { KeybindingsPage } from "./KeybindingsPage";
import { InboxSettings } from "../inbox/InboxView";

const GeneralSettingsPage = lazy(() => import("./pages/GeneralSettingsPage").then((m) => ({ default: m.GeneralSettingsPage })));
const ScreenSettingsPage = lazy(() => import("./pages/ScreenSettingsPage").then((m) => ({ default: m.ScreenSettingsPage })));
const PiToolsPage = lazy(() => import("./pages/PiToolsPage").then((m) => ({ default: m.PiToolsPage })));
const ProviderSettings = lazy(() => import("../../components/ProviderSettings").then((m) => ({ default: m.ProviderSettings })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then((m) => ({ default: m.IntegrationsPage })));
const ComputerUsePage = lazy(() => import("./pages/ComputerUsePage").then((m) => ({ default: m.ComputerUsePage })));

function DesktopOnly({ what }: { what: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3 px-4 py-6 text-center text-[13px] text-content/50">
      请在电脑端管理{what}。这些配置保存在运行 Pi 的电脑上。
    </div>
  );
}

/** Orbit `SettingsSearch`：按关键词搜到具体设置行，跳页并滚动定位。 */
function SettingsSearch() {
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLLabelElement>(null);
  const results = useMemo(() => searchSettings(query), [query]);
  return (
    <div className="flex shrink-0 items-center gap-1.5 pr-2" data-tauri-drag-region="false">
      <label ref={anchor} className="flex h-7 w-48 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
        <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索设置"
          aria-label="搜索设置"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
        />
      </label>
      {query.trim() ? (
        <Popover anchor={anchor} side="bottom" align="end" width={260} onDismiss={() => setQuery("")} className="overflow-y-auto p-1">
          {results.length === 0 ? <p className="px-2 py-1.5 text-[12px] text-content/45">没有匹配的设置</p> : null}
          {results.map((result) => (
            <button
              key={`${result.section}:${result.settingId ?? "section"}`}
              type="button"
              onClick={() => {
                jumpToSetting(result.section, result.settingId);
                setQuery("");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
            >
              <span className="min-w-0 flex-1 truncate">{result.label}</span>
              <span className="shrink-0 text-[11px] text-content/40">{result.sectionLabel}</span>
            </button>
          ))}
        </Popover>
      ) : null}
    </div>
  );
}

/** Orbit `SettingsView` frame: breadcrumb bar, page header, card groups. */
export function SettingsView() {
  const page = useWorkspace((state) => state.settingsPage);
  const desktop = useWorkspace((state) => state.runtimeTarget === "desktop");
  const restoreDefaults = useAppearance((state) => state.restoreDefaults);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement | null>(null);
  const section = sectionOf(page);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [page]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, [role=dialog]")) return;
      useWorkspace.getState().set({ panel: "chat" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let content: ReactNode;
  if (page === "general") content = <GeneralSettingsPage />;
  else if (page === "appearance") content = <AppearancePage />;
  else if (page === "chat") content = <ChatPage />;
  else if (page === "keybindings") content = <KeybindingsPage />;
  else if (page === "skills") content = <SkillsPage />;
  else if (page === "inbox") content = <InboxSettings />;
  else if (page === "providers") content = desktop ? <ProviderSettings /> : <DesktopOnly what=" Provider" />;
  else if (page === "integrations") content = desktop ? <IntegrationsPage /> : <DesktopOnly what="第三方接入" />;
  else if (page === "computer-use") content = desktop ? <ComputerUsePage /> : <DesktopOnly what="电脑操作" />;
  else if (page === "browser") content = desktop ? <BrowserPage /> : <DesktopOnly what="浏览器" />;
  else if (page === "screen") content = <ScreenSettingsPage />;
  else if (page === "pi-tools") content = <PiToolsPage />;
  else content = <GeneralSettingsPage />;

  return (
    <div role="region" aria-label="设置" data-app-settings className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <TrafficLightSpacer />
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <span className="shrink-0 text-content/45">设置</span>
          <span aria-hidden className="shrink-0 text-content/25">/</span>
          <span className="min-w-0 truncate text-content">{section.label}</span>
        </div>
        {page === "appearance" ? (
          <div className="flex shrink-0 items-center gap-1.5 pr-2" data-tauri-drag-region="false">
            <button type="button" onClick={restoreDefaults} className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/50 hover:bg-content/10 hover:text-content">
              <RotateCcw className="size-3.5" strokeWidth={1.75} />
              恢复默认外观
            </button>
          </div>
        ) : null}
        <SettingsSearch />
        {!IS_MAC ? <div className="w-2" /> : null}
      </div>
      <div
        ref={(el) => {
          scroller.current = el;
          lockOverscroll(el);
        }}
        className="@container/settings min-h-0 flex-1 overflow-y-auto overscroll-none"
      >
        <div className="settings-page mx-auto w-full max-w-5xl px-5 py-6 pb-16 @min-[560px]/settings:px-8 @min-[560px]/settings:py-8">
          <PageHeader title={section.label} description={section.description} />
          <Suspense fallback={null}>{content}</Suspense>
        </div>
      </div>
    </div>
  );
}
