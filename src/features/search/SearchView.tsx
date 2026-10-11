import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../lib/store";
import { changeSession, connect, persistedSessionFile, report } from "../../lib/rpc";
import { useProjects } from "../../lib/projects";
import { MIN_QUERY, useFileSearch, useSessionSearch, type SearchFileHit, type SearchSessionHit } from "../../lib/search";
import { useShell } from "../shell/shellStore";
import { TrafficLightSpacer } from "../shell/chrome";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { ProjectInitial } from "../shell/ProjectInitial";
import { Loader, MessageSquare, Search as SearchIcon } from "../../shared/ui/icons";

type Tab = "all" | "sessions" | "files" | "projects";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "sessions", label: "会话" },
  { id: "files", label: "文件" },
  { id: "projects", label: "项目" },
];

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <p className="px-2.5 py-1 text-[11px] text-content/45">{label}</p>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

type FlatRow =
  | { kind: "project"; key: string; path: string; name: string }
  | { kind: "session"; key: string; hit: SearchSessionHit }
  | { kind: "file"; key: string; hit: SearchFileHit };

/** 在文本里高亮查询词（大小写不敏感）；monocode 用 fuzzy positions，这里后端没给位置。 */
function MatchText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const at = lower.indexOf(target);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-accent">{text.slice(at, at + target.length)}</mark>
      {text.slice(at + target.length)}
    </>
  );
}

function Row({
  icon,
  title,
  meta,
  active,
  innerRef,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  active?: boolean;
  innerRef?: (el: HTMLButtonElement | null) => void;
  onClick: () => void;
  /** 会话命中的消息摘要（monocode 的 message preview）。 */
  children?: React.ReactNode;
}) {
  return (
    <button
      ref={innerRef}
      type="button"
      onClick={onClick}
      className={`flex min-h-9 w-full flex-col justify-center gap-0.5 rounded-lg px-2 py-1 text-left text-[13px] leading-none focus-visible:outline-none ${
        active ? "bg-selection text-content" : "text-content hover:bg-content/5"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta ? <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-content/40">{meta}</span> : null}
      </span>
      {children ? <span className="block pl-6 text-[11px] leading-4 text-content/45">{children}</span> : null}
    </button>
  );
}

/** Orbit's Search view: one query box, four filters, grouped results, ↑↓/Enter 导航。 */
export function SearchView() {
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const { projects } = useProjects();
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  // Typing stays instant; the searches wait for a pause.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(raw.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [raw]);

  const project = workspaceMode === "project" && cwd && cwd !== homeDir ? cwd : "";
  const files = useFileSearch(project, query, tab === "all" || tab === "files");
  const sessions = useSessionSearch(query, tab === "all" || tab === "sessions");

  const matchedProjects = useMemo(() => {
    const needle = query.toLowerCase();
    if (needle.length < MIN_QUERY) return [];
    return projects.filter((item) => `${item.name} ${item.path}`.toLowerCase().includes(needle));
  }, [projects, query]);

  const fileHits = files.data ?? [];
  const sessionHits = sessions.data ?? [];
  const searching = files.isFetching || sessions.isFetching;
  const hasQuery = query.length >= MIN_QUERY;
  const nothing = hasQuery && !searching && !files.isError && !sessions.isError && fileHits.length + sessionHits.length + matchedProjects.length === 0;

  const rows = useMemo<FlatRow[]>(() => {
    const list: FlatRow[] = [];
    if (tab === "all" || tab === "projects") {
      for (const item of matchedProjects) list.push({ kind: "project", key: item.path, path: item.path, name: item.name });
    }
    if (tab === "all" || tab === "sessions") {
      for (const hit of sessionHits) list.push({ kind: "session", key: hit.path, hit });
    }
    if (tab === "all" || tab === "files") {
      for (const hit of fileHits) list.push({ kind: "file", key: `${hit.path}:${hit.line ?? 0}`, hit });
    }
    return list;
  }, [tab, matchedProjects, sessionHits, fileHits]);

  useEffect(() => {
    setActive(0);
  }, [raw, tab]);

  useEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  const openFile = (hit: SearchFileHit) => {
    // The file pane lives beside the chat, so leaving Search is part of opening.
    useWorkspace.getState().set({ panel: "chat" });
    useShell.getState().openFile(hit.path, { pin: true });
  };
  const openSession = (hit: SearchSessionHit) => {
    useWorkspace.getState().set({ panel: "chat" });
    void changeSession({ type: "switch_session", sessionPath: hit.path }).catch(report);
  };
  const activate = (row: FlatRow) => {
    if (row.kind === "file") openFile(row.hit);
    else if (row.kind === "session") openSession(row.hit);
    else {
      useWorkspace.getState().set({ panel: "chat" });
      void connect(row.path, "project").catch(report);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => Math.min(rows.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) activate(row);
    }
  };

  let rowIndex = -1;

  return (
    <div role="region" aria-label="搜索" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
        <TrafficLightSpacer />
        <label className="flex min-w-0 flex-1 items-center gap-2 px-3 text-content/50">
          <SearchIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
            ref={input}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                useWorkspace.getState().set({ panel: "chat" });
                return;
              }
              onKeyDown(event);
            }}
            placeholder="搜索一切…（↑↓ 选择，↩ 打开）"
            aria-label="搜索文件和会话"
            className="min-w-0 flex-1 select-text bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
          />
          {searching ? <Loader className="size-3.5 shrink-0 animate-spin text-content/35" /> : null}
        </label>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-px border-b border-stroke px-3">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-md px-2 py-1 text-[12px] ${tab === item.id ? "bg-selection text-content" : "text-content/50 hover:text-content"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-none p-2">
        {!hasQuery ? <EmptyState /> : null}
        {hasQuery && nothing ? <p className="px-2 py-1.5 text-[12px] text-content/50">没有结果</p> : null}
        {files.isError ? <p className="px-2 py-1.5 text-[12px] text-red-400">{String(files.error)}</p> : null}

        <div className="flex flex-col gap-3">
          {(tab === "all" || tab === "projects") && matchedProjects.length > 0 ? (
            <Section label="项目">
              {matchedProjects.map((item) => {
                rowIndex += 1;
                const index = rowIndex;
                return (
                  <Row
                    key={item.path}
                    active={index === active}
                    innerRef={(el) => {
                      if (el && index === active) el.dataset.active = "true";
                    }}
                    icon={<ProjectInitial name={item.path} className="size-3.5 shrink-0" />}
                    title={<MatchText text={item.name} query={query} />}
                    meta={item.path}
                    onClick={() => {
                      useWorkspace.getState().set({ panel: "chat" });
                      void connect(item.path, "project").catch(report);
                    }}
                  />
                );
              })}
            </Section>
          ) : null}

          {(tab === "all" || tab === "sessions") && sessionHits.length > 0 ? (
            <Section label="会话">
              {sessionHits.map((hit) => {
                rowIndex += 1;
                const index = rowIndex;
                return (
                  <Row
                    key={hit.path}
                    active={index === active}
                    innerRef={(el) => {
                      if (el && index === active) el.dataset.active = "true";
                    }}
                    icon={<MessageSquare className="size-3.5 text-content/50" strokeWidth={1.75} />}
                    title={<MatchText text={hit.title || "未命名会话"} query={query} />}
                    meta={hit.path === persistedSessionFile(cwd) ? "当前" : undefined}
                    onClick={() => openSession(hit)}
                  >
                    {hit.snippet ? <MatchText text={hit.snippet} query={query} /> : null}
                  </Row>
                );
              })}
            </Section>
          ) : null}

          {(tab === "all" || tab === "files") && fileHits.length > 0 ? (
            <Section label="文件">
              {fileHits.map((hit) => {
                rowIndex += 1;
                const index = rowIndex;
                return (
                  <Row
                    key={`${hit.path}:${hit.line ?? 0}`}
                    active={index === active}
                    innerRef={(el) => {
                      if (el && index === active) el.dataset.active = "true";
                    }}
                    icon={<FileTypeIcon name={hit.relative.split("/").at(-1) ?? hit.relative} isDir={false} size={14} />}
                    title={
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 truncate">
                          <MatchText text={hit.relative} query={query} />
                        </span>
                        {hit.snippet && hit.kind === "content" ? <span className="min-w-0 truncate text-[11px] text-content/40"><MatchText text={hit.snippet} query={query} /></span> : null}
                      </span>
                    }
                    meta={hit.line ? `:${hit.line}` : undefined}
                    onClick={() => openFile(hit)}
                  />
                );
              })}
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Orbit's empty state: a dotted grid behind a rounded search glyph. */
function EmptyState() {
  const cells = Array.from({ length: 17 * 11 }, (_, index) => index);
  return (
    <div className="flex flex-col items-center justify-center px-6 pb-24 pt-16">
      <div className="relative mb-2 grid h-48 w-72 place-items-center">
        <div className="grid gap-[7px] opacity-[0.14] [mask-image:radial-gradient(ellipse_72%_68%_at_50%_50%,#000_18%,transparent_76%)]" style={{ gridTemplateColumns: "repeat(17, minmax(0, 1fr))" }}>
          {cells.map((cell) => (
            <span key={cell} className="mx-auto size-[3px] rounded-full bg-content" />
          ))}
        </div>
        <div className="absolute grid size-14 place-items-center rounded-2xl bg-content/6 backdrop-blur-sm">
          <SearchIcon className="size-6 text-content/50" strokeWidth={1.75} />
        </div>
      </div>
      <p className="max-w-xs text-center text-[13px] text-content/45">搜索文件、会话、消息与项目。</p>
    </div>
  );
}
