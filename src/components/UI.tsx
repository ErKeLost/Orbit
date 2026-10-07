import { Children, isValidElement, useEffect, useId, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { PromptContext, type PromptOptions } from "@/lib/prompt";
import { Modal as MonoModal } from "../shared/ui/Modal";
import { Select as MonoSelect, Toggle } from "../shared/ui/controls";
import { ChevronRight } from "../shared/ui/icons";

/**
 * Compatibility layer for Orbit's settings/tool panels. The API is the one
 * those panels already call; every visual comes from MonoCode's vocabulary
 * (SecondaryButton, Settings Select/Toggle, Modal). No shadcn underneath.
 */

type ButtonVariant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";

const VARIANT: Record<ButtonVariant, string> = {
  default: "bg-content text-background-base hover:bg-content/80",
  secondary: "border border-content/10 text-content/70 hover:bg-content/10 hover:text-content",
  outline: "border border-content/10 text-content/70 hover:bg-content/10 hover:text-content",
  ghost: "text-content/60 hover:bg-content/10 hover:text-content",
  destructive: "border border-content/10 text-red-400 hover:border-red-400/40 hover:bg-red-400/10",
  link: "text-sky-400/90 hover:text-sky-300 hover:underline",
};

type ButtonProps = Omit<ComponentProps<"button">, "className"> & {
  className?: string;
  variant?: ButtonVariant;
  size?: string;
  render?: unknown;
};

export function Button({ type = "button", title, className = "", variant, size, render: _render, children, ...props }: ButtonProps) {
  const inferred: ButtonVariant = variant ?? (className.includes("secondary") ? "secondary" : className.includes("primary") ? "default" : "ghost");
  const iconOnly = size?.startsWith("icon") || className.includes("icon-button");
  return (
    <button
      {...props}
      type={type}
      title={title}
      aria-label={props["aria-label"] ?? title}
      data-slot="button"
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-40 [&_svg]:size-3.5 ${
        iconOnly ? "size-7 p-0" : "h-7 px-2.5"
      } ${VARIANT[inferred]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      spellCheck={false}
      {...props}
      data-slot="input"
      className={`h-7 w-full min-w-0 rounded-md border border-content/10 bg-transparent px-2 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/20 disabled:opacity-50 ${className}`}
    />
  );
}

export function TextArea({ className = "", ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      spellCheck={false}
      {...props}
      data-slot="textarea"
      className={`w-full resize-y rounded-md border border-content/10 bg-transparent px-2 py-1.5 font-sans text-[12px] leading-5 text-content outline-none placeholder:text-content/35 focus:border-content/20 ${className}`}
    />
  );
}

export function Select({
  children,
  onChange,
  value,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  children: ReactNode;
  onChange?: (event: { target: { value: string } }) => void;
  value?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  const options = Children.toArray(children).reduce<{ value: string; label: ReactNode }[]>((result, child) => {
    if (isValidElement<ComponentProps<"option">>(child)) result.push({ value: String(child.props.value ?? child.props.children ?? ""), label: child.props.children });
    return result;
  }, []);
  return (
    <MonoSelect
      label={ariaLabel ?? "选择"}
      value={value ?? ""}
      options={options}
      disabled={disabled}
      className={className ? `max-w-full ${className}` : "max-w-52"}
      onChange={(next) => onChange?.({ target: { value: next } })}
    />
  );
}

export function Switch({ checked, onChange, disabled, "aria-label": ariaLabel }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; "aria-label"?: string }) {
  return <Toggle label={ariaLabel ?? "开关"} on={checked} onChange={onChange} disabled={disabled} />;
}

export function Skeleton({ paragraph, className = "", active: _active, ...props }: ComponentProps<"div"> & { active?: boolean; paragraph?: { rows?: number } }) {
  if (paragraph) {
    return (
      <div className={`flex flex-col gap-2 ${className}`} {...props}>
        {Array.from({ length: paragraph.rows ?? 3 }, (_, index) => (
          <div key={index} className="h-6 w-full animate-pulse rounded-md bg-content/6" />
        ))}
      </div>
    );
  }
  return <div className={`animate-pulse rounded-md bg-content/6 ${className}`} {...props} />;
}

export function Disclosure({ title, children, className = "", defaultOpen = false }: { title: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)} className="group flex min-w-0 items-center gap-1.5 py-1 text-left text-[12px] text-content/55 hover:text-content">
        <ChevronRight className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} strokeWidth={1.75} />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {open ? <div id={id} className="pt-1">{children}</div> : null}
    </div>
  );
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(PromptOptions & { resolve: (value: string | null) => void }) | null>(null);
  const [value, setValue] = useState("");
  const close = (next: string | null) => {
    request?.resolve(next);
    setRequest(null);
  };
  const prompt = useMemo(
    () => (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.initial ?? "");
        setRequest({ ...options, resolve });
      }),
    [],
  );
  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {request ? (
        <MonoModal title={request.title} size={request.multiline ? "md" : "sm"} onClose={() => close(null)}>
          <form
            className="flex flex-col gap-3.5 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              close(value);
            }}
          >
            {request.multiline ? (
              <TextArea autoFocus rows={8} value={value} onChange={(event) => setValue(event.target.value)} className="font-mono" />
            ) : (
              <Input autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
            )}
            <div className="flex justify-end gap-2 text-[13px]">
              <button type="button" onClick={() => close(null)} className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]">
                取消
              </button>
              <button type="submit" className="rounded-md bg-content px-3 py-1.5 font-medium text-background-base hover:bg-content/80 active:scale-[0.97]">
                确认
              </button>
            </div>
          </form>
        </MonoModal>
      ) : null}
    </PromptContext.Provider>
  );
}

export function Modal({
  open,
  title,
  children,
  onCancel,
  onOk,
  footer,
  okText = "确认",
  cancelText = "取消",
  destructive = false,
}: {
  open: boolean;
  title?: ReactNode;
  children?: ReactNode;
  onCancel?: () => void;
  onOk?: () => void;
  footer?: ReactNode;
  okText?: string;
  cancelText?: string;
  destructive?: boolean;
}) {
  if (!open) return null;
  return (
    <MonoModal title={typeof title === "string" ? title : "确认"} size="sm" onClose={() => onCancel?.()}>
      <div className="flex flex-col gap-3.5 p-4 text-[13px] leading-[1.5]">
        <div className="text-content/75">{children}</div>
        {footer ?? (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]">
              {cancelText}
            </button>
            <button
              type="button"
              onClick={onOk}
              className={`rounded-md px-3 py-1.5 font-medium active:scale-[0.97] ${destructive ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" : "bg-content text-background-base hover:bg-content/80"}`}
            >
              {okText}
            </button>
          </div>
        )}
      </div>
    </MonoModal>
  );
}

/** Tooltips are native titles in MonoCode; these keep the old call shape. */
export function Tooltip({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function TooltipTrigger({ render, children }: { render?: ReactNode; children?: ReactNode }) {
  return <>{render ?? children}</>;
}

export function TooltipContent(_props: { children?: ReactNode }) {
  return null;
}

/** Old `Card` wrapper → MonoCode's settings card surface. */
export function Card({ className = "", children, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} className={`overflow-hidden rounded-xl border border-content/10 bg-content/3 ${className}`}>
      {children}
    </div>
  );
}

export function CardContent({ className = "", children, ...props }: ComponentProps<"div">) {
  return (
    <div {...props} className={className}>
      {children}
    </div>
  );
}

export function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
