import { invoke } from "./native";
import { useQuery } from "@tanstack/react-query";

export type RuntimeDiscovery = {
  home: string;
  agentDir: string;
  sessionsDir: string;
  resourcesDir: string;
  node: string;
  hostNode: string;
  nodeVersion: string;
  pi: string;
  piVersion: string;
  piSource: "bundled" | "project" | "global";
  nodeModules: string;
  extension: string;
  cwd: string;
  piExecutable?: boolean;
  launchArgs?: string[];
  /** 探测结果：失败时 `piVersion` 是 `unknown`，原因在这里。 */
  probe?: RuntimeProbe;
};

/** One `pi --version` attempt, including why it failed. */
export type RuntimeProbe = {
  ok: boolean;
  version: string | null;
  invocation: string;
  elapsedMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  reason: string | null;
};

export type RuntimeHealth = {
  platform: string;
  arch: string;
  home: string | null;
  homeError: string | null;
  cwd: string;
  resourcesDir: string | null;
  resourcesError: string | null;
  nodeModules: { path: string; exists: boolean } | null;
  node: {
    path: string | null;
    exists?: boolean;
    version: string | null;
    error: string | null;
    elapsedMs?: number;
  };
  pi: { path: string | null; source: string; exists: boolean };
  probe: { executable: boolean | null; probe: RuntimeProbe | null };
  resources: { label: string; path: string; exists: boolean }[];
  agentDir: string | null;
  agentDirError: string | null;
  launchArgs: string[];
  environment: { name: string; sensitive: boolean; hasValue: boolean }[];
};

export function useRuntimeDiscovery(enabled: boolean) {
  return useQuery({
    queryKey: ["discovery"],
    queryFn: () => invoke<RuntimeDiscovery>("discover"),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * The diagnostics page's data. Unlike `discover`, this command never fails: a
 * broken runtime is exactly the case the page exists for.
 */
export function useRuntimeHealth(enabled: boolean) {
  return useQuery({
    queryKey: ["runtime-health"],
    queryFn: () => invoke<RuntimeHealth>("runtime_health", { config: null }),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/** Plain-text report for a bug report: paths, versions, and the probe's own output. */
export function runtimeHealthReport(health: RuntimeHealth): string {
  const probe = health.probe.probe;
  const lines = [
    `Orbit 运行诊断 · ${health.platform}-${health.arch}`,
    `工作目录: ${health.cwd}`,
    `用户目录: ${health.home ?? `读取失败 ${health.homeError ?? ""}`}`,
    `resources: ${health.resourcesDir ?? `解析失败 ${health.resourcesError ?? ""}`}`,
    `node_modules: ${health.nodeModules ? `${health.nodeModules.path} (${health.nodeModules.exists ? "存在" : "缺失"})` : "未知"}`,
    "",
    `[Node]`,
    `路径: ${health.node.path ?? "未找到"}`,
    `版本: ${health.node.version ?? "未知"}`,
    `错误: ${health.node.error ?? "无"}`,
    `耗时: ${health.node.elapsedMs ?? 0}ms`,
    "",
    `[Pi]`,
    `路径: ${health.pi.path ?? "未找到"}`,
    `来源: ${health.pi.source}`,
    `可执行文件: ${health.probe.executable === null ? "未知" : health.probe.executable ? "是" : "否（用内置 node 启动）"}`,
    `命令: ${probe?.invocation ?? "未执行"}`,
    `结果: ${probe ? (probe.ok ? `ok ${probe.version}` : `失败 · ${probe.reason ?? "未知原因"}`) : "未执行"}`,
    `耗时: ${probe?.elapsedMs ?? 0}ms · 退出码: ${probe?.exitCode ?? "无"}${probe?.timedOut ? " · 超时" : ""}`,
    probe?.stderrTail ? `stderr:\n${probe.stderrTail}` : "",
    probe?.stdoutTail ? `stdout:\n${probe.stdoutTail}` : "",
    "",
    `[资源文件]`,
    ...health.resources.map(item => `${item.exists ? "✓" : "✗"} ${item.label}: ${item.path}`),
    "",
    `[环境变量]`,
    ...(health.environment.length
      ? health.environment.map(item => `${item.name}${item.sensitive ? "（敏感）" : ""}: ${item.hasValue ? "已设置" : "空"}`)
      : ["无"]),
    `启动参数: ${health.launchArgs.length ? health.launchArgs.join(" ") : "无"}`,
    `Pi 配置目录: ${health.agentDir ?? `读取失败 ${health.agentDirError ?? ""}`}`,
  ];
  return lines.filter(line => line !== "").join("\n");
}
