import { CornerDownRight, ListEnd, Trash } from "../../shared/ui/icons";

/**
 * Queued messages are a footer row group *inside* the composer box — the same
 * hairline and surface as the field, never a card riding above it. The words
 * still have not reached the turn: follow-ups wait for it, steering messages
 * are already on their way into the running turn. "Steer" promotes a
 * follow-up; the trash removes the whole queue back into the draft (Pi has no
 * per-item delete), so it is one control per row rather than a fake per-item
 * delete.
 *
 * `running` makes the wording honest: steering messages are only consumed by a
 * turn that is actually running. Once the turn has settled, the row is not
 * 「正在引导」 — it goes out at the start of the next turn, so say that instead
 * of showing progress that is not happening.
 */
export function MessageQueueView({
  steering,
  followUp,
  running,
  onSteer,
  onClear,
}: {
  steering: string[];
  followUp: string[];
  running?: boolean;
  onSteer?: (text: string) => void;
  onClear?: () => void;
}) {
  const rows = [
    ...steering.map((text) => ({ text, kind: "steer" as const })),
    ...followUp.map((text) => ({ text, kind: "followUp" as const })),
  ];
  if (rows.length === 0) return null;
  const inFlight = running !== false;
  return (
    <div role="group" aria-label="排队中的消息" className="border-t border-line px-2 py-1" data-message-queue>
      <ul className="max-h-32 overflow-y-auto overscroll-contain">
        {rows.map((row, index) => (
          <li
            key={`${row.kind}-${index}`}
            className="flex min-h-7 items-center gap-2 rounded-md px-1 transition-colors duration-150 hover:bg-fill-weak"
          >
            <span className="grid size-4 shrink-0 place-items-center text-ink-3" aria-hidden>
              {row.kind === "steer" ? <CornerDownRight className="size-3.5" strokeWidth={1.75} /> : <ListEnd className="size-3.5" strokeWidth={1.75} />}
            </span>
            <p className="min-w-0 flex-1 truncate text-sm leading-5 text-ink-2" title={row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text}>
              {row.text.trim() || "附件"}
            </p>
            <span className="shrink-0 text-2xs text-ink-3">{row.kind === "steer" && inFlight ? "正在引导…" : "下一轮送出"}</span>
            {row.kind === "followUp" && onSteer ? (
              <button
                type="button"
                title="改为现在引导"
                aria-label="改为现在引导"
                onClick={() => onSteer(row.text)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-fill-strong hover:text-ink-1 focus-visible:bg-fill-strong focus-visible:text-ink-1"
              >
                <CornerDownRight className="size-3.5" strokeWidth={1.75} />
              </button>
            ) : null}
            {onClear ? (
              <button
                type="button"
                title="撤回全部排队消息"
                aria-label="撤回全部排队消息"
                onClick={onClear}
                className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-fill-strong hover:text-ink-1 focus-visible:bg-fill-strong focus-visible:text-ink-1"
              >
                <Trash className="size-3.5" strokeWidth={1.75} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
