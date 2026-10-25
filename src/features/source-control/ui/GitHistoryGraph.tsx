import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown, ChevronRight, GitBranch, Search, X } from "../../../shared/ui/icons";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { MatchText } from "../../../shared/ui/MatchText";
import {
  gitHistory,
  subscribeGitChanged,
  type GitHistoryCommit,
} from "../../../platform/tauri/fs";
import {
  GRAPH_ROW_PX,
  historyItemGraph,
  layoutGitGraph,
  type GraphRef,
  type HistoryItemViewModel,
} from "../model/gitGraph";
import {
  filterHistoryCommits,
  matchPositions,
  parseHistoryQuery,
  type HistoryField,
} from "../model/historySearch";

type Props = {
  cwd: string;
  enabled: boolean;
  expanded: boolean;
  /** 右栏的 History 分段自己就是容器，不需要可折叠的「Graph」标题行。 */
  headerless?: boolean;
  selectedSha?: string;
  onToggleExpanded: () => void;
  onOpenCommit: (commit: GitHistoryCommit, pin?: boolean) => void;
};

/**
 * 每个项目的最新一份历史。按项目保留、按最近使用淘汰：之前是个只增不减的
 * Map，走过一个项目就永久留着 200 条提交和它们的布局结果。
 */
const HISTORY_CACHE_LIMIT = 6;
const historyByCwd = new Map<string, GitHistoryCommit[]>();

function rememberHistory(cwd: string, commits: GitHistoryCommit[]) {
  historyByCwd.delete(cwd);
  historyByCwd.set(cwd, commits);
  while (historyByCwd.size > HISTORY_CACHE_LIMIT) {
    const oldest = historyByCwd.keys().next().value;
    if (oldest === undefined) break;
    historyByCwd.delete(oldest);
  }
}

/**
 * `subscribeGitChanged` 在忙碌的工作区里会连着触发（保存、暂存、agent 改文件）。
 * 每次全量重取 200 条并比较一遍是很直的浪费，合并成一个尾随窗口就够了。
 */
const REFRESH_DEBOUNCE_MS = 400;

const FIELD_LABEL: Record<HistoryField, string> = {
  subject: "标题",
  author: "作者",
  sha: "提交号",
  ref: "分支",
};

export function GitHistoryGraph({
  cwd,
  enabled,
  expanded,
  headerless = false,
  selectedSha,
  onToggleExpanded,
  onOpenCommit,
}: Props) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const { commits } = useGitHistory(cwd, enabled && expanded);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 布局永远按完整历史算：过滤只是少画几行，lane 的位置和颜色不会在打字时
  // 跳来跳去，行与行之间的连线也仍然对得上。
  const rows = useMemo(() => layoutGitGraph(commits), [commits]);
  const terms = useMemo(() => parseHistoryQuery(query), [query]);
  const matches = useMemo(
    () => filterHistoryCommits(commits, query),
    [commits, query],
  );

  // 键盘光标只是「过滤后列表里的第几个」。列表变短时它自然越界，此时按一次
  // 方向键就重新落到第一行/最后一行，不需要额外同步一遍 state。
  const activeMatch = active >= 0 && active < matches.length ? matches[active] : undefined;

  const open = useCallback(
    (commit: GitHistoryCommit) => onOpenCommit(commit),
    [onOpenCommit],
  );

  const move = (delta: number) => {
    if (matches.length === 0) return;
    const current = activeMatch ? active : -1;
    const next = current < 0
      ? (delta > 0 ? 0 : matches.length - 1)
      : Math.min(matches.length - 1, Math.max(0, current + delta));
    setActive(next);
    const sha = matches[next]?.commit.sha;
    if (!sha) return;
    // 选中项可能刚移到视口外：按行高滚动，不依赖 DOM 里有没有那一行。
    const scroller = listRef.current?.parentElement;
    if (!scroller) return;
    const top = next * GRAPH_ROW_PX;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + GRAPH_ROW_PX > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + GRAPH_ROW_PX - scroller.clientHeight;
    }
  };

  /**
   * 从外面定位过来（顶栏的 commit chip、左栏打开的 commit 标签页）时，把那一行
   * 带进视口。行高是常量，所以照下标算就够了，不用等 DOM 里画出那一行。
   */
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!expanded || !selectedSha || scrolledTo.current === selectedSha) return;
    scrolledTo.current = selectedSha;
    const index = matches.findIndex((match) => match.commit.sha === selectedSha);
    if (index < 0) return;
    const scroller = listRef.current?.parentElement;
    if (!scroller) return;
    const top = index * GRAPH_ROW_PX;
    if (top < scroller.scrollTop || top + GRAPH_ROW_PX > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = Math.max(0, top - Math.round(scroller.clientHeight / 3));
    }
  }, [expanded, selectedSha, matches]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === "Enter") {
      const target = activeMatch ?? matches[0];
      if (!target) return;
      event.preventDefault();
      open(target.commit);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  const searching = terms.length > 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {headerless ? null : (
      <div className="flex h-7 shrink-0 items-center">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse graph" : "Expand graph"}
          className="flex h-full min-w-0 flex-1 items-center gap-1 px-3 text-left leading-none hover:bg-content/5"
        >
          <span className="text-[10px] font-semibold tracking-[0.04em] text-content/55 uppercase">
            Graph
          </span>
          {expanded && commits.length > 0 ? (
            <span className="ml-1 text-[10px] tabular-nums text-content/35">
              {searching ? `${matches.length}/${commits.length}` : commits.length}
            </span>
          ) : null}
          {expanded ? (
            <ChevronDown className="ml-auto size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          ) : (
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
          )}
        </button>
      </div>
      )}
      {expanded && commits.length > 0 ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-stroke/60 px-2">
          <div className="relative flex h-6 min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-1.5 size-3 shrink-0 opacity-50" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // 新查询换了一组候选，旧的光标位置不再指向同一条提交。
                setActive(-1);
              }}
              onKeyDown={onKeyDown}
              placeholder="搜索提交、作者、分支…"
              aria-label="搜索提交历史"
              spellCheck={false}
              className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pl-6 pr-6 text-[12px] text-content outline-none placeholder:text-content/35"
            />
            {query ? (
              <button
                type="button"
                title="清除搜索"
                aria-label="清除搜索"
                onClick={() => setQuery("")}
                className="absolute right-0.5 grid size-5 place-items-center rounded text-content/45 hover:bg-content/10 hover:text-content"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {expanded ? (
        <div
          ref={lockOverscroll}
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-none"
        >
          {!cwd || cwd === "~" ? (
            <p className="px-3 py-2 text-[12px] text-content/45">No project folder</p>
          ) : commits.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-content/45">还没有提交</p>
          ) : matches.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-content/45">
              没有匹配「{query.trim()}」的提交
            </p>
          ) : (
            <ul ref={listRef} className="min-w-0 max-w-full">
              {matches.map((match) => {
                const row = rows[match.index];
                if (!row) return null;
                return (
                  <HistoryRow
                    key={match.commit.sha}
                    commit={match.commit}
                    row={row}
                    terms={terms}
                    fields={match.fields}
                    active={selectedSha === match.commit.sha}
                    highlighted={match.commit.sha === activeMatch?.commit.sha}
                    onOpen={(pin) => onOpenCommit(match.commit, pin)}
                  />
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HistoryRow({
  commit,
  row,
  terms,
  fields,
  active,
  highlighted,
  onOpen,
}: {
  commit: GitHistoryCommit;
  row: HistoryItemViewModel;
  terms: readonly string[];
  fields: HistoryField[];
  active: boolean;
  highlighted: boolean;
  onOpen: (pin?: boolean) => void;
}) {
  const graph = historyItemGraph(row);
  const badge = row.refs.find((ref) => ref.color) ?? row.refs[0];
  const searching = terms.length > 0;
  // 命中的是作者/分支时，标题本身没有高亮，用字段标签说明为什么这条留下了。
  const fieldHint = searching && !fields.includes("subject")
    ? fields.map((field) => FIELD_LABEL[field]).join("、")
    : "";
  return (
    <li className="min-w-0 overflow-visible" style={{ height: GRAPH_ROW_PX }}>
      <button
        type="button"
        data-sha={commit.sha}
        title={`${commit.shortSha} ${commit.subject}${commit.author ? ` — ${commit.author}` : ""}`}
        onClick={() => onOpen()}
        onDoubleClick={() => onOpen(true)}
        aria-pressed={active}
        className={`git-history-item flex h-[22px] min-w-0 w-full items-stretch overflow-visible pr-2 text-left ${
          row.kind === "HEAD" ? "is-head" : ""
        } ${
          active
            ? "is-selected bg-selection text-content"
            : highlighted
              ? "bg-selection/60 text-content"
              : "text-content hover:bg-content/5"
        }`}
      >
        <svg
          aria-hidden
          className="git-history-graph pointer-events-none block shrink-0 overflow-visible"
          width={graph.width}
          height={graph.height}
          overflow="visible"
        >
          {graph.paths.map((path, pathIndex) => (
            <path
              key={pathIndex}
              d={path.d}
              fill="none"
              stroke={path.color}
              strokeWidth={path.strokeWidth}
              strokeLinecap="round"
            />
          ))}
          {graph.circles.map((circle, circleIndex) => (
            <circle
              key={circleIndex}
              cx={circle.cx}
              cy={circle.cy}
              r={circle.r}
              fill={circle.fill ?? "none"}
              strokeWidth={circle.strokeWidth}
            />
          ))}
        </svg>
        <span className="ml-1 flex min-w-0 flex-1 items-center overflow-hidden">
          <span
            className={`min-w-0 truncate text-[12px] leading-[22px] ${
              row.kind === "HEAD" ? "font-semibold" : ""
            }`}
          >
            <MatchText
              text={commit.subject || commit.shortSha}
              positions={searching ? matchPositions(commit.subject || commit.shortSha, terms) : []}
              active={searching}
            />
          </span>
          {commit.author ? (
            <span className="ml-2 min-w-0 shrink truncate text-[12px] leading-[22px] text-content/45">
              <MatchText
                text={commit.author}
                positions={searching ? matchPositions(commit.author, terms) : []}
                active={searching}
              />
            </span>
          ) : null}
          {fieldHint ? (
            <span className="ml-1.5 shrink-0 rounded bg-content/10 px-1 text-[9px] leading-[14px] text-content/50">
              {fieldHint}
            </span>
          ) : null}
        </span>
        {badge ? <RefPill refInfo={badge} /> : null}
      </button>
    </li>
  );
}

function RefPill({ refInfo }: { refInfo: GraphRef }) {
  const local = refInfo.kind === "local";
  return (
    <span
      className={`ml-1 flex h-3.5 min-w-0 max-w-[6.5rem] shrink-0 self-center items-center gap-0.5 truncate rounded-full px-1.5 text-[10px] leading-none ${
        refInfo.color ? "" : "bg-content/10 text-content/55"
      }`}
      style={
        refInfo.color
          ? {
              backgroundColor: refInfo.color,
              color: "var(--color-background-base)",
            }
          : undefined
      }
    >
      {local ? (
        <GitBranch className="size-2.5 shrink-0" strokeWidth={2} />
      ) : null}
      <span className="min-w-0 truncate">{refInfo.name}</span>
    </span>
  );
}

function useGitHistory(
  cwd: string,
  enabled: boolean,
): { commits: GitHistoryCommit[] } {
  const [commits, setCommits] = useState<GitHistoryCommit[]>(
    () => historyByCwd.get(cwd) ?? [],
  );
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  // 同一时刻只允许一个在途请求；刷新密集时后来的那次直接复用结果。
  const inFlight = useRef(false);

  const load = useCallback(() => {
    if (!enabled || !cwd || cwd === "~" || inFlight.current) return;
    inFlight.current = true;
    void gitHistory(cwd)
      .then((next) => {
        if (sameHistory(commitsRef.current, next.commits)) {
          // 内容没变也要把缓存提到队尾：常用项目不该被淘汰。
          rememberHistory(cwd, commitsRef.current);
          return;
        }
        rememberHistory(cwd, next.commits);
        commitsRef.current = next.commits;
        setCommits(next.commits);
      })
      .catch(() => {
        historyByCwd.delete(cwd);
        commitsRef.current = [];
        setCommits([]);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [cwd, enabled]);

  useEffect(() => {
    if (!enabled || !cwd || cwd === "~") {
      commitsRef.current = [];
      setCommits([]);
      return;
    }
    const cached = historyByCwd.get(cwd) ?? [];
    commitsRef.current = cached;
    setCommits(cached);
    load();

    let timer: number | undefined;
    const scheduleReload = () => {
      if (document.hidden) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        load();
      }, REFRESH_DEBOUNCE_MS);
    };
    const onResume = () => {
      if (!document.hidden) load();
    };
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    const unsub = subscribeGitChanged(scheduleReload);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      unsub();
    };
  }, [cwd, enabled, load]);

  return { commits };
}

function sameHistory(
  prev: GitHistoryCommit[],
  next: GitHistoryCommit[],
): boolean {
  if (prev.length !== next.length) return false;
  return prev.every((commit, i) => {
    const other = next[i];
    return (
      other &&
      commit.sha === other.sha &&
      commit.subject === other.subject &&
      commit.head === other.head &&
      commit.refs.length === other.refs.length &&
      commit.refs.every(
        (ref, j) =>
          other.refs[j]?.name === ref.name && other.refs[j]?.kind === ref.kind,
      )
    );
  });
}
