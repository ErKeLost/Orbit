import { useEffect, useState } from "react";
import { create } from "zustand";
import { LAYER } from "../lib/layers";
import { AlertCircle, CheckCircle, CircleHelp, Loader, X } from "./icons";

/**
 * Orbit-styled toasts: the same bordered glass card its approval and
 * file-action notices use, stacked bottom-right. The call surface matches the
 * one the app already used (`toast.success(title, { description, action })`),
 * so callers only change their import.
 */
export type ToastTone = "success" | "error" | "info" | "warning" | "loading";

type ToastAction = { label: string; onClick: () => void };

export type ToastOptions = {
  description?: string;
  duration?: number;
  action?: ToastAction;
  /** Accepted for compatibility with the previous toast API; ignored. */
  showTimestamp?: boolean;
};

type ToastItem = ToastOptions & { id: number; tone: ToastTone; title: string };

type ToastStore = {
  items: ToastItem[];
  push: (item: Omit<ToastItem, "id">) => number;
  update: (id: number, patch: Partial<Omit<ToastItem, "id">>) => void;
  dismiss: (id: number) => void;
};

let nextId = 1;
const VISIBLE = 4;

const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (item) => {
    const id = nextId++;
    set((state) => ({ items: [...state.items, { ...item, id }].slice(-12) }));
    return id;
  },
  update: (id, patch) =>
    set((state) => ({
      items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}));

function show(tone: ToastTone, title: string, options: ToastOptions = {}) {
  return useToasts.getState().push({ tone, title, ...options });
}

export const toast = {
  success: (title: string, options?: ToastOptions) => show("success", title, options),
  error: (title: string, options?: ToastOptions) => show("error", title, { duration: 6000, ...options }),
  info: (title: string, options?: ToastOptions) => show("info", title, options),
  warning: (title: string, options?: ToastOptions) => show("warning", title, options),
  dismiss: (id: number) => useToasts.getState().dismiss(id),
  promise<T>(
    promise: Promise<T>,
    messages: {
      loading: string;
      success: string;
      /** 传函数可在失败时拿到原因，拼进 title/description，而不是只给一句固定文案。 */
      error: string | ((error: unknown) => string | ToastOptions);
    } & ToastOptions,
  ) {
    const { loading, success, error, ...options } = messages;
    const id = show("loading", loading, { ...options, duration: Infinity });
    promise.then(
      () => useToasts.getState().update(id, { tone: "success", title: success, duration: 4000 }),
      (cause) => {
        const failure = typeof error === "function" ? error(cause) : error;
        const patch = typeof failure === "string" ? { title: failure } : failure;
        useToasts.getState().update(id, { tone: "error", duration: 10000, ...patch });
      },
    );
    return promise;
  },
};

const TONE_ICON: Record<ToastTone, { Icon: typeof CheckCircle; className: string }> = {
  success: { Icon: CheckCircle, className: "text-emerald-400" },
  error: { Icon: AlertCircle, className: "text-red-400" },
  warning: { Icon: AlertCircle, className: "text-amber-400" },
  info: { Icon: CircleHelp, className: "text-content/55" },
  loading: { Icon: Loader, className: "animate-spin text-content/55" },
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToasts((state) => state.dismiss);
  const [hovered, setHovered] = useState(false);
  const duration = item.duration ?? 4000;

  useEffect(() => {
    if (hovered || !Number.isFinite(duration)) return;
    const timer = window.setTimeout(() => dismiss(item.id), duration);
    return () => window.clearTimeout(timer);
  }, [dismiss, duration, hovered, item.id, item.tone, item.title]);

  const { Icon, className } = TONE_ICON[item.tone];
  return (
    <article
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`approval-toast pointer-events-auto relative isolate overflow-hidden rounded-xl border shadow-xl ${
        item.tone === "error" ? "border-red-400/30" : "border-content/10"
      }`}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-background-base/80 backdrop-blur-xl" />
      <div className="flex items-start gap-2.5 px-3.5 py-3">
        <Icon className={`mt-px size-4 shrink-0 ${className}`} strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] font-semibold leading-snug text-content">{item.title}</p>
          {item.description ? (
            <p className="mt-1 line-clamp-4 whitespace-pre-line break-words text-[12px] leading-relaxed text-content/60">
              {item.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="关闭通知"
          onClick={() => dismiss(item.id)}
          className="-mr-1 -mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {item.action ? (
        <div className="flex gap-2 border-t border-stroke px-3.5 py-2.5">
          <button
            type="button"
            className="flex-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground hover:bg-accent/85"
            onClick={() => {
              item.action?.onClick();
              dismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        </div>
      ) : null}
    </article>
  );
}

export function Toaster() {
  const items = useToasts((state) => state.items);
  const visible = items.slice(-VISIBLE);
  return (
    <div
      aria-live="polite"
      className="toast-region pointer-events-none fixed bottom-4 right-4 flex w-[min(320px,calc(100vw-2rem))] flex-col gap-2"
      style={{ zIndex: LAYER.toast }}
    >
      {visible.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}
