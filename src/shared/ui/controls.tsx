import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Popover } from "./Popover";
import { Check, ChevronDown } from "./icons";

/**
 * MonoCode's control vocabulary, lifted verbatim from its Settings and
 * composer surfaces so every Orbit form reads the same as MonoCode's.
 */

export function Toggle({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent" : "bg-content/20"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
          on ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

type ButtonProps = Omit<ComponentPropsWithRef<"button">, "className"> & {
  danger?: boolean;
  className?: string;
};

/** MonoCode `SecondaryButton`. */
export function SecondaryButton({ danger = false, type = "button", className = "", children, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border border-content/10 px-2.5 py-1 text-[12px] ${
        danger
          ? "text-red-400 hover:border-red-400/40 hover:bg-red-400/10"
          : "text-content/70 hover:bg-content/10 hover:text-content"
      } focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </button>
  );
}

/** The filled action MonoCode uses for a primary choice in a card. */
export function PrimaryButton({ type = "button", className = "", danger = false, children, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[12px] font-medium disabled:cursor-default disabled:opacity-40 ${
        danger ? "bg-red-500 text-white hover:bg-red-500/85" : "bg-content text-background-base hover:bg-content/80"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** Square ghost icon button (TitleBar `IconButton`). */
export function IconButton({
  label,
  active,
  disabled,
  onClick,
  children,
  className = "",
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled}
      data-tauri-drag-region="false"
      onClick={() => {
        if (!disabled) onClick?.();
      }}
      className={`grid size-6.5 shrink-0 place-items-center rounded-md ${
        disabled
          ? "text-content/25"
          : active
            ? "text-content hover:bg-content/10"
            : "text-content/50 hover:bg-content/10 hover:text-content"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** Bordered text field used across MonoCode Settings. */
export function TextField({
  className = "",
  wide = false,
  ...props
}: Omit<ComponentPropsWithRef<"input">, "className"> & { className?: string; wide?: boolean }) {
  return (
    <label
      className={`flex h-7 ${wide ? "w-full" : "w-52"} max-w-full shrink-0 items-center rounded-md border border-content/10 px-2 focus-within:border-content/20 ${className}`}
    >
      <input
        spellCheck={false}
        {...props}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35 disabled:opacity-50"
      />
    </label>
  );
}

export function TextArea({
  className = "",
  ...props
}: Omit<ComponentPropsWithRef<"textarea">, "className"> & { className?: string }) {
  return (
    <textarea
      spellCheck={false}
      {...props}
      className={`w-full resize-y rounded-md border border-content/10 bg-transparent px-2 py-1.5 font-sans text-[12px] leading-5 text-content outline-none placeholder:text-content/35 focus:border-content/20 ${className}`}
    />
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-grid max-w-full shrink-0 gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-w-0 rounded-[5px] px-2.5 py-1 ${
            value === option.value ? "bg-selection text-content" : "text-content/50 hover:text-content"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
  disabled = false,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex w-56 max-w-full items-center gap-3 ${disabled ? "opacity-40" : ""}`}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        disabled={disabled}
        className="sidebar-opacity-slider min-w-0 flex-1 disabled:cursor-not-allowed"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-content">{display}</span>
    </div>
  );
}

export type SelectOption = { value: string; label: ReactNode; icon?: ReactNode };

/** MonoCode Settings `Select`: a trigger plus a Popover listbox. */
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  width = 280,
  className = "max-w-52",
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, value, options]);

  useEffect(() => {
    if (open) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const option = options[active]; if (option) pick(option.value); }
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        type="button"
        ref={trigger}
        disabled={disabled}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-content/10 bg-content/5 px-2 py-1 text-left text-[12px] text-content outline-none hover:border-content/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {selected?.icon ? <span className="grid size-4 shrink-0 place-items-center">{selected.icon}</span> : null}
          <span className="min-w-0 truncate">{selected ? selected.label : value}</span>
        </span>
        <ChevronDown className={`size-3.5 shrink-0 text-content/50 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={1.75} />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          width={width}
          maxHeight={320}
          autoFocus
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") trigger.current?.focus();
          }}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="overflow-y-auto overscroll-contain p-1"
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const highlighted = index === active;
            return (
              <button
                key={option.value}
                ref={highlighted ? activeOption : undefined}
                type="button"
                id={`${listId}-opt-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(option.value)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${
                  highlighted || isSelected ? "bg-selection text-content" : "text-content hover:bg-content/5"
                }`}
              >
                {option.icon ? <span className="grid size-4 shrink-0 place-items-center">{option.icon}</span> : null}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {isSelected ? <Check className="size-3.5 shrink-0" strokeWidth={2.25} /> : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
    </div>
  );
}

/** A menu row inside a Popover (MonoCode's project/plus menus). */
export function MenuItem({
  icon,
  children,
  danger = false,
  disabled = false,
  onClick,
}: {
  icon?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] disabled:cursor-default disabled:opacity-40 ${
        danger ? "text-red-400 hover:bg-red-400/10" : "text-content/80 hover:bg-content/8 hover:text-content"
      }`}
    >
      {icon ? <span className="grid size-3.5 shrink-0 place-items-center [&>svg]:size-3.5">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-stroke" />;
}

/** A Popover menu opened at a point, used for context menus. */
export function PointMenu({
  x,
  y,
  label,
  onClose,
  children,
  width = 220,
}: {
  x: number;
  y: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Popover
      anchor={{ x, y }}
      align="start"
      width={width}
      constrainHeight={false}
      onDismiss={onClose}
      role="menu"
      aria-label={label}
      className="p-1"
    >
      {children}
    </Popover>
  );
}

/** Settings page header (MonoCode `PageHeader`). */
export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="pb-4">
      <h1 className="text-[20px] font-semibold leading-tight text-content">{title}</h1>
      {description ? <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-content/45">{description}</p> : null}
    </header>
  );
}

/** A titled card of settings rows (MonoCode `Group`). */
export function Group({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pt-8 first:pt-0">
      <div className="flex items-end gap-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-content">{title}</h2>
          {description ? <p className="mt-1 text-[12px] leading-relaxed text-content/45">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0 pb-0.5">{action}</div> : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">{children}</div>
    </section>
  );
}

/** One settings row (MonoCode `Row`). */
export function Row({ label, description, children }: { label: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-6 border-b border-content/5 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{label}</div>
        {description ? <div className="mt-1 text-[12px] leading-relaxed text-content/45">{description}</div> : null}
      </div>
      <div className="flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** Quiet empty/notice line used inside cards. */
export function Notice({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3.5 text-[12px] leading-relaxed text-content/50">{children}</p>;
}
