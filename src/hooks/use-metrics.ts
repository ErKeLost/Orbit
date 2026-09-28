import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { requestWithRecovery } from "../lib/rpc";
import { useWorkspace } from "../lib/store";
import { usePageVisible } from "../lib/page-visibility";

export type Stats = Extract<RpcResponse, { command: "get_session_stats"; success: true }>["data"];
export type ContextBreakdown = { toolChars?: number };
export type RuntimeInfo = { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }; retry: { enabled: boolean; maxRetries: number; baseDelayMs: number }; providerRetry: Record<string, unknown>; transport: string; projectTrusted: boolean; systemPrompt: string; thinkingBudgets?: Record<string, number>; idle: boolean; pending: boolean; scopedModels: unknown[]; breakdown?: ContextBreakdown };

export function useMetrics() {
  const cwd = useWorkspace(state => state.cwd);
  const connectionId = useWorkspace(state => state.connectionId);
  const online = useWorkspace(state => state.connection === "online");
  const sessionId = useWorkspace(state => state.state?.sessionId);
  const runtimeText = useWorkspace(state => state.statuses["gui-runtime"]);
  // runtimeText 可能包含完整 systemPrompt，体积不小；每次渲染都重复
  // JSON.parse 没有必要，按文本记忆化。
  const runtime = useMemo<RuntimeInfo | null>(() => {
    try { return runtimeText ? JSON.parse(runtimeText) as RuntimeInfo : null; } catch { return null; }
  }, [runtimeText]);
  const visible = usePageVisible();
  const stats = useQuery({ queryKey: ["pi", "live-stats", connectionId || cwd, sessionId], queryFn: () => requestWithRecovery<Stats>({ type: "get_session_stats" }, 30000, connectionId || cwd), enabled: online && visible, refetchInterval: 2000 });
  return { stats: stats.data, runtime, error: stats.error, updatedAt: stats.dataUpdatedAt, online };
}
