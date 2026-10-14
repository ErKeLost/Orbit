import type { AgentNode } from "../../lib/agents";

/**
 * What a worker is *doing*, kept separate from *how it is going*. The two used
 * to be one enum, so a finished search and a finished refactor both collapsed
 * to a checkmark and the column of avatars stopped being readable. Now the
 * glyph answers "which worker is this" and status lives in the badge + copy.
 */
export type AgentKind =
  | "schedule" | "security" | "release" | "vcs" | "database" | "data"
  | "image" | "visual" | "design" | "web" | "media" | "message" | "model"
  | "run" | "test" | "code" | "write" | "plan" | "setup" | "docs"
  | "search" | "files" | "generic";

/**
 * First match wins, so specific domains sit above the generic verbs: a worker
 * asked to 检查代码结构 is a code worker, not an anonymous "search" one.
 */
const KIND_RULES: Array<[AgentKind, RegExp]> = [
  ["schedule", /cron|schedule|deadline|定时|排期|日程/],
  ["security", /security|auth\b|credential|secret|vulnerab|pentest|安全|鉴权|权限|漏洞|密钥/],
  ["release", /deploy|release|publish|\bci\b|打包|部署|发布|上线|发包/],
  ["vcs", /\bgit\b|commit|branch|merge|rebase|patch|\bpr\b|pull request|提交|合并|分支|补丁/],
  ["database", /\bsql\b|database|数据库|建表|索引/],
  ["data", /token|(^|[^a-z])count|metric|benchmark|statistic|inventory|catalog|统计|数据|指标|基准|盘点|计数|量化/],
  ["image", /image|imagegen|photo|picture|插图|配图|海报|图标|封面|照片|图片/],
  ["visual", /screenshot|visual|截图|视觉|走查|观感|还原度/],
  // `ui`/`ux` only as standalone words: `a2ui` and `ag-ui` are protocol names,
  // not design work, and they were stealing the design glyph.
  ["design", /design|figma|(^|[^a-z0-9-])u[ix]([^a-z0-9]|$)|style|css|layout|theme|设计|样式|布局|主题|配色|排版/],
  ["web", /web|http|url|\bapi\b|fetch|scrape|crawl|website|网页|官网|生态|站点/],
  ["media", /video|audio|music|podcast|视频|音频|语音|字幕/],
  ["message", /mail|email|slack|notify|邮件|通知|消息|回复/],
  ["model", /prompt|llm|\bmodel\b|\bgpt\b|inference|embedding|提示词|模型|推理|微调|上下文/],
  ["run", /\brun\b|bash|command|shell|script|terminal|执行|运行|命令|脚本/],
  ["test", /test|verify|check|lint|assert|regression|测试|验证|校验|自测|核对/],
  ["code", /code|implement|refactor|\bfix\b|bug|代码|实现|重构|修复|开发|编程/],
  ["write", /write|draft|summary|report|prose|写作|撰写|总结|汇报|润色|文案|摘要/],
  ["plan", /plan|coordinate|orchestrat|roadmap|strategy|规划|协调|统筹|方案|路线图|拆解/],
  ["setup", /config|setting|install|setup|dependency|配置|安装|环境|依赖/],
  ["docs", /\bdoc|readme|note|spec|handbook|wiki|文档|笔记|规范|手册|阅读|教程/],
  ["search", /research|search|find|explore|inspect|investigate|调研|搜索|查找|调查|梳理|检查/],
  ["files", /repo|folder|structure|directory|目录|文件|仓库|结构|代码库|清单/],
];

const KIND_ICONS: Record<AgentKind, string> = {
  schedule: "fluent-color:calendar-clock-24",
  security: "fluent-color:shield-checkmark-24",
  release: "fluent-color:cloud-24",
  vcs: "fluent-color:arrow-sync-24",
  database: "fluent-color:database-24",
  data: "fluent-color:data-trending-24",
  image: "fluent-color:image-24",
  visual: "fluent-color:search-visual-24",
  design: "fluent-color:design-ideas-24",
  web: "fluent-color:globe-24",
  media: "fluent-color:video-24",
  message: "fluent-color:mail-24",
  model: "fluent-color:bot-sparkle-24",
  run: "fluent-color:wrench-screwdriver-24",
  test: "fluent-color:clipboard-task-24",
  code: "fluent-color:code-block-24",
  write: "fluent-color:notebook-24",
  plan: "fluent-color:people-community-24",
  setup: "fluent-color:settings-24",
  docs: "fluent-color:book-open-24",
  search: "fluent-color:search-sparkle-24",
  files: "fluent-color:document-folder-24",
  generic: "fluent-color:lightbulb-24",
};

/** Tooltip copy, so the glyphs stay decodable without a legend. */
export const KIND_LABELS: Record<AgentKind, string> = {
  schedule: "定时 / 排期",
  security: "安全 / 鉴权",
  release: "部署 / 发布",
  vcs: "版本 / 分支",
  database: "数据库",
  data: "数据 / 计数",
  image: "图片",
  visual: "视觉检查",
  design: "设计 / UI",
  web: "网页 / 接口",
  media: "音视频",
  message: "邮件 / 通知",
  model: "模型 / 提示词",
  run: "命令执行",
  test: "测试 / 核对",
  code: "代码",
  write: "写作 / 汇总",
  plan: "规划 / 协调",
  setup: "配置 / 环境",
  docs: "文档 / 规范",
  search: "检索 / 调研",
  files: "目录 / 仓库",
  generic: "通用任务",
};

export const STATUS_LABELS: Record<AgentNode["status"], string> = {
  queued: "等待启动",
  running: "进行中",
  completed: "已完成",
  failed: "执行失败",
  aborted: "已中止",
  unknown: "状态未知",
};

/** The kind a worker falls into, from its name plus the task it was given. */
export function agentKind(agent: AgentNode): AgentKind {
  const text = `${agent.name} ${agent.task}`.toLowerCase();
  for (const [kind, pattern] of KIND_RULES) if (pattern.test(text)) return kind;
  return "generic";
}

export function agentIcon(agent: AgentNode): string {
  const kind = agentKind(agent);
  // The kind always wins: a finished worker should still say what it worked on.
  // Status-only glyphs remain for workers whose task says nothing about the work.
  if (kind === "generic") {
    if (agent.status === "failed") return "fluent-color:error-circle-24";
    if (agent.status === "aborted") return "fluent-color:warning-24";
    if (agent.status === "queued") return "fluent-color:clock-24";
    if (agent.status === "completed") return "fluent-color:checkmark-circle-24";
  }
  return KIND_ICONS[kind];
}
