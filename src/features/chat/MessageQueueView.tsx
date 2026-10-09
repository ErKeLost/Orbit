import { CornerDownRight, ListEnd, Trash2 } from "../../shared/ui/icons";

/**
 * Orbit's queued-message card, fed by Pi's own queue (`queue_update`):
 * follow-ups wait for the turn to end, steering messages are already on their
 * way into the running turn. "Steer" promotes a follow-up; the trash removes
 * the whole queue back into the draft (Pi has no per-item delete).
 */
export function MessageQueueView({
  steering,
  followUp,
  onSteer,
  onClear,
}: {
  steering: string[];
  followUp: string[];
  onSteer?: (text: string) => void;
  onClear?: () => void;
}) {
  const rows = [
    ...steering.map((text) => ({ text, kind: "steer" as const })),
    ...followUp.map((text) => ({ text, kind: "followUp" as const })),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="px-2 text-content/55" data-message-queue>
      <div className="relative z-0 rounded-t-[10px] border border-b-0 border-content/10 bg-content/3 px-2 py-1" data-message-queue-card>
        {rows.map((row, index) => (
          <div key={`${row.kind}-${index}`} className={`flex min-h-7 items-center gap-2 text-[12px] ${index > 0 ? "border-t border-stroke" : ""}`}>
            {row.kind === "steer" ? <CornerDownRight className="size-3.5 shrink-0" /> : <ListEnd className="size-3.5 shrink-0" />}
            <div className="min-w-0 flex-1 py-1">
              <div className="truncate text-content/80" title={row.text}>{row.text.trim() || "附件"}</div>
            </div>
            {row.kind === "steer" ? (
              <span className="shrink-0 text-[11px] text-content/40">正在引导…</span>
            ) : onSteer ? (
              <button
                type="button"
                onClick={() => onSteer(row.text)}
                className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-content/10 hover:text-content"
              >
                <CornerDownRight className="size-3.5" />
                Steer
              </button>
            ) : null}
            {onClear ? (
              <button
                type="button"
                title="撤回排队的消息"
                aria-label="撤回排队的消息"
                onClick={onClear}
                className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-content/10 hover:text-content"
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
