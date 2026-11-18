import { CornerDownRight, ListEnd, Trash } from "../../shared/ui/icons";

/**
 * Queued messages sit above the composer, same ledge as a quote — not a footer
 * inside the box. Follow-ups wait for the turn to end; steering messages are
 * already on their way into the running turn. "Steer" promotes a follow-up;
 * the trash removes the whole queue back into the draft (Pi has no per-item
 * delete).
 *
 * `running` makes the row honest: steering messages are only consumed by a turn
 * that is actually running. Once the turn has settled, the row is not
 * 「正在引导」 — it goes out at the start of the next turn, so say that instead of
 * showing progress that is not happening.
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
  return (
    <div className="flex w-full flex-col items-start gap-1.5" data-message-queue data-message-queue-card>
      {rows.map((row, index) => (
        <div
          key={`${row.kind}-${index}`}
          className="flex w-fit max-w-[min(100%,36rem)] items-center gap-2.5 rounded-xl border border-line bg-surface-card py-1.5 pl-3 pr-1.5 text-ui shadow-[0_8px_24px_-10px_rgb(15_23_42/0.18),0_1px_2px_rgb(15_23_42/0.06)] dark:bg-surface-raised dark:shadow-[0_10px_28px_-12px_rgb(0_0_0/0.55)]"
        >
          {row.kind === "steer" ? <CornerDownRight className="size-3.5 shrink-0 text-ink-3" /> : <ListEnd className="size-3.5 shrink-0 text-ink-3" />}
          <div className="min-w-0 truncate font-medium text-ink-1" title={row.text.length > 200 ? `${row.text.slice(0, 200)}…` : row.text}>{row.text.trim() || "附件"}</div>
          {row.kind === "steer" ? (
            <span className="shrink-0 text-2xs text-ink-3">{running === false ? "下一轮送出" : "正在引导…"}</span>
          ) : onSteer ? (
            <button
              type="button"
              title="引导"
              aria-label="引导"
              onClick={() => onSteer(row.text)}
              className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill-strong hover:text-ink-1"
            >
              <CornerDownRight className="size-3.5" />
            </button>
          ) : null}
          {onClear ? (
            <button
              type="button"
              title="撤回排队的消息"
              aria-label="撤回排队的消息"
              onClick={onClear}
              className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill-strong hover:text-ink-1"
            >
              <Trash className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
