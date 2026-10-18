/**
 * 相对时间："3 分钟前" / "昨天"。Inbox 和 Notes 共用这一处。
 *
 * 格式化器提在模块级：`Intl.RelativeTimeFormat` 构造一次就够，列表里每条
 * 都 new 一个是纯浪费。
 */
const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

/** Orbit's `formatRelativeTime`, verbatim. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = Math.round((then - now) / 1000);
  const abs = Math.abs(delta);
  const divisions: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = delta;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let amount = abs;
  for (const [step, next] of divisions) {
    unit = next;
    if (amount < step) break;
    value = Math.round(value / step);
    amount = Math.abs(value);
  }
  try {
    return relativeFormatter.format(value, unit);
  } catch {
    return "";
  }
}
