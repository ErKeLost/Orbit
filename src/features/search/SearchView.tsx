import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../lib/store";
import { changeSession, connect, persistedSessionFile, report } from "../../lib/rpc";
import { useProjects } from "../../lib/projects";
import { MIN_QUERY, useFileSearch, useSessionSearch, type SearchFileHit, type SearchSessionHit } from "../../lib/search";
import { useShell } from "../shell/shellStore";
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

function Row({ icon, title, meta, onClick }: { icon: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none text-content hover:bg-content/5 focus-visible:bg-selection focus-visible:outline-none"
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta ? <span className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-content/40">{meta}</span> : null}
    </button>
  );
}

/** MonoCode's Search view: one query box, four filters, grouped results. */
export function SearchView() {
  const cwd = useWorkspace((state) => state.cwd);
  const homeDir = useWorkspace((state) => state.homeDir);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const { projects } = useProjects();
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const input = useRef<HTMLInputElement>(null);

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

  const openFile = (hit: SearchFileHit) => {
    // The file pane lives beside the chat, so leaving Search is part of opening.
    useWorkspace.getState().set({ panel: "chat" });
    useShell.getState().openFile(hit.path, { pin: true });
  };
  const openSession = (hit: SearchSessionHit) => {
    useWorkspace.getState().set({ panel: "chat" });
    void changeSession({ type: "switch_session", sessionPath: hit.path }).catch(report);
  };

  return (
    <div role="region" aria-label="搜索" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      <div className="flex h-10 shrink-0 select-none items-center border-b border-stroke" data-tauri-drag-region="deep">
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
              }
            }}
            placeholder="搜索一切…"
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

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none p-2">
        {!hasQuery ? <EmptyState /> : null}
        {hasQuery && nothing ? <p className="px-2 py-1.5 text-[12px] text-content/50">没有结果</p> : null}
        {files.isError ? <p className="px-2 py-1.5 text-[12px] text-red-400">{String(files.error)}</p> : null}

        <div className="flex flex-col gap-3">
          {(tab === "all" || tab === "projects") && matchedProjects.length > 0 ? (
            <Section label="项目">
              {matchedProjects.map((item) => (
                <Row
                  key={item.path}
                  icon={<ProjectInitial name={item.path} className="size-3.5 shrink-0" />}
                  title={item.name}
                  meta={item.path}
                  onClick={() => {
                    useWorkspace.getState().set({ panel: "chat" });
                    void connect(item.path, "project").catch(report);
                  }}
                />
              ))}
            </Section>
          ) : null}

          {(tab === "all" || tab === "sessions") && sessionHits.length > 0 ? (
            <Section label="会话">
              {sessionHits.map((hit) => (
                <Row
                  key={hit.path}
                  icon={<MessageSquare className="size-3.5 text-content/50" strokeWidth={1.75} />}
                  title={hit.title || "未命名会话"}
                  meta={hit.path === persistedSessionFile(cwd) ? "当前" : undefined}
                  onClick={() => openSession(hit)}
                />
              ))}
            </Section>
          ) : null}

          {(tab === "all" || tab === "files") && fileHits.length > 0 ? (
            <Section label="文件">
              {fileHits.map((hit) => (
                <Row
                  key={`${hit.path}:${hit.line ?? 0}`}
                  icon={<FileTypeIcon name={hit.relative.split("/").at(-1) ?? hit.relative} isDir={false} size={14} />}
                  title={
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate">{hit.relative}</span>
                      {hit.snippet ? <span className="min-w-0 truncate text-[11px] text-content/40">{hit.snippet}</span> : null}
                    </span>
                  }
                  meta={hit.line ? `:${hit.line}` : undefined}
                  onClick={() => openFile(hit)}
                />
              ))}
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** MonoCode's empty state: a dotted grid behind a rounded search glyph. */
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
