import { useState } from "react";
import { ChevronDown, Sparkles } from "../../shared/ui/icons";
import {
  currentTodo,
  formatTaskDuration,
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
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden
      className={`size-4 shrink-0 ${done ? "text-ink-1" : active ? "text-ink-2" : "text-ink-3"}`}
    >
      {status === "pending" ? (
        <circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2.2 2.4" />
      ) : (
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
      )}
      {active ? <path d="M8 3.2a4.8 4.8 0 0 0 0 9.6V3.2Z" fill="currentColor" /> : null}
      {done ? <path d="M5 8.1 7.1 10.2 11.2 5.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {cancelled ? <path d="M5.2 5.2 10.8 10.8M10.8 5.2 5.2 10.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /> : null}
    </svg>
  );
}

function ChildRow({ child }: { child: TaskChild }) {
  const duration = formatTaskDuration(child.durationMs);
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 pl-6 text-ink-3">
      <Sparkles className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm">{child.label}</span>
      {duration ? <span className="shrink-0 text-xs tabular-nums">{duration}</span> : null}
    </div>
  );
}

function TaskRow({ todo, activity, durationMs }: { todo: Todo; activity?: TaskChild[]; durationMs?: number }) {
  const nested = todo.status === "in_progress" ? activity ?? [] : [];
  const [open, setOpen] = useState(nested.length > 0);
  const duration = formatTaskDuration(durationMs);
  const done = todo.status === "completed" || todo.status === "cancelled";
  const body = (
    <>
      <TodoGlyph status={todo.status} />
      <span className={`min-w-0 flex-1 truncate text-sm ${done ? "text-ink-3" : "text-ink-1"}`}>{todo.content}</span>
      {duration ? <span className="shrink-0 text-xs tabular-nums text-ink-3">{duration}</span> : null}
      {nested.length ? (
        <ChevronDown className={`size-3.5 shrink-0 text-ink-3 transition-transform ${open ? "" : "-rotate-90"}`} strokeWidth={1.75} />
      ) : null}
    </>
  );
  return (
    <div>
      {nested.length ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full min-w-0 items-center gap-2.5 py-1.5 text-left">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2.5 py-1.5">{body}</div>
      )}
      {open ? nested.map((child) => <ChildRow key={child.key} child={child} />) : null}
    </div>
  );
}

/** The working plan, in the shape of the task card: count, bar, then the list. */
export function TaskList({ plan }: { plan: TaskPlan }) {
  const [open, setOpen] = useState(true);
  const { done, total } = todoProgress(plan.todos);
  const finished = total > 0 && done === total;
  const duration = formatTaskDuration(plan.durationMs);
  const fraction = total ? done / total : 0;
  const count = finished ? `${done} tasks done` : total ? `${done} of ${total} done` : "updating";
  return (
    <section className="mx-4 mb-2 mt-1 min-w-0" aria-label="Tasks">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full min-w-0 items-baseline gap-2 py-1 text-left">
        <span className="text-sm font-semibold text-ink-1">Tasks</span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink-3">{plan.running && !total ? "正在写下…" : count}</span>
        {duration ? <span className="shrink-0 text-xs tabular-nums text-ink-3">{duration}</span> : null}
        <ChevronDown className={`size-3.5 shrink-0 self-center text-ink-3 transition-transform ${open ? "" : "-rotate-90"}`} strokeWidth={1.75} />
      </button>
      {open ? (
        <>
          <div className="my-2 h-0.5 overflow-hidden rounded-full bg-fill-strong" aria-hidden>
            <div className="h-full bg-ink-1" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          {plan.note ? <p className="pb-1.5 text-sm text-ink-2">{plan.note}</p> : null}
          <div className="flex flex-col">
            {plan.todos.map((todo, index) => (
              <TaskRow key={`${todo.status}-${todo.content}-${index}`} todo={todo} activity={plan.children} durationMs={todo.status === "in_progress" ? plan.children.reduce((sum, child) => sum + (child.durationMs ?? 0), 0) || undefined : undefined} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The plan in hand, sitting just above the composer. */
export function TodoPill({ todos }: { todos: readonly Todo[] }) {
  const current = currentTodo(todos);
  const { done, total } = todoProgress(todos);
  if (!current || !total || done === total) return null;
  return (
    <div className="mb-1.5 flex px-1">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full bg-fill px-2.5 py-1 text-sm text-ink-2">
        <TodoGlyph status={current.status} />
        <span className="min-w-0 truncate">{current.content}</span>
        <span className="shrink-0 tabular-nums text-ink-3">{done}/{total}</span>
      </div>
    </div>
  );
}
