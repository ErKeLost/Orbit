import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Group, Notice, Row } from "../../../shared/ui/controls";
import { invoke } from "../../../lib/native";

type Totals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  requests: number;
};

type Ranked = Totals & { key: string };
type SeriesPoint = Totals & { day: string };

type UsageReport = {
  days: number;
  totals: Totals;
  cacheReadShare: number;
  series: SeriesPoint[];
  models: Ranked[];
  projects: Ranked[];
  kinds: Ranked[];
  sessions: number;
  forked: number;
  files: number;
  root: string;
};

type SessionUsage = { path: string; name: string; cwd: string; day: string; forked: boolean; totals: Totals };

const RANGES = [
  { days: 7, label: "7 天" },
  { days: 30, label: "30 天" },
  { days: 90, label: "90 天" },
  { days: 0, label: "全部" },
] as const;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function money(value: number): string {
  if (!value) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.995 ? 0 : 1)}%`;
}

/**
 * 跨会话用量看板。
 *
 * 单会话只能看到上下文构成（`contextBreakdown`），费用和缓存收益散在每条 assistant
 * usage 里。这里按天 / 模型 / 项目聚合，`cacheWarming` 到底有没有用第一次有了数字。
 */
export function UsagePage() {
  const [days, setDays] = useState<number>(30);
  const report = useQuery({
    queryKey: ["usage-report", days],
    queryFn: () => invoke<UsageReport>("usage_report", { days }),
    staleTime: 30_000,
  });
  const sessions = useQuery({
    queryKey: ["usage-sessions"],
    queryFn: () => invoke<SessionUsage[]>("usage_sessions", { limit: 12 }),
    staleTime: 30_000,
  });
  const data = report.data;
  const peak = useMemo(() => {
    const series = data?.series ?? [];
    return series.reduce((max, point) => Math.max(max, point.cost, point.total), 0);
  }, [data]);

  return (
    <div className="flex flex-col gap-6 pb-10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold leading-tight text-ink-1">用量</h1>
          <p className="mt-1.5 max-w-xl text-ui leading-relaxed text-ink-3">
            所有会话累积的 token 与费用。缓存读取占 prompt 的比例就是缓存预热的收益。
          </p>
        </div>
        <div className="flex shrink-0 gap-1 pt-1">
          {RANGES.map(range => (
            <Button
              key={range.days}
              variant={days === range.days ? "default" : "ghost"}
              aria-pressed={days === range.days}
              disabled={report.isFetching}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </Button>
          ))}
        </div>
      </div>

      {report.error ? <Notice>用量读取失败：{String(report.error)}</Notice> : null}
      {!data && report.isLoading ? <Notice>正在扫描会话…</Notice> : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="费用" value={money(data.totals.cost)} hint={`${data.totals.requests} 次请求`} />
            <Metric label="Token" value={tokens(data.totals.total)} hint={`输出 ${tokens(data.totals.output)}`} />
            <Metric
              label="缓存读取"
              value={percent(data.cacheReadShare)}
              hint={`${tokens(data.totals.cacheRead)} token 命中`}
            />
            <Metric
              label="缓存写入"
              value={tokens(data.totals.cacheWrite)}
              hint={`${data.sessions} 个会话 / ${data.files} 个文件`}
            />
          </div>

          {!data.series.length ? (
            <Notice>这个区间里还没有可统计的回答。费用来自 Pi 写入的 usage 字段，自定义模型没配价格时以 0 计。</Notice>
          ) : (
            <Group title="按天" description={`共 ${data.series.length} 天有记录，柱高是当天费用。`}>
              <div className="flex h-40 items-end gap-1 px-4 py-3.5">
                {data.series.map(point => {
                  const height = peak > 0 ? Math.max(2, Math.round((point.cost / peak) * 100)) : 2;
                  return (
                    <div
                      key={point.day}
                      className="group relative min-w-0 flex-1 rounded-t bg-accent/60 transition-colors hover:bg-accent"
                      style={{ height: `${height}%` }}
                      title={`${point.day} · ${money(point.cost)} · ${tokens(point.total)} token · ${point.requests} 次`}
                    />
                  );
                })}
              </div>
              <Row label="区间合计">
                <span className="text-xs text-ink-2">
                  {money(data.totals.cost)} · {tokens(data.totals.input)} 输入 / {tokens(data.totals.cacheRead)} 缓存读 /{" "}
                  {tokens(data.totals.output)} 输出
                </span>
              </Row>
            </Group>
          )}

          <Group title="按模型" description="费用降序。自定义模型没有配置价格时显示 $0。">
            {data.models.length ? data.models.slice(0, 8).map(row => (
              <Row key={row.key} label={<code className="text-xs">{row.key}</code>} description={`${row.requests} 次`}>
                <span className="text-xs text-ink-2">
                  {money(row.cost)} · {tokens(row.total)}
                </span>
              </Row>
            )) : <Notice>没有模型记录。</Notice>}
          </Group>

          <Group title="按项目" description="每个工作目录的累计消耗。">
            {data.projects.length ? data.projects.slice(0, 8).map(row => (
              <Row key={row.key} label={<code className="max-w-full truncate text-xs" title={row.key}>{row.key}</code>} description={`${row.requests} 次`}>
                <span className="text-xs text-ink-2">{money(row.cost)}</span>
              </Row>
            )) : <Notice>没有项目记录。</Notice>}
          </Group>

          <Group title="按类型" description="对话、压缩摘要、分支摘要与缓存预热分别花了多少。">
            {data.kinds.map(row => (
              <Row key={row.key} label={row.key}>
                <span className="text-xs text-ink-2">{money(row.cost)} · {tokens(row.total)} · {row.requests} 次</span>
              </Row>
            ))}
          </Group>

          <Group title="最贵的会话" description="最近 30 天，按费用排序。分叉会话带「分叉」标记。">
            {sessions.data?.length ? sessions.data.map(row => (
              <Row
                key={row.path}
                label={<span className="block max-w-full truncate text-xs" title={row.path}>{row.cwd || row.name || row.path}</span>}
                description={row.day || undefined}
              >
                <span className="flex items-center gap-2 text-xs text-ink-2">
                  {row.forked ? <span className="rounded bg-fill-strong px-1.5 py-0.5 text-2xs text-ink-3">分叉</span> : null}
                  {money(row.totals.cost)} · {tokens(row.totals.total)}
                </span>
              </Row>
            )) : <Notice>{sessions.isLoading ? "正在读取会话…" : "没有会话记录。"}</Notice>}
          </Group>

          <p className="text-[11px] leading-relaxed text-ink-3">
            口径：按会话文件里记录的每次请求累加，日期取 Pi 写入条目的时间戳（可能是 UTC）。
            {data.forked > 0
              ? ` 其中有 ${data.forked} 个分叉会话，它们的继承历史同时计在父会话里，合计会偏高。`
              : ""}
            {" "}自定义模型没配价格时费用以 0 计。
          </p>
        </>
      ) : null}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-fill-weak px-4 py-3">
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-ink-1">{value}</p>
      <p className="mt-0.5 truncate text-[11px] text-ink-3" title={hint}>{hint}</p>
    </div>
  );
}
