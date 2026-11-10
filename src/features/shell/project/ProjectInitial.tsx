/** Round initial badge standing in for a project. */
export function ProjectInitial({ name, className = "size-4 shrink-0" }: { name: string; className?: string }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={`grid ${className} place-items-center rounded-full bg-fill-strong font-semibold text-ink-2`}
      style={{ fontSize: "0.55rem" }}
    >
      {letter}
    </span>
  );
}
