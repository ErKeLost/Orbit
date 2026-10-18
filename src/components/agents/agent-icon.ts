import type { AgentNode } from "../../lib/agents";

/**
 * 头像图标由派活的模型自己给（`spawn_agent` 的 `logo`）。这里**不做映射**：
 * 一张「任务 → 图标」的表永远猜不准，而且任务类型一多就会长成上百行没人敢改的
 * 常量。图标是模型对任务的理解，代码只负责兜底。
 *
 * 于是这个文件只剩两件事：状态怎么说，以及没有 logo 时显示什么。
 */

export const STATUS_LABELS: Record<AgentNode["status"], string> = {
  queued: "等待启动",
  running: "进行中",
  completed: "已完成",
  failed: "执行失败",
  aborted: "已中止",
  unknown: "状态未知",
};

/** 状态只在没有 logo 时兜底：跑完的 worker 仍然该有个说得通的形状。 */
const STATUS_ICONS: Partial<Record<AgentNode["status"], string>> = {
  queued: "fluent-color:clock-24",
  completed: "fluent-color:checkmark-circle-24",
  failed: "fluent-color:error-circle-24",
  aborted: "fluent-color:warning-24",
};

const NEUTRAL_ICON = "fluent-color:lightbulb-24";

/** 名字直接进 DOM 属性，模型写出来的东西不该能把它撑大。 */
const MAX_LOGO = 64;

/**
 * 一个名字，两种写法：模型写 `code-block-24` 就用内置那套，写了
 * `flat-color-icons:search` 就照它的 collection 走。只补前缀，不查表——
 * 名字是否存在交给渲染层（`Icon` 遇到不存在的名字会回落到中性图标）。
 */
export function agentIcon(agent: AgentNode): string {
  const logo = agent.logo?.trim();
  if (logo && logo.length <= MAX_LOGO) return logo.includes(":") ? logo : `fluent-color:${logo}`;
  return STATUS_ICONS[agent.status] ?? NEUTRAL_ICON;
}
