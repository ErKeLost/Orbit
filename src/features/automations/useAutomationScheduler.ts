import { useEffect } from "react";
import { useWorkspace } from "../../lib/store";
import { connectionSnapshot, report } from "../../lib/rpc";
import { workspaceTabs } from "../shell/use-workspace-tabs";
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
const inFlight = new Map<string, { automation: Automation; run: AutomationRun; connectionId?: string }>();

async function launch(automation: Automation, run: AutomationRun) {
  // 在自己的后台会话里跑：不劫持用户正在聊的会话，也不抢焦点。
  const { openBackground } = workspaceTabs;
  const connectionId = await openBackground(automation.cwd, { prompt: automation.prompt });
  const sessionId = connectionSnapshot(connectionId)?.state?.sessionId ?? undefined;
  await automationRunUpdate(run.id, "running", sessionId, null);
  inFlight.set(run.id, { automation, run: { ...run, status: "running", sessionId }, connectionId });
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
  const aborted = useWorkspace((state) => state.transcript.aborted);

  // 后台会话的完成回写：settled 事件带 connectionId，和前台 running 无关。
  useEffect(() => {
    if (runtimeTarget !== "desktop") return;
    const settle = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string; error?: string | null; aborted?: boolean }>).detail ?? {};
      if (!detail.connectionId) return;
      for (const [id, entry] of [...inFlight]) {
        if (entry.connectionId !== detail.connectionId) continue;
        inFlight.delete(id);
        // aborted 优先于 error：被取消的一轮既没有错误也不算成功，记成 succeeded 会让
        // 自动化把「用户按了停止」当成完成。
        const outcome = detail.aborted ? "cancelled" : detail.error ? "failed" : "succeeded";
        void automationRunUpdate(entry.run.id, outcome, entry.run.sessionId ?? null, detail.error ?? null)
          .catch(() => undefined);
      }
    };
    window.addEventListener("orbit-turn-settled", settle);
    return () => window.removeEventListener("orbit-turn-settled", settle);
  }, [runtimeTarget]);

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
      // 被中止的一轮不是成功也不是失败：cancel 掉，不要写进 succeeded。
      const outcome = aborted ? "cancelled" : error ? "failed" : "succeeded";
      void automationRunUpdate(runId, outcome, entry.run.sessionId ?? null, error)
        .then(() => {
          // One-shot schedules never come back; weekly ones get their next slot
          // when the claim advanced it, so nothing to do here.
        })
        .catch(() => undefined);
    }
  }, [aborted, error, running]);
}
