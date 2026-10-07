import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, PanelLeft } from "../../shared/ui/icons";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "⌘" : "Ctrl+";

/** MonoCode's tab-group palette, hashed per project path. */
const PROJECT_COLORS = [
  "hsl(210 8% 58%)",
  "hsl(211 92% 62%)",
  "hsl(12 80% 58%)",
  "hsl(45 90% 55%)",
  "hsl(142 55% 50%)",
  "hsl(330 70% 62%)",
  "hsl(280 55% 62%)",
  "hsl(175 55% 48%)",
  "hsl(25 85% 58%)",
] as const;

export function projectColor(project: string): string {
  let hash = 0;
  for (let i = 0; i < project.length; i++) hash = (hash * 31 + project.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[(hash % (PROJECT_COLORS.length - 1)) + 1];
}

/** The Pi harness mark from MonoCode's HarnessIcon, drawn in currentColor. */
export function PiMark({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="-4 -4 37 37" fill="currentColor" aria-hidden className={`block ${className}`}>
      <path fillRule="evenodd" d="M1 1H22V14.4997H14.9998V21.2499H8.0002V28H1V1ZM8.0002 7.75014V14.4997H14.9998V7.75014H8.0002Z" />
      <path d="M22 15H28V28H22V15Z" />
    </svg>
  );
}

export function formatInteger(value: number) {
  return value.toLocaleString("en-US");
}

/** `+12 -3` in the diff palette, as on MonoCode's project cards. */
export function DiffStat({ additions, deletions, className = "" }: { additions: number; deletions: number; className?: string }) {
  if (additions <= 0 && deletions <= 0) return null;
  return (
    <span className={`flex shrink-0 items-center gap-1 font-sans text-[11px] font-semibold tabular-nums ${className}`}>
      {additions > 0 ? <span className="text-diff-add-fg">+{formatInteger(additions)}</span> : null}
      {deletions > 0 ? <span className="text-diff-del-fg">-{formatInteger(deletions)}</span> : null}
    </span>
  );
}

export function TitleIconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
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
      className={`grid size-6.5 place-items-center rounded-md ${
        disabled
          ? "text-content/25"
          : active
            ? "text-content hover:bg-content/10"
            : "text-content/50 hover:bg-content/10 hover:text-content"
      }`}
    >
      {children}
    </button>
  );
}

/** Back / forward / panel toggle (MonoCode `TabVisitNav`). */
export function TabVisitNav({
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  onTogglePanel,
  panelActive = false,
  panelLabel = "切换项目栏",
}: {
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onTogglePanel?: () => void;
  panelActive?: boolean;
  panelLabel?: string;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <TitleIconButton label={`后退 (${MOD}[)`} disabled={!canGoBack} onClick={onGoBack}>
        <ChevronLeft className="size-3.5" strokeWidth={1.75} />
      </TitleIconButton>
      <TitleIconButton label={`前进 (${MOD}])`} disabled={!canGoForward} onClick={onGoForward}>
        <ChevronRight className="size-3.5" strokeWidth={1.75} />
      </TitleIconButton>
      {onTogglePanel ? (
        <TitleIconButton label={panelLabel} active={panelActive} onClick={onTogglePanel}>
          <PanelLeft className="size-3.5" strokeWidth={1.75} />
        </TitleIconButton>
      ) : null}
    </div>
  );
}

export function DevModeSlot() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end">
      {import.meta.env.DEV ? (
        <span
          title="开发构建"
          className="mr-1 min-w-0 truncate rounded-md bg-skill/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-skill"
        >
          Development
        </span>
      ) : null}
    </div>
  );
}

/** Shared drag-to-resize handle for a side pane (MonoCode's separators). */
export function ResizeHandle({
  label,
  dragging,
  onPointerDown,
  onDoubleClick,
}: {
  label: string;
  dragging: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onDoubleClick?: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={`absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none ${
        dragging ? "bg-content/15" : "hover:bg-content/10"
      }`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
