import { useEffect } from "react";
import { useWorkspace } from "../../lib/store";
import { changeSession, connect, report, sendPrompt } from "../../lib/rpc";
import {
  automationRunUpdate,
  automationsClaimDue,
  automationsList,
  automationScheduleLabel,
  automationRunsRecover,
  nextAutomationRunAt,
  type Automation,
  type AutomationRun,
} from "../../lib/automations";
import { toast } from "../../shared/ui/toast";

const TICK_MS = 30_000;
/** Runs launched by this window, so the report can be written back on settle. */
const inFlight = new Map<string, { automation: Automation; run: AutomationRun }>();

async function launch(automation: Automation, run: AutomationRun) {
  const workspace = useWorkspace.getState();
  if (workspace.cwd !== automation.cwd || workspace.connection !== "online") {
    await connect(automation.cwd, "project");
  }
  await changeSession({ type: "new_session" });
  await sendPrompt({ type: "prompt", message: automation.prompt }, automation.cwd, false);
  const sessionId = useWorkspace.getState().state?.sessionId ?? undefined;
  await automationRunUpdate(run.id, "running", sessionId, null);
  inFlight.set(run.id, { automation, run: { ...run, status: "running", sessionId } });
}

/**
 * Orbit's automation loop: every 30 seconds look for due time triggers,
 * claim each one with the host (a compare-and-set so two windows cannot both
 * run it), then start the session. The run's outcome is written back once the
 * turn settles.
 */
export function useAutomationScheduler() {
  const runtimeTarget = useWorkspace((state) => state.runtimeTarget);
  const running = useWorkspace((state) => state.transcript.running);
  const error = useWorkspace((state) => state.transcript.error);

  // Crash recovery once per launch.
  useEffect(() => {
    if (runtimeTarget !== "desktop") return;
    void automationRunsRecover().catch(() => undefined);
  }, [runtimeTarget]);

  // The tick: claim what is due right now.
  useEffect(() => {
    if (runtimeTarget !== "desktop") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const automations = await automationsList();
        const now = Date.now();
        for (const automation of automations) {
          if (!automation.enabled || automation.nextRunAt > now) continue;
          const next = nextAutomationRunAt(automation, now);
          const claimed = await automationsClaimDue(automation.id, automation.nextRunAt, next, now);
          if (!claimed || cancelled) continue;
          if (claimed.run.status === "skipped") {
            toast.warning(`已跳过 ${automation.name}`, {
              description: "错过了运行时间且超出宽限期",
            });
            continue;
          }
          try {
            await launch(claimed.automation, claimed.run);
            toast.info(`自动化已启动：${automation.name}`, { description: automationScheduleLabel(automation) });
          } catch (failure) {
            await automationRunUpdate(claimed.run.id, "failed", null, String(failure)).catch(() => undefined);
            report(failure);
          }
        }
      } catch {
        // A missing store or a closed window is not worth surfacing.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtimeTarget]);

  // Runs triggered by hand from the Automations screen.
  useEffect(() => {
    const onRun = (event: Event) => {
      const detail = (event as CustomEvent<{ automation: Automation; run: AutomationRun }>).detail;
      if (!detail) return;
      void launch(detail.automation, detail.run).catch(async (failure: unknown) => {
        await automationRunUpdate(detail.run.id, "failed", null, String(failure)).catch(() => undefined);
        report(failure);
      });
    };
    window.addEventListener("orbit:automation-run", onRun);
    return () => window.removeEventListener("orbit:automation-run", onRun);
  }, []);

  // Settle the runs this window started.
  useEffect(() => {
    if (running || inFlight.size === 0) return;
    for (const [runId, entry] of [...inFlight]) {
      inFlight.delete(runId);
      const failed = Boolean(error);
      void automationRunUpdate(runId, failed ? "failed" : "succeeded", entry.run.sessionId ?? null, error)
        .then(() => {
          // One-shot schedules never come back; weekly ones get their next slot
          // when the claim advanced it, so nothing to do here.
        })
        .catch(() => undefined);
    }
  }, [error, running]);
}
