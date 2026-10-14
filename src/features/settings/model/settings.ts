import { ALL_SECTIONS } from "../SettingsNav";
import { useWorkspace, type SettingsPage } from "../../../lib/store";

/**
 * 设置搜索索引（monocode 的 searchSettings）：每条是一行真实存在的设置，
 * `anchorId` 对应该行 Row 上的 `data-setting-id`，命中后跳页并滚动定位。
 */

export type SettingIndexEntry = {
  id: string;
  section: SettingsPage;
  label: string;
  keywords?: string;
};

export const SETTINGS_INDEX: SettingIndexEntry[] = [
  // 外观
  { id: "theme", section: "appearance", label: "主题", keywords: "深色 浅色 跟随系统 dark light theme" },
  { id: "accent", section: "appearance", label: "强调色", keywords: "主题色 accent 发送按钮 气泡 颜色" },
  { id: "diff-colors", section: "appearance", label: "Diff 颜色", keywords: "色盲 高对比 增删行 红 绿 diff palette" },
  { id: "hue", section: "appearance", label: "色相", keywords: "色调 hue 颜色" },
  { id: "saturation", section: "appearance", label: "饱和度", keywords: "着色强度 saturation" },
  { id: "dark-lightness", section: "appearance", label: "深色亮度", keywords: "暗色 亮度 lightness" },
  { id: "sidebar-opacity", section: "appearance", label: "侧栏不透明度", keywords: "透明 opacity 玻璃" },
  { id: "blur", section: "appearance", label: "模糊半径", keywords: "毛玻璃 blur 背景" },
  { id: "body-glass", section: "appearance", label: "主面板玻璃", keywords: "半透明 主面板 glass" },
  { id: "chat-background", section: "appearance", label: "聊天背景", keywords: "背景图 图片 wallpaper" },
  { id: "chat-background-opacity", section: "appearance", label: "背景不透明度", keywords: "背景图 图片 透明度 opacity wallpaper" },
  { id: "collapsed-rail", section: "appearance", label: "收起时的项目栏", keywords: "图标栏 隐藏 紧凑 collapsed rail" },
  { id: "ui-scale", section: "appearance", label: "界面缩放", keywords: "缩放 大小 zoom scale" },
  { id: "show-excluded-files", section: "appearance", label: "显示被忽略的文件", keywords: "git ignore 忽略 构建产物" },
  // General
  { id: "mobile-access", section: "general", label: "移动端访问", keywords: "手机 配对 host remote" },
  { id: "relay", section: "general", label: "公网中转配置", keywords: "阿里云 relay 外网 5G 中转" },
  { id: "host", section: "general", label: "Host 运行", keywords: "电脑 host 开启" },
  // 第三方接入
  { id: "image-endpoint", section: "integrations", label: "图片端点", keywords: "火山方舟 base url provider 端点" },
  { id: "image-default-model", section: "integrations", label: "默认出图模型", keywords: "模型 切换 seedream generate_image image model" },
  { id: "image-capabilities", section: "integrations", label: "生成能力开关", keywords: "generate_image 开关 启用 关闭" },
  // 其他
  { id: "providers", section: "providers", label: "模型端点", keywords: "api key 模型 catalog providers" },
  { id: "skills", section: "skills", label: "技能管理", keywords: "skills 命令 斜杠" },
  { id: "inbox-sources", section: "inbox", label: "收件箱来源", keywords: "通知 inbox github" },
  { id: "screen", section: "screen", label: "屏幕共享", keywords: "手机看电脑 screen 权限" },
];

export type SettingsSearchResult = {
  section: SettingsPage;
  sectionLabel: string;
  /** 要滚动到的行锚点；整区命中时为 null。 */
  settingId: string | null;
  label: string;
};

function matchScore(needle: string, label: string, keywords?: string): number | null {
  const lower = label.toLowerCase();
  if (lower.startsWith(needle)) return 0;
  if (lower.includes(needle)) return 1;
  if (keywords?.toLowerCase().includes(needle)) return 2;
  return null;
}

/** 行级命中优先，整区命中次之；同分按名称排序。 */
export function searchSettings(query: string, limit = 8): SettingsSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: { score: number; result: SettingsSearchResult }[] = [];

  for (const entry of SETTINGS_INDEX) {
    const score = matchScore(needle, entry.label, entry.keywords);
    if (score == null) continue;
    scored.push({
      score,
      result: {
        section: entry.section,
        sectionLabel: ALL_SECTIONS.find((section) => section.id === entry.section)?.label ?? entry.section,
        settingId: entry.id,
        label: entry.label,
      },
    });
  }

  for (const section of ALL_SECTIONS) {
    const score = matchScore(needle, section.label, section.description);
    if (score == null) continue;
    scored.push({
      score: score + 0.5,
      result: { section: section.id, sectionLabel: section.label, settingId: null, label: section.label },
    });
  }

  return scored
    .sort((a, b) => a.score - b.score || a.result.label.localeCompare(b.result.label, "zh"))
    .slice(0, limit)
    .map((item) => item.result);
}

/** 跳到某页并滚动定位到具体设置行，带一次高亮闪烁。 */
export function jumpToSetting(page: SettingsPage, settingId: string | null) {
  useWorkspace.getState().set({ settingsPage: page });
  if (!settingId) return;
  // 等页面切换渲染完成后再定位。
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`[data-setting-id="${settingId}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.style.transition = "background-color 0.2s ease";
      row.style.backgroundColor = "color-mix(in srgb, var(--color-accent) 12%, transparent)";
      window.setTimeout(() => {
        row.style.backgroundColor = "";
      }, 900);
    }, 60);
  });
}
