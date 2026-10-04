import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { SettingsPage } from "../../lib/store";
import { useWorkspace } from "../../lib/store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../Icon";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";

const ScreenSettingsPanel = lazy(() => import("./ScreenSettingsPanel").then(module => ({ default: module.ScreenSettingsPanel })));
const SessionsPanel = lazy(() => import("./SessionsPanel").then(module => ({ default: module.SessionsPanel })));
const TreePanel = lazy(() => import("./TreePanel").then(module => ({ default: module.TreePanel })));
const PiToolsPanel = lazy(() => import("./PiToolsPanel").then(module => ({ default: module.PiToolsPanel })));
const ChangesPanel = lazy(() => import("./ChangesPanel").then(module => ({ default: module.ChangesPanel })));
const ConsolePanel = lazy(() => import("./ConsolePanel").then(module => ({ default: module.ConsolePanel })));
const ProviderSettings = lazy(() => import("../ProviderSettings").then(module => ({ default: module.ProviderSettings })));
const ComputerUsePanel = lazy(() => import("./ComputerUsePanel").then(module => ({ default: module.ComputerUsePanel })));

const settingsGroups: { label: string; items: { id: SettingsPage; label: string; icon: string; desktopOnly?: boolean }[] }[] = [
  { label: "个人", items: [{ id: "general", label: "常规", icon: "gear-six" }, { id: "screen", label: "屏幕", icon: "desktop" }, { id: "providers", label: "Provider", icon: "database", desktopOnly: true }, { id: "computer-use", label: "操作电脑", icon: "desktop" }] },
  { label: "会话", items: [{ id: "sessions", label: "所有会话", icon: "chats" }, { id: "tree", label: "会话树", icon: "tree-structure" }] },
  { label: "高级", items: [{ id: "pi-tools", label: "常用工具", icon: "wrench" }, { id: "changes", label: "代码变更", icon: "code" }, { id: "console", label: "控制台", icon: "terminal-window" }] },
];

function SettingsContent({ page, desktop }: { page: SettingsPage; desktop: boolean }) {
  let content: ReactNode;
  if (page === "general") content = <GeneralSettingsPanel />;
  else if (page === "providers") content = desktop ? <ProviderSettings /> : <><div className="panel-heading"><div><h1><Icon name="database" />Provider</h1></div></div><div className="empty-panel"><Icon name="desktop" /><h3>请在电脑端管理 Provider</h3><p>Provider 端点和 API Key 保存在运行 Pi 的电脑上。</p></div></>;
  else if (page === "screen") content = <ScreenSettingsPanel />;
  else if (page === "computer-use") content = desktop ? <ComputerUsePanel /> : <><div className="panel-heading"><div><h1><Icon name="desktop" />操作电脑</h1></div></div><div className="empty-panel"><Icon name="desktop" /><h3>请在电脑端管理电脑操作</h3><p>决策模型与密钥保存在运行 Pi 的电脑上。</p></div></>;
  else if (page === "sessions") content = <SessionsPanel />;
  else if (page === "tree") content = <TreePanel />;
  else if (page === "pi-tools") content = <PiToolsPanel />;
  else if (page === "changes") content = <ChangesPanel />;
  else content = <ConsolePanel />;
  return <Suspense fallback={null}>{content}</Suspense>;
}

export function SettingsPanel() {
  const page = useWorkspace(state => state.settingsPage);
  const desktop = useWorkspace(state => state.runtimeTarget === "desktop");
  const mainRef = useRef<HTMLElement>(null);
  const [search, setSearch] = useState("");
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [page]);
  const query = search.trim().toLowerCase();
  const visibleGroups = settingsGroups.map(group => ({ ...group, items: group.items.filter(item => item.label.toLowerCase().includes(query)) })).filter(group => group.items.length);
  return <div className="settings-workspace">
    <aside className="settings-sidebar">
      <Button variant="ghost" size="lg" className="settings-back" onClick={() => useWorkspace.getState().set({ panel: "chat" })}><Icon name="arrow-left" /><span>返回应用</span></Button>
      <label className="settings-search"><Icon name="magnifying-glass" /><Input aria-label="搜索设置" placeholder="搜索设置…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <nav aria-label="设置分类">{visibleGroups.map(group => <section key={group.label}><h2>{group.label}</h2>{group.items.map(item => { const disabled = Boolean(item.desktopOnly && !desktop); return <Button variant="ghost" size="lg" key={item.id} className={`settings-nav-item ${page === item.id ? "selected" : ""}`} aria-current={page === item.id ? "page" : undefined} disabled={disabled} title={disabled ? "请在电脑端管理" : undefined} onClick={() => useWorkspace.getState().set({ settingsPage: item.id })}><Icon name={item.icon} /><span>{item.label}</span></Button>; })}</section>)}{!visibleGroups.length && <p className="settings-search-empty">没有匹配的设置</p>}</nav>
    </aside>
    <main ref={mainRef} className="settings-main"><div key={page} className={`settings-content settings-${page}-page`}><SettingsContent page={page} desktop={desktop} /></div></main>
  </div>;
}
