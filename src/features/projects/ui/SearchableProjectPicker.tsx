import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useProjects } from "../../../lib/projects";
import { projectName } from "../../../shared/lib/paths";
import { looksLikeProject, sameProjectPath, type RecentProject } from "../model/recents";
import { Check, ChevronDown, Search } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";

/**
 * Orbit's note-project picker: same props as Orbit's searchable picker,
 * backed by the workspace project list instead of the tab-group rail.
 */
export function SearchableProjectPicker({
  cwd,
  recents,
  mode,
  railCwd,
  buttonClassName = "",
  onSelectProject,
}: {
  cwd: string;
  recents: RecentProject[];
  /** "move" shows the picker inline; other modes are not used by notes. */
  mode?: string;
  railCwd?: string;
  buttonClassName?: string;
  onSelectProject: (path: string) => void;
}) {
  void mode;
  const projects = useProjects((state) => state.projects);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  void railCwd;

  const current = looksLikeProject(cwd) ? projectName(cwd) : null;

  const options = (() => {
    const seen = new Set<string>();
    const list: { path: string; name: string }[] = [];
    for (const path of [
      ...projects.map((project) => project.path),
      ...recents.map((recent) => recent.path),
    ]) {
      const normalized = path.replace(/\/+$/, "");
      if (!normalized || !looksLikeProject(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      list.push({ path: normalized, name: projectName(normalized) });
    }
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? list.filter((item) => item.name.toLowerCase().includes(needle) || item.path.toLowerCase().includes(needle))
      : list;
    return filtered.slice(0, 8);
  })();

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const pick = (path: string) => {
    setOpen(false);
    if (!sameProjectPath(path, cwd)) onSelectProject(path);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && options[active]) {
      event.preventDefault();
      pick(options[active].path);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Note project"
        aria-label="Note project"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-6 min-w-0 max-w-56 items-center gap-1.5 rounded-md text-[11px] text-content/60 hover:bg-content/10 hover:text-content ${buttonClassName}`}
      >
        <span className="min-w-0 truncate">{current ?? "No project"}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          anchor={buttonRef}
          side="bottom"
          align="start"
          width={280}
          maxHeight={280}
          onDismiss={() => setOpen(false)}
          className="flex min-h-0 flex-col text-[12px]"
        >
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-stroke px-2">
            <Search className="size-3 shrink-0 opacity-50" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search projects"
              aria-label="Search projects"
              spellCheck={false}
              autoComplete="off"
              className="h-full w-full bg-transparent outline-none placeholder:text-content/40"
            />
          </div>
          <ul role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
            {options.length === 0 ? (
              <li className="px-2 py-1.5 text-content/45">No matching projects</li>
            ) : (
              options.map((option, index) => {
                const selected = sameProjectPath(option.path, cwd);
                return (
                  <li key={option.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      title={option.path}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(option.path)}
                      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left ${
                        index === active ? "bg-content/10 text-content" : "text-content/75"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {selected ? <Check className="size-3 shrink-0" strokeWidth={2} /> : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </Popover>
      ) : null}
    </>
  );
}

export default SearchableProjectPicker;
