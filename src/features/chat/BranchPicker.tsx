import { useEffect, useMemo, useRef, useState } from "react";
import { gitCheckout, gitCreateBranch, useGitBranches, type GitBranchEntry } from "../../lib/git";
import { queryClient } from "../../lib/rpc";
import { Popover } from "../../shared/ui/Popover";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { Check, GitBranch, Loader, Plus, Search } from "../../shared/ui/icons";

/** Orbit's `GitPickerTrigger` + `BranchPicker`, on Orbit's git commands. */
export function BranchPicker({ cwd, current, disabled = false }: { cwd: string; current: string | null; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const branches = useGitBranches(cwd, open).data;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (branches?.branches ?? []).filter((branch) => !needle || branch.name.toLowerCase().includes(needle));
  }, [branches, query]);
  const createName = query.trim();
  const canCreate = Boolean(createName) && !rows.some((row) => row.name === createName);

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["git", "branches", cwd] }),
    queryClient.invalidateQueries({ queryKey: ["git", "diff-stats", cwd] }),
    queryClient.invalidateQueries({ queryKey: ["git", "changed-files", cwd] }),
  ]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      setOpen(false);
      setQuery("");
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  };

  const pick = (branch: GitBranchEntry) => {
    if (branch.current) {
      setOpen(false);
      return;
    }
    void run(() => gitCheckout(cwd, branch.name, branch.remote));
  };

  if (!current) return null;
  return (
    <div ref={root} className="relative flex min-w-0 shrink">
      <button
        type="button"
        title={current}
        aria-label={`分支 ${current}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((value) => !value)}
        className="-ml-1.5 flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-content/55 hover:bg-content/8 hover:text-content active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/55 aria-expanded:bg-content/8 aria-expanded:text-content"
      >
        <GitBranch className="size-3.5 shrink-0" />
        <span className="relative min-w-0 flex-1 truncate">{current}</span>
      </button>
      {open ? (
        <Popover anchor={root} side="top" width={300} minHeight={180} maxHeight={360} onDismiss={() => setOpen(false)} role="dialog" aria-label="分支" className="flex flex-col overflow-hidden">
          <label className="flex shrink-0 items-center gap-2 border-b border-stroke px-3 py-2.5 text-content/50">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              autoFocus
              value={query}
              disabled={busy}
              placeholder="Search or create a branch"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const row = rows[active];
                  if (row) pick(row);
                  else if (canCreate) void run(() => gitCreateBranch(cwd, createName));
                }
              }}
              className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-content outline-none placeholder:text-content/40 disabled:opacity-60"
            />
            {busy ? <Loader className="size-3.5 shrink-0 animate-spin" /> : null}
          </label>
          <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto overscroll-none px-1.5 py-1.5">
            {!branches ? <div className="px-2 py-3 text-[12px] text-content/50">正在读取分支…</div> : null}
            {rows.map((row, index) => {
              const highlighted = index === active;
              return (
                <button
                  key={`${row.remote ?? "local"}:${row.name}`}
                  ref={highlighted ? activeRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={row.current}
                  disabled={busy}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(row)}
                  className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] disabled:opacity-60 ${
                    highlighted || row.current ? "bg-selection text-content" : "text-content hover:bg-content/5"
                  }`}
                >
                  {row.current ? <Check className="size-3.5 shrink-0" strokeWidth={1.75} /> : <GitBranch className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />}
                  <span className={`min-w-0 flex-1 truncate ${row.current ? "font-medium" : ""}`}>{row.name}</span>
                  {row.remote ? <span className="shrink-0 rounded bg-content/6 px-1.5 py-0.5 text-[10px] text-content/40">{row.remote}</span> : null}
                </button>
              );
            })}
            {branches && rows.length === 0 && !canCreate ? <p className="px-2.5 py-5 text-center text-[12px] text-content/45">没有匹配的分支</p> : null}
          </div>
          {error ? <p className="max-h-16 shrink-0 overflow-y-auto whitespace-pre-wrap border-t border-stroke px-2.5 py-2 text-[11px] leading-4 text-red-400/90">{error}</p> : null}
          {canCreate ? (
            <div className="shrink-0 border-t border-stroke p-1 px-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => gitCreateBranch(cwd, createName))}
                className="flex h-7.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-content/75 hover:bg-content/8 hover:text-content disabled:opacity-60"
              >
                <Plus className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 truncate">创建分支 {createName}</span>
              </button>
            </div>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
