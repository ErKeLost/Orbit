import { useMemo } from "react";
import { Button, Group, Notice, Row } from "../../../shared/ui/controls";
import { toast as gooeyToast } from "../../../shared/ui/toast";
import { runtimeHealthReport, useRuntimeHealth, type RuntimeProbe } from "../../../lib/runtime-diagnostics";

/**
 * 运行诊断：Pi 起不来时唯一能说清原因的地方。
 *
 * 探测失败不再让应用变成一句「Pi 无法启动」，所以这一页必须能**打开**——它读的
 * `runtime_health` 命令永不返回错误，缺文件、node 跑不起来、探测超时都会变成表格里的
 * 一行，而不是一个 toast。
 */
export function DiagnosticsPage() {
  const health = useRuntimeHealth(true);
  const data = health.data;
  const probe: RuntimeProbe | null | undefined = data?.probe.probe;
  const broken = useMemo(() => {
    if (!data) return [] as string[];
    const problems: string[] = [];
    if (!data.node.version) problems.push("内置 Node 无法运行");
    if (!data.pi.path) problems.push("找不到 Pi CLI");
    else if (!data.pi.exists) problems.push("Pi CLI 文件不存在");
    if (probe && !probe.ok) problems.push(`Pi 探测失败：${probe.reason ?? "未知原因"}`);
    const missing = data.resources.filter(item => !item.exists);
    if (missing.length) problems.push(`缺少 ${missing.length} 个运行资源文件`);
    return problems;
  }, [data, probe]);

  async function copy() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(runtimeHealthReport(data));
      gooeyToast.success("诊断信息已复制", { showTimestamp: false });
    } catch (error) {
      gooeyToast.error(String(error));
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold leading-tight text-ink-1">运行诊断</h1>
          <p className="mt-1.5 max-w-xl text-ui leading-relaxed text-ink-3">
            本机 Node 与 Pi 的实际路径、版本和探测结果。Pi 起不来时，这里能看到退出码和它的错误输出。
          </p>
        </div>
        <div className="flex shrink-0 gap-2 pt-1">
          <Button variant="outline" disabled={health.isFetching} onClick={() => void health.refetch()}>
            {health.isFetching ? "检查中…" : "重新检查"}
          </Button>
          <Button variant="outline" disabled={!data} onClick={() => void copy()}>
            复制诊断
          </Button>
        </div>
      </div>

      {health.error ? <Notice>诊断读取失败：{String(health.error)}</Notice> : null}
      {!data && health.isLoading ? <Notice>正在读取运行环境…</Notice> : null}

      {data ? (
        <>
          {broken.length ? (
            <div className="rounded-xl border border-negative/40 bg-negative/5 px-4 py-3 text-ui text-ink-1">
              <p className="font-medium text-negative">发现 {broken.length} 个问题</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-ink-2">
                {broken.map(problem => <li key={problem}>{problem}</li>)}
              </ul>
            </div>
          ) : (
            <div className="rounded-xl border border-positive/40 bg-positive/5 px-4 py-3 text-ui text-ink-1">
              <p className="font-medium text-positive">运行时正常</p>
              <p className="mt-1 text-xs text-ink-3">
                Pi {probe?.version ?? "unknown"} · 探测耗时 {(probe?.elapsedMs ?? 0) / 1000}s
              </p>
            </div>
          )}

          <Group title="探测" description="Orbit 启动 Pi 之前执行的唯一一次版本检查。失败时这里就是原因。">
            <Row label="命令" description="实际执行的完整命令行">
              <code className="max-w-full truncate text-xs text-ink-2" title={probe?.invocation}>
                {probe?.invocation ?? "未执行"}
              </code>
            </Row>
            <Row label="结果">
              <span className={`text-xs font-medium ${probe?.ok ? "text-positive" : "text-negative"}`}>
                {probe ? (probe.ok ? `成功 · ${probe.version}` : "失败") : "未执行"}
              </span>
            </Row>
            <Row label="耗时 / 退出码">
              <span className="text-xs text-ink-2">
                {probe ? `${(probe.elapsedMs / 1000).toFixed(1)}s · ${probe.exitCode ?? "无"}` : "—"}
                {probe?.timedOut ? " · 超时被终止" : ""}
              </span>
            </Row>
            {probe?.reason ? <Row label="原因"><span className="text-xs text-negative">{probe.reason}</span></Row> : null}
            {probe?.stderrTail ? (
              <Row label="stderr" description="Pi 进程自己打印的错误">
                <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-fill px-2 py-1.5 text-[11px] leading-relaxed text-ink-2">{probe.stderrTail}</pre>
              </Row>
            ) : null}
            {probe?.stdoutTail ? (
              <Row label="stdout">
                <pre className="max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-fill px-2 py-1.5 text-[11px] leading-relaxed text-ink-2">{probe.stdoutTail}</pre>
              </Row>
            ) : null}
          </Group>

          <Group title="运行时" description="Pi 由内置 Node 驱动；「可执行文件」里填了路径时优先用那一个。">
            <Row label="Node" description={data.node.error ?? `版本 ${data.node.version ?? "未知"}`}>
              <code className="max-w-full truncate text-xs text-ink-2" title={data.node.path ?? undefined}>{data.node.path ?? "未找到"}</code>
            </Row>
            <Row label="Pi CLI" description={`来源：${data.pi.source} · ${data.probe.executable === false ? "用内置 Node 启动" : "直接启动"}`}>
              <code className="max-w-full truncate text-xs text-ink-2" title={data.pi.path ?? undefined}>{data.pi.path ?? "未找到"}</code>
            </Row>
            <Row label="Orbit resources" description={data.resourcesError ?? undefined}>
              <code className="max-w-full truncate text-xs text-ink-2" title={data.resourcesDir ?? undefined}>{data.resourcesDir ?? "解析失败"}</code>
            </Row>
            <Row label="依赖">
              <code className="max-w-full truncate text-xs text-ink-2" title={data.nodeModules?.path}>
                {data.nodeModules ? `${data.nodeModules.path}${data.nodeModules.exists ? "" : "（缺失）"}` : "未知"}
              </code>
            </Row>
            <Row label="Pi 配置 / 会话目录">
              <code className="max-w-full truncate text-xs text-ink-2" title={data.agentDir ?? undefined}>{data.agentDir ?? "未解析"}</code>
            </Row>
          </Group>

          <Group title="运行资源" description="安装包里的这些文件缺一个，Pi 都无法启动。">
            {data.resources.length ? data.resources.map(item => (
              <Row key={item.path} label={<span className={item.exists ? "" : "text-negative"}>{item.label}</span>}>
                <code className="max-w-full truncate text-xs text-ink-3" title={item.path}>{item.exists ? "存在" : "缺失"}</code>
              </Row>
            )) : <Notice>资源目录无法解析，未检查。</Notice>}
          </Group>

          <Group title="环境" description="敏感值只显示是否设置，读取不到明文。">
            {data.environment.length ? data.environment.map(item => (
              <Row key={item.name} label={<code className="text-xs">{item.name}</code>}>
                <span className="text-xs text-ink-3">{item.sensitive ? "敏感 · " : ""}{item.hasValue ? "已设置" : "空"}</span>
              </Row>
            )) : <Notice>没有自定义环境变量。</Notice>}
            <Row label="启动参数">
              <code className="max-w-full truncate text-xs text-ink-2">{data.launchArgs.length ? data.launchArgs.join(" ") : "无"}</code>
            </Row>
          </Group>
        </>
      ) : null}
    </div>
  );
}
