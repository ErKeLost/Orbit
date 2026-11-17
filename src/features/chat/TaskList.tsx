import { useState } from "react";
import { ChevronDown } from "../../shared/ui/icons";
import {
  currentTodo,
  todoFinished,
  todoProgress,
  type TaskChild,
  type TaskPlan,
  type Todo,
  type TodoStatus,
} from "./todos";

function TodoGlyph({ status }: { status: TodoStatus }) {
  const done = status === "completed";
  const active = status === "in_progress";
  const cancelled = status === "cancelled";
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={`size-3.5 shrink-0 ${active ? "text-accent" : "text-ink-3"}`}>
      <circle cx="8" cy="8" r="6" fill={active ? "color-mix(in oklab, currentColor 16%, transparent)" : "none"} stroke="currentColor" strokeWidth="1.25" />
      {active ? <circle cx="8" cy="8" r="2.2" fill="currentColor" /> : null}
      {done ? <path d="M5 8.2 7.1 10.2 11 6" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {cancelled ? <path d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /> : null}
    </svg>
  );
}

function TaskRow({ todo }: { todo: Todo }) {
  const done = todoFinished(todo);
  const active = todo.status === "in_progress";
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      <TodoGlyph status={todo.status} />
      <span className={`min-w-0 flex-1 truncate text-ui ${active ? "text-ink-1" : done ? "text-ink-3" : "text-ink-2"}`}>{todo.content}</span>
    </div>
  );
}

function ToolFold({ activity }: { activity: TaskChild[] }) {
  const [open, setOpen] = useState(false);
  const running = activity.some((child) => child.running);
  const label = running ? "工具进行中" : `${activity.length} 个工具`;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "收起工具" : "展开工具"}
        onClick={() => setOpen((value) => !value)}
        className="flex h-6 w-full min-w-0 items-center gap-1.5 text-left text-2xs text-ink-3 hover:text-ink-2"
      >
        <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {open
        ? activity.map((child) => (
            <div key={child.key} className="flex h-5 min-w-0 items-center pl-5 text-2xs text-ink-3">
              <span className="min-w-0 flex-1 truncate">{child.label}</span>
            </div>
          ))
        : null}
    </div>
  );
}

function Count({ done, total }: { done: number; total: number }) {
  return <span className="shrink-0 text-2xs tabular-nums text-ink-3">{done}/{total}</span>;
}

/**
 * A status line on the composer's top edge, not a second card. One row at rest;
 * the points open under it. No title, no progress rule.
 */
export function ComposerTasks({ plan }: { plan: TaskPlan }) {
  const [open, setOpen] = useState(false);
  const { done, total } = todoProgress(plan.todos);
  const settled = total > 0 && plan.todos.every(todoFinished) && !plan.running;
  if (settled || (!total && !plan.running)) return null;
  const current = currentTodo(plan.todos);
  const expandable = plan.todos.length > 1 || plan.children.length > 0;

  if (!total) {
    return (
      <div className="flex h-8 items-center border-b border-stroke px-3 text-ui text-ink-3" data-composer-tasks>
        正在写下…
      </div>
    );
  }

  if (!open) {
    const row = (
      <>
        {current ? <TodoGlyph status={current.status} /> : null}
        <span className={`min-w-0 flex-1 truncate text-ui ${current?.status === "in_progress" ? "text-ink-1" : "text-ink-2"}`}>
          {current?.content}
        </span>
        <Count done={done} total={total} />
        {expandable ? <ChevronDown className="size-3 shrink-0 -rotate-90 text-ink-3" strokeWidth={1.75} /> : null}
      </>
    );
    return (
      <div className="border-b border-stroke" data-composer-tasks>
        {expandable ? (
          <button
            type="button"
            aria-expanded={false}
            aria-label="展开任务"
            onClick={() => setOpen(true)}
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-t-[11px] px-3 text-left hover:bg-fill"
          >
            {row}
          </button>
        ) : (
          <div className="flex h-8 min-w-0 items-center gap-2 px-3">{row}</div>
        )}
      </div>
    );
  }

  return (
    <div className="border-b border-stroke px-3 py-1" data-composer-tasks>
      <div className="flex items-start gap-2">
        <div className="scrollbar-none max-h-40 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          {plan.todos.map((todo, index) => (
            <TaskRow key={`${todo.status}-${index}-${todo.content}`} todo={todo} />
          ))}
          {plan.children.length ? <ToolFold activity={plan.children} /> : null}
        </div>
        <button
          type="button"
          aria-expanded
          aria-label="收起任务"
          onClick={() => setOpen(false)}
          className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-ink-3 hover:bg-fill hover:text-ink-2"
        >
          <Count done={done} total={total} />
          <ChevronDown className="size-3" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
