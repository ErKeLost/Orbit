import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/native";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { toast as gooeyToast } from "../../shared/ui/toast";
import { Eye, X as EyeOff, Share as ScanLine } from "../../shared/ui/icons";
import QRCode from "antd/es/qr-code";
import type { RpcCommand, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { useWorkspace, type Panel } from "../../lib/store";
import { useRuntimeDiscovery, type RuntimeDiscovery } from "../../lib/runtime-diagnostics";
import { clearSessionHistory, connect, deleteMcpServer, desktopRuntime, disconnect, getGuiSettings, getProjectTrustMode, imageConfig, listMcpServers, loadMessages, mcpConfigLocation, refresh, refreshCapabilities, report, request, saveImageConfig, saveMcpServer, setGuiSetting, setProjectTrustMode, type ImageConfigPatch, type McpServerView, type ProjectTrustMode } from "../../lib/rpc";
import { CACHE_WARMING_LABELS, CODEMODE_TOOL, MCP_EXPOSURE_LABELS, TOOL_SEARCH_TOOL, inactiveCapabilityTools, parseCapabilities, availableMediaModels } from "../../lib/capabilities";
import { persistState } from "../../lib/persistent";
import { getRemoteHost, relaySettingsStatus, rememberRemoteHostEnabled, saveRelaySettings, startRemoteHost, stopRemoteHost, type RelaySettingsStatus, type RemoteHostInfo } from "../../lib/remote-host";
import { GLOBAL_SHORTCUT, NOTIFY_ON_COMPLETE_KEY, readAutostart, readGlobalShortcut, readKeepAwake, writeAutostart, writeGlobalShortcut, writeKeepAwake } from "../../lib/desktop-integration";
import { readStartupPanel, STARTUP_PANELS, writeStartupPanel } from "../../lib/startup-panel";
import { checkMobileUpdate, mobileUpdateErrorMessage } from "../../lib/mobile-update";
import { backgroundConnectionStatus, restoreBackgroundConnection, setBackgroundConnection, type BackgroundConnectionStatus } from "../../lib/background-connection";
import { checkForDesktopUpdate, offerMobileUpdate } from "../UpdateChecker";
import { Button, Card, CardContent, Input, Select, Switch } from "../UI";
import { ImageEndpointDialog } from "../ImageEndpointDialog";
import { usePrompt } from "../../lib/prompt";
import { Icon } from "../Icon";
import "../../styles/remote-access.css";

async function applySetting(command: RpcCommand) {
  await request(command);
  await refresh();
  gooeyToast.success("设置已更新", { showTimestamp: false });
}

type GuiTools = { tools: { name: string; description: string; exposure?: string; namespace?: string }[]; active: string[] };

const MCP_TEMPLATE = `{\n  "name": "filesystem",\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}`;

function mcpViewToConfig(view: McpServerView): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (view.transport === "stdio" && view.command) { config.command = view.command; config.args = view.args; }
  if (view.transport === "http" && view.url) config.url = view.url;
  if (view.description) config.description = view.description;
  if (view.exposure) config.exposure = view.exposure;
  if (!view.enabled) config.enabled = false;
  if (view.timeout) config.timeout = view.timeout;
  return config;
}

/** Pi 1.0 surfaces that the RPC protocol does not cover: MCP, codemode, tool search, media and routing models. */
function PiCapabilitiesSettings({ desktop, online, running, tools }: { desktop: boolean; online: boolean; running: boolean; tools: GuiTools }) {
  const ask = usePrompt();
  const capabilitiesText = useWorkspace(state => state.statuses["gui-capabilities"]);
  const capabilities = useMemo(() => parseCapabilities(capabilitiesText), [capabilitiesText]);
  const mcpQuery = useQuery({ queryKey: ["pi", "mcp", "servers"], queryFn: listMcpServers, enabled: desktop && online });
  const config = mcpQuery.data ?? null;
  const guiSettings = useQuery({ queryKey: ["pi", "gui-settings"], queryFn: getGuiSettings, enabled: desktop });
  const [busy, setBusy] = useState(false);
  const liveTools = useMemo(() => new Map((capabilities?.mcp ?? []).map(server => [server.name, server])), [capabilities]);

  const reload = () => mcpQuery.refetch();
  useEffect(() => { if (online && capabilitiesText === undefined) void refreshCapabilities().catch(report); }, [online, capabilitiesText]);

  const missing = inactiveCapabilityTools(capabilities, tools.active);

  async function toggleTool(tool: string, enabled: boolean) {
    const next = new Set(tools.active);
    if (enabled) next.add(tool); else next.delete(tool);
    try {
      await request({ type: "prompt", message: `/gui-tools-set ${JSON.stringify([...next])}` }, 30000);
      await refreshCapabilities();
      gooeyToast.success(`${tool} 已${enabled ? "启用" : "关闭"}`, { showTimestamp: false });
    } catch (error) { report(error); }
  }
  async function addServer() {
    const raw = await ask({ title: "MCP 服务器配置（JSON）", initial: config?.servers.length ? "" : MCP_TEMPLATE, multiline: true });
    if (raw === null) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { report("MCP 配置不是有效 JSON"); return; }
    if (typeof parsed !== "object" || parsed === null) { report("MCP 配置必须是对象"); return; }
    const { name, ...rest } = parsed as { name?: unknown } & Record<string, unknown>;
    const serverName = typeof name === "string" ? name.trim() : await ask({ title: "MCP 服务器名" });
    if (!serverName) return;
    const serverConfig = typeof rest.config === "object" && rest.config !== null && Object.keys(rest).length === 1 ? rest.config as Record<string, unknown> : rest;
    setBusy(true);
    try {
      await saveMcpServer(serverName, serverConfig);
      await reload();
      gooeyToast.success("MCP 服务器已保存", { description: "运行 /reload 或重连项目后生效", showTimestamp: false });    } catch (error) { report(error); }
    finally { setBusy(false); }
  }
  async function removeServer(name: string) {
    setBusy(true);
    try {
      await deleteMcpServer(name);
      await reload();
      gooeyToast.success(`已移除 ${name}`, { showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusy(false); }
  }
  async function changeServer(view: McpServerView, patch: Record<string, unknown>) {
    setBusy(true);
    try { await saveMcpServer(view.name, { ...mcpViewToConfig(view), ...patch }); await reload(); }
    catch (error) { report(error); }
    finally { setBusy(false); }
  }
  async function showPaths() {
    try { const paths = await mcpConfigLocation(); gooeyToast.info("MCP 配置路径", { description: `${paths.path}\n${paths.logPath}`, showTimestamp: false }); }
    catch (error) { report(error); }
  }
  async function writeSetting(key: "cacheWarming" | "codemode", value: unknown) {
    try { await setGuiSetting(key, value); await guiSettings.refetch(); gooeyToast.success("Pi 设置已写入 settings.json", { description: "重连项目或运行 /reload 后生效", showTimestamp: false }); }
    catch (error) { report(error); }
  }
  const images = availableMediaModels(capabilities?.media.image ?? []);
  const classifiers = availableMediaModels(capabilities?.media.classifier ?? []);
  const imageOptions = capabilities?.media.imageOptions ?? { resolutions: [], aspects: [] };
  const imageSettings = useQuery({ queryKey: ["pi", "image-config"], queryFn: imageConfig, enabled: desktop });
  const [imageEndpointOpen, setImageEndpointOpen] = useState(false);
  async function writeImageSetting(patch: ImageConfigPatch) {
    try { await saveImageConfig(patch); await imageSettings.refetch(); gooeyToast.success("图片设置已更新", { showTimestamp: false }); }
    catch (error) { report(error); }
  }
  return <>
    <SettingRow title="Codemode" description={capabilities?.tools.codemode ? "模型写 JavaScript 调用工具（含 MCP），支持并行、图片生成和分类器。" : "当前 runtime 未提供 codemode 工具。"}>
      {capabilities?.tools.codemode ? <Switch aria-label="Codemode" checked={tools.active.includes(CODEMODE_TOOL)} disabled={!online || running} onChange={checked => void toggleTool(CODEMODE_TOOL, checked)} /> : <span className="remote-settings-note">不可用</span>}
    </SettingRow>
    <SettingRow title="Tool Search" description={capabilities?.tools.toolSearch ? "按需把 deferred 工具（主要是 MCP）声明给模型，避免 prompt 膨胀。" : "当前 runtime 未提供 tool_search 工具。"}>
      {capabilities?.tools.toolSearch ? <Switch aria-label="Tool Search" checked={tools.active.includes(TOOL_SEARCH_TOOL)} disabled={!online || running} onChange={checked => void toggleTool(TOOL_SEARCH_TOOL, checked)} /> : <span className="remote-settings-note">不可用</span>}
    </SettingRow>
    {!!missing.length && <SettingRow title="建议启用" description={`${missing.join("、")} 已在目录中但未启用。`}><Button variant="outline" disabled={!online || running} onClick={() => void Promise.all(missing.map(tool => toggleTool(tool, true))).catch(report)}>一键启用</Button></SettingRow>}
    <SettingRow title="MCP 服务器" description={desktop ? (config ? `用户级配置：${config.path}` : "读取 ~/.pi/agent/mcp.json") : "MCP 服务器请在电脑端管理。"}>
      {desktop ? <div className="settings-directory-actions"><Button variant="ghost" disabled={busy} onClick={() => void showPaths()}>路径</Button><Button variant="outline" disabled={busy} onClick={() => void reload()}>刷新</Button><Button variant="default" disabled={busy} onClick={() => void addServer()}>添加</Button></div> : <span className="remote-settings-note">电脑端设置</span>}
    </SettingRow>
    {(config?.servers ?? []).map(server => {
      const live = liveTools.get(server.name);
      const authenticated = config?.authenticated.includes(server.name) ?? false;
      const exposure = live?.exposure ?? server.exposure ?? undefined;
      const detail = [server.transport === "stdio" ? server.command : server.transport === "http" ? server.url : "配置无效", live ? `${live.tools.length} 个工具` : "未连接", exposure ? MCP_EXPOSURE_LABELS[exposure] ?? exposure : null, authenticated ? "已登录" : null, server.enabled ? null : "已禁用"].filter(Boolean).join(" · ");
      return <SettingRow key={server.name} title={server.name} description={<><span>{detail}</span>{server.envKeys.length + server.headerKeys.length > 0 && <span className="remote-settings-note">密钥：{[...server.envKeys, ...server.headerKeys].join("、")}</span>}</>}>
        <div className="settings-directory-actions">
          {exposure && <Select aria-label={`${server.name} 工具暴露`} disabled={busy} value={exposure} onChange={event => void changeServer(server, { exposure: event.target.value })}><option value="codemode">Codemode 脚本</option><option value="direct">直接声明</option><option value="deferred">tool_search</option><option value="hidden">隐藏</option></Select>}
          <Button variant="outline" disabled={busy} onClick={() => void changeServer(server, { enabled: !server.enabled })}>{server.enabled ? "禁用" : "启用"}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void removeServer(server.name)}>移除</Button>
        </div>
      </SettingRow>;
    })}
    {!config?.servers.length && <SettingRow title="没有 MCP 服务器" description="添加后可以用 codemode 脚本、tool_search 或直接工具调用远程与本地 MCP。"><span className="remote-settings-note">{desktop ? "未配置" : "电脑端设置"}</span></SettingRow>}
    <SettingRow title="图片模型" description={images.length ? "generate_image 默认使用的模型；工具参数可覆盖，分辨率与画幅只作为默认值。" : "需要一个 OpenAI 兼容的出图端点；未配置时用内置的火山方舟。"}>
      {desktop ? <div className="settings-directory-actions">
        <Select aria-label="图片模型" value={imageSettings.data?.defaults?.model ?? ""} onChange={event => void writeImageSetting({ model: event.target.value })}>
          <option value="">默认（第一个可用）</option>
          {images.map(model => <option key={`${model.provider}/${model.id}`} value={model.id}>{model.name ?? model.id}</option>)}
        </Select>
        <Select aria-label="默认分辨率" value={imageSettings.data?.defaults?.resolution ?? ""} onChange={event => void writeImageSetting({ resolution: event.target.value })}>
          <option value="">默认分辨率</option>
          {imageOptions.resolutions.map(resolution => <option key={resolution} value={resolution}>{resolution}</option>)}
        </Select>
        <Select aria-label="默认画幅" value={imageSettings.data?.defaults?.aspect ?? ""} onChange={event => void writeImageSetting({ aspect: event.target.value })}>
          <option value="">画幅自动</option>
          {imageOptions.aspects.map(aspect => <option key={aspect} value={aspect}>{aspect}</option>)}
        </Select>
        <Button variant="outline" onClick={() => setImageEndpointOpen(true)}><Icon name="sliders-horizontal" />端点</Button>
      </div> : <span className="remote-settings-note">{images.length ? `${images.length} 个可用` : "电脑端设置"}</span>}
    </SettingRow>
    <ImageEndpointDialog open={imageEndpointOpen} onOpenChange={setImageEndpointOpen} config={imageSettings.data} onSaved={() => { void imageSettings.refetch(); void refreshCapabilities(); }} />
    <SettingRow title="分类器模型" description={classifiers.length ? classifiers.map(model => `${model.provider}/${model.id}`).join("、") : "可用 Jev 或 llama.cpp 分类器模型运行 codemode 中的 models.classify()。"}><span className="remote-settings-note">{classifiers.length ? `${classifiers.length} 个可用` : "无可用凭据"}</span></SettingRow>
    <SettingRow title="缓存预热" description="长工具调用期间保活可缓存的 prompt 前缀，按避免的缓存未命中成本决定是否刷新。写入 ~/.pi/agent/settings.json。">
      {desktop ? <Select aria-label="缓存预热" value={typeof guiSettings.data?.settings.cacheWarming === "string" ? guiSettings.data.settings.cacheWarming : ""} onChange={event => void writeSetting("cacheWarming", event.target.value || null)}><option value="">跟随 Pi 默认（运行中）</option><option value="streaming">运行中</option><option value="idle">运行中与空闲</option><option value="off">关闭</option></Select> : <span className="remote-settings-note">{CACHE_WARMING_LABELS[capabilities?.settings?.cacheWarming ?? ""] ?? "—"}</span>}
    </SettingRow>
    <SettingRow title="Codemode 模式" description="on：声明给模型的工具仅在 codemode 里被调用；only：其他工具全部隐藏，模型只能通过脚本调用。">
      {desktop ? <Select aria-label="Codemode 模式" value={guiSettings.data?.settings.codemode?.mode ?? ""} onChange={event => void writeSetting("codemode", event.target.value ? { mode: event.target.value, ...(guiSettings.data?.settings.codemode?.inlineBudget !== undefined ? { inlineBudget: guiSettings.data.settings.codemode.inlineBudget } : {}) } : null)}><option value="">跟随 Pi 默认（on）</option><option value="on">on</option><option value="only">only</option></Select> : <span className="remote-settings-note">电脑端设置</span>}
    </SettingRow>
    <SettingRow title="虚拟模型" description={capabilities?.virtualModels.length ? capabilities.virtualModels.map(model => `${model.provider}/${model.id}`).join("、") : "用 /gui-virtual-model 注册按请求路由的模型（如 router/auto）。"}><span className="remote-settings-note">{capabilities?.virtualModels.length ? `${capabilities.virtualModels.length} 个已注册` : "未注册"}</span></SettingRow>
    <SettingRow title="工具暴露" description={capabilities ? Object.entries(capabilities.tools.exposure).map(([exposure, count]) => `${MCP_EXPOSURE_LABELS[exposure] ?? exposure} ${count}`).join(" · ") : "连接 Pi 后读取。"}><span className="remote-settings-note">{capabilities ? `${capabilities.tools.active}/${capabilities.tools.total} 启用` : "—"}</span></SettingRow>
  </>;
}

export function SettingsGroup({ title, icon, description, children }: { title: string; icon: string; description?: string; children: ReactNode }) {
  return <section className="settings-group">
    <header className="settings-group-heading"><h2><Icon name={icon} /><span>{title}</span></h2>{description && <p>{description}</p>}</header>
    <Card className="settings-group-card"><CardContent>{children}</CardContent></Card>
  </section>;
}

export function SettingRow({ title, description, children, className = "" }: { title: string; description: ReactNode; children: ReactNode; className?: string }) {
  return <div className={`settings-item ${className}`}>
    <div className="settings-item-copy"><strong>{title}</strong><p>{description}</p></div>
    <div className="settings-item-control">{children}</div>
  </div>;
}

function TrustSettings({ mode, busy, desktop, onChange }: { mode: ProjectTrustMode; busy: boolean; desktop: boolean; onChange: (mode: ProjectTrustMode) => Promise<void> }) {
  return <SettingRow title="项目资源信任" description={desktop ? "控制是否加载项目本地的设置、扩展、技能和主题。切换后会重启 Pi 连接。" : "项目资源信任由电脑端管理，请在电脑端查看和修改。"}>{desktop ? <Select aria-label="项目资源信任" disabled={busy} value={mode} onChange={event => void onChange(event.target.value as ProjectTrustMode)}><option value="always">完全访问</option><option value="ask">每次询问</option><option value="never">禁止加载</option></Select> : <span className="remote-settings-note">电脑端设置</span>}</SettingRow>;
}

function ContextSettings({ cwd, status, running, state, onCompact }: { cwd: string; status: string; running: boolean; state: RpcSessionState | null; onCompact: () => Promise<void> }) {
  const stats = useQuery({ queryKey: ["pi", "stats", cwd], queryFn: () => request<{ tokens: { total: number }; cost: number; contextUsage?: { percent: number | null; contextWindow: number } }>({ type: "get_session_stats" }), enabled: status === "online" });
  return <>
    <SettingRow title="自动压缩" description="接近上下文容量时，让 Pi 整理较早的内容。"><Switch aria-label="自动压缩" checked={state?.autoCompactionEnabled ?? false} disabled={status !== "online" || running} onChange={checked => void applySetting({ type: "set_auto_compaction", enabled: checked }).catch(report)} /></SettingRow>
    <SettingRow title="立即压缩" description="现在生成摘要，并可补充需要保留的重点。"><Button variant="outline" disabled={status !== "online" || running} onClick={() => void onCompact().catch(report)}>压缩</Button></SettingRow>
    <div className="settings-stats" aria-busy={stats.isLoading}>
      <div><span>累计 tokens</span><strong>{stats.data?.tokens.total.toLocaleString() ?? "—"}</strong></div>
      <div><span>上下文占用</span><strong>{stats.data?.contextUsage?.percent == null ? "—" : `${stats.data.contextUsage.percent.toFixed(1)}%`}</strong></div>
      <div><span>Pi 报告费用</span><strong>{stats.data ? `$${stats.data.cost.toFixed(4)}` : "—"}</strong></div>
    </div>
  </>;
}

function QueueSettings({ status, state }: { status: string; state: RpcSessionState | null }) {
  return <>{(["steering", "followUp"] as const).map(kind => <SettingRow key={kind} title={kind === "steering" ? "引导消息" : "跟进消息"} description={kind === "steering" ? "当前工具调用完成后交给模型。" : "本轮任务全部结束后交给模型。"}><Select aria-label={kind === "steering" ? "引导消息模式" : "跟进消息模式"} disabled={status !== "online"} value={kind === "steering" ? state?.steeringMode : state?.followUpMode} onChange={event => void applySetting({ type: kind === "steering" ? "set_steering_mode" : "set_follow_up_mode", mode: event.target.value as "all" | "one-at-a-time" }).catch(report)}><option value="one-at-a-time">每次一条</option><option value="all">全部送入</option></Select></SettingRow>)}</>;
}

function DesktopIntegrationSettings({ desktop }: { desktop: boolean }) {
  const platform = useWorkspace(state => state.runtimePlatform);
  const [notify, setNotify] = useState(() => localStorage.getItem(NOTIFY_ON_COMPLETE_KEY) !== "false");
  const [shortcut, setShortcut] = useState(false);
  const [autostart, setAutostart] = useState(false);
  const [keepAwake, setKeepAwake] = useState(() => readKeepAwake());
  const [startupPanel, setStartupPanel] = useState<Panel>(() => readStartupPanel());
  const [busy, setBusy] = useState(false);
  // The assertion is the macOS implementation of "do not sleep"; other desktops
  // keep their own power settings, and saying "on" there would be a lie.
  const canKeepAwake = desktop && platform === "macos";
  useEffect(() => {
    if (!desktop) return;
    void readGlobalShortcut().then(setShortcut).catch(report);
    void readAutostart().then(setAutostart).catch(report);
  }, [desktop]);
  async function apply(change: () => Promise<void>, label: string) {
    setBusy(true);
    try { await change(); gooeyToast.success(`${label}已更新`, { showTimestamp: false }); }
    catch (error) { report(error); }
    finally { setBusy(false); }
  }
  async function changeKeepAwake(enabled: boolean) {
    setKeepAwake(enabled);
    try {
      // A refused assertion is invisible otherwise: the switch would read "on"
      // while the Mac sleeps exactly as it did before.
      const applied = await writeKeepAwake(enabled);
      if (enabled && !applied) gooeyToast.warning("系统没有授予保持唤醒", { showTimestamp: false });
    }
    catch (error) { report(error); }
  }
  return <>
    <SettingRow title="启动页面" description="每次打开 Orbit 时默认显示的页面。默认是「移动端」，扫码配对和 Host 开关就在第一屏。">
      {desktop ? <Select aria-label="启动页面" value={startupPanel} onChange={event => { const panel = event.target.value as Panel; setStartupPanel(panel); writeStartupPanel(panel); }}>{STARTUP_PANELS.map(panel => <option key={panel.id} value={panel.id}>{panel.label}</option>)}</Select> : <span className="remote-settings-note">电脑端设置</span>}
    </SettingRow>
    <SettingRow title="保持屏幕唤醒" description={canKeepAwake ? "Orbit 运行时持有系统唤醒锁（等同于 caffeinate -d -i），屏幕和电脑都不会因为空闲睡眠。手机连接依赖这台电脑在线，所以默认开启。" : "只有 macOS 上的 Orbit 会持有唤醒锁，其他平台沿用系统电源设置。"}>
      {canKeepAwake ? <Switch aria-label="保持屏幕唤醒" checked={keepAwake} onChange={checked => void changeKeepAwake(checked)} /> : <span className="remote-settings-note">{desktop ? "系统电源设置" : "电脑端设置"}</span>}
    </SettingRow>
    <SettingRow title="完成通知" description="任务跑完时发系统通知；Orbit 在前台时不打扰。">
      {desktop ? <Switch aria-label="完成通知" checked={notify} onChange={checked => { setNotify(checked); localStorage.setItem(NOTIFY_ON_COMPLETE_KEY, String(checked)); }} /> : <span className="remote-settings-note">电脑端设置</span>}
    </SettingRow>
    <SettingRow title="全局快捷键" description={`${GLOBAL_SHORTCUT.replace("CommandOrControl", "⌘/Ctrl")} 显示或隐藏 Orbit 窗口，Orbit 不在前台也有效。`}>
      {desktop ? <Switch aria-label="全局快捷键" checked={shortcut} disabled={busy} onChange={checked => void apply(async () => { await writeGlobalShortcut(checked); setShortcut(checked); }, "全局快捷键")} /> : <span className="remote-settings-note">电脑端设置</span>}
    </SettingRow>
    <SettingRow title="开机自启" description="登录时自动启动 Orbit。">
      {desktop ? <Switch aria-label="开机自启" checked={autostart} disabled={busy} onChange={checked => void apply(async () => { await writeAutostart(checked); setAutostart(checked); }, "开机自启")} /> : <span className="remote-settings-note">电脑端设置</span>}
    </SettingRow>
  </>;
}

function ToolsSettings({ tools, running }: { tools: GuiTools; running: boolean }) {
  const active = new Set(tools.active);
  return <>{tools.tools.map(tool => <SettingRow key={tool.name} title={tool.name} description={tool.description}><Switch aria-label={tool.name} checked={active.has(tool.name)} disabled={running} onChange={checked => { const next = checked ? [...tools.active, tool.name] : tools.active.filter(name => name !== tool.name); void request({ type: "prompt", message: `/gui-tools-set ${JSON.stringify(next)}` }).catch(report); }} /></SettingRow>)}{!tools.tools.length && <p className="settings-empty-note">连接 Pi 后读取工具列表。</p>}</>;
}

function TerminalSettings({ cwd, desktop }: { cwd: string; desktop: boolean }) {
  return <SettingRow title="原生终端环境" description={desktop ? "在独立终端中使用账户登录、包安装和完整的 Pi 交互能力。" : "原生终端需要在电脑端打开。"}><Button variant="outline" disabled={!desktop || !cwd} onClick={() => { if (desktopRuntime()) void invoke("open_pi_terminal", { cwd, session: null, piArgs: [] }).catch(report); }}><Icon name="terminal-window" />打开终端</Button></SettingRow>;
}

function DesktopUpdateSettings({ desktop }: { desktop: boolean }) {
  const [busy, setBusy] = useState(false);
  async function checkNow() {
    setBusy(true);
    try { await checkForDesktopUpdate({ notifyNoUpdate: true }); }
    catch (error) { report(error); }
    finally { setBusy(false); }
  }
  return <SettingRow title="软件更新" description={desktop ? "启动时会自动检查；也可以手动检查当前 Apple Silicon 安装包是否有新版本。" : "软件更新请在电脑端检查。"}><Button variant="outline" disabled={!desktop || busy} onClick={() => void checkNow()}>{busy ? "检查中…" : "检查更新"}</Button></SettingRow>;
}

function HistorySettings({ cwd, desktop, busy, setBusy }: { cwd: string; desktop: boolean; busy: boolean; setBusy: (value: boolean) => void }) {
  async function clearHistory() {
    if (!desktop) return;
    const accepted = await confirm("这会删除电脑上所有项目的 Pi Session 和 JSONL 历史记录，磁盘上的项目代码不会受影响。此操作无法撤销。", { title: "清空所有会话历史", kind: "warning" });
    if (!accepted) return;
    setBusy(true);
    try {
      const removed = await clearSessionHistory();
      if (cwd) await connect(cwd, "project");
      gooeyToast.success("会话历史已清空", { description: `已删除 ${removed} 个 JSONL 文件`, showTimestamp: false });
    } catch (error) { report(error); }
    finally { setBusy(false); }
  }
  return <SettingRow title="清空会话历史" description={desktop ? "删除所有项目的 Session 和 JSONL 历史记录，只保留项目文件。" : "请在电脑端清空会话历史。"}><Button variant="destructive" disabled={!desktop || busy} onClick={() => void clearHistory()}><Icon name="trash" />{busy ? "清空中…" : "清空全部历史"}</Button></SettingRow>;
}

function RuntimePath({ label, value }: { label: string; value?: string }) {
  return <div className="settings-runtime-path"><span>{label}</span><code title={value || "未解析"}>{value || "未解析"}</code></div>;
}

function RuntimeSettings({ desktop, cwd }: { desktop: boolean; cwd: string }) {
  const discovery = useRuntimeDiscovery(desktop);
  if (!desktop) return <SettingRow title="运行位置" description="Pi 运行在已配对的电脑上，路径由电脑端统一管理。"><span className="remote-settings-note">远程电脑</span></SettingRow>;
  const value: RuntimeDiscovery | undefined = discovery.data;
  return <>
    <div className="settings-runtime-paths" aria-busy={discovery.isLoading}>
      <RuntimePath label="当前工作目录" value={cwd || value?.cwd} />
      <RuntimePath label="Pi CLI" value={value?.pi} />
      <RuntimePath label="Pi 来源" value={value?.piSource} />
      <RuntimePath label="Node 进程" value={value?.node} />
      <RuntimePath label="宿主 Node" value={value?.hostNode} />
      <RuntimePath label="Node 版本" value={value?.nodeVersion} />
      <RuntimePath label="Pi 配置" value={value?.agentDir} />
      <RuntimePath label="会话目录" value={value?.sessionsDir} />
      <RuntimePath label="Orbit resources" value={value?.resourcesDir} />
      <RuntimePath label="资源依赖" value={value?.nodeModules} />
    </div>
    {discovery.error && <p className="settings-empty-note">运行环境读取失败：{String(discovery.error)}</p>}
  </>;
}

/**
 * Holding the connection while the app is not on screen.
 *
 * Android's only mechanism for this is a foreground service, and it requires a
 * notification the user cannot dismiss — so the toggle says so rather than
 * springing it on them, and reports what the service is actually doing: a start
 * can be refused (a missing prerequisite permission, a start from the
 * background), and a switch that reads "on" while nothing holds the connection
 * is worse than one that reads "failed".
 */
function BackgroundConnectionSettings() {
  const [status, setStatus] = useState<BackgroundConnectionStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Re-apply the remembered intent here: mounting this panel is always with
    // the app in the foreground, which is the only state Android lets a
    // foreground service be started from.
    void restoreBackgroundConnection()
      .then((restored) => restored ?? backgroundConnectionStatus())
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await setBackgroundConnection(enabled);
      setStatus(next);
      if (enabled && !next.running) setError(next.error ?? "系统没有启动连接服务");
    } catch (caught) {
      setError(String(caught instanceof Error ? caught.message : caught));
      setStatus(await backgroundConnectionStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingRow
      title="后台保持连接"
      description="用一个前台服务保住配对连接，切到别的应用再回来不必重连。系统会显示一条常驻通知，无法隐藏——这是 Android 对前台服务的要求。网络切换、电脑休眠仍会断开。"
    >
      <div className="settings-directory-actions">
        <Switch aria-label="后台保持连接" checked={status?.running ?? false} disabled={busy || status?.supported === false} onChange={(checked) => void toggle(checked)} />
        {error ? <span className="remote-settings-note">{error}</span> : null}
      </div>
    </SettingRow>
  );
}

function MobileAppUpdateSettings() {
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getVersion().then(setVersion).catch(() => undefined); }, []);
  async function check() {
    setBusy(true);
    try {
      const current = version || await getVersion();
      if (!version) setVersion(current);
      const update = await checkMobileUpdate(current);
      if (update) offerMobileUpdate(update);
      else gooeyToast.success(`已是最新版本（${current}）`, { showTimestamp: false });
    } catch (error) {
      gooeyToast.error(mobileUpdateErrorMessage(error), { showTimestamp: false });
    } finally {
      setBusy(false);
    }
  }
  return <SettingRow title="检查更新" description={version ? `当前版本 ${version}。从 GitHub 检查 Android 安装包；网络不好时可稍后重试。` : "从 GitHub 检查 Android 安装包；网络不好时可稍后重试。"}><Button variant="outline" disabled={busy} onClick={() => void check()}>{busy ? "检查中…" : "检查更新"}</Button></SettingRow>;
}

function remoteAddress(host: RemoteHostInfo) {
  const address = host.advertisedAddress.includes(":") ? `[${host.advertisedAddress}]` : host.advertisedAddress;
  return `${address}:${host.port}`;
}

function randomRelaySecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hiddenPairingUri(uri: string) {
  return uri.replace(/([?&]token=)[^&]*/i, "$1********");
}

export function DesktopHostSettings({ pageMode = false }: { pageMode?: boolean } = {}) {
  const [host, setHost] = useState<RemoteHostInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showQr, setShowQr] = useState(true);
  const [connectionFeedback, setConnectionFeedback] = useState("");
  const [transport, setTransport] = useState<"lan" | "relay" | "auto">(() => typeof window === "undefined" ? "lan" : localStorage.getItem("orbit.remote.transport") === "relay" ? "relay" : localStorage.getItem("orbit.remote.transport") === "auto" ? "auto" : "lan");
  const [relay, setRelay] = useState<RelaySettingsStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("");
  const [hostKey, setHostKey] = useState("");
  const [relaySaving, setRelaySaving] = useState(false);
  const previousClients = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    void relaySettingsStatus().then(value => {
      if (!mounted) return;
      setRelay(value);
      setRelayUrl(value.relayUrl);
      if (!value.hasHostKey) setTransport("lan");
    }).catch(report);
    const refreshHost = () => void getRemoteHost().then(info => {
      if (!mounted) return;
      const clients = info?.connectedClients ?? 0;
      if (previousClients.current !== null && clients !== previousClients.current) {
        setConnectionFeedback(clients > previousClients.current ? `手机已连接 · 当前 ${clients} 台` : "手机已断开");
      }
      previousClients.current = clients;
      setHost(info);
      if (info) setTransport(info.mode);
    }).catch(report).finally(() => { if (mounted) setLoading(false); });
    refreshHost();
    const timer = window.setInterval(refreshHost, 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  async function start() {
    setBusy("start");
    try {
      if ((transport === "relay" || transport === "auto") && relay && !relay.hasHostKey) throw new Error("请先保存 Relay 地址和 Host Key");
      localStorage.setItem("orbit.remote.transport", transport);
      persistState("orbit.remote.transport", transport);
      const info = await startRemoteHost({ mode: transport });
      rememberRemoteHostEnabled(true);
      previousClients.current = info.connectedClients;
      setConnectionFeedback(info.mode === "relay" && !info.relayConnected ? "正在连接中转服务器…" : "");
      setHost(info);
      gooeyToast.success("移动访问已开启", { description: info.mode === "relay" ? info.relayUrl || "公网中转" : `${info.advertisedAddress}:${info.port}`, showTimestamp: false });
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }

  async function saveRelay() {
    setRelaySaving(true);
    try {
      const normalized = relayUrl.trim().replace(/\/+$/, "");
      if (!/^wss:\/\//i.test(normalized)) throw new Error("Relay 地址必须以 wss:// 开头");
      if (hostKey.trim().length < 32) throw new Error("Host Key 至少 32 位，可点「生成」自动创建");
      const next = await saveRelaySettings({ relayUrl: normalized, hostKey: hostKey.trim() });
      setRelay(next);
      setHostKey("");
      gooeyToast.success("Relay 配置已保存", { showTimestamp: false });
    } catch (error) {
      report(error);
    } finally {
      setRelaySaving(false);
    }
  }

  async function stop() {
    setBusy("stop");
    try {
      await stopRemoteHost();
      rememberRemoteHostEnabled(false);
      setHost(null);
      previousClients.current = null;
      setConnectionFeedback("");
      setRevealed(false);
      setShowQr(false);
      gooeyToast.success("移动访问已关闭", { showTimestamp: false });
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }

  async function copyPairingUri() {
    if (!host) return;
    try {
      await navigator.clipboard.writeText(host.pairingUri);
      gooeyToast.success("配对链接已复制", { showTimestamp: false });
    } catch (error) {
      report(error);
    }
  }

  const statusLabel = loading ? "正在读取" : host ? "已开启" : "未开启";
  const connectedLabel = host ? (host.connectedClients > 0 ? `手机已连接 · ${host.connectedClients}` : host.mode === "relay" ? (host.relayConnected ? "中转已连接 · 等待手机" : "正在连接中转服务器…") : "等待手机连接") : "";
  const transportSetting = <SettingRow title="连接方式" description={transport === "lan" ? "同一 Wi-Fi 下手机直连电脑，不经过服务器。" : transport === "auto" ? "同时准备局域网和 Relay，手机自动选择更快、更稳定的路径。" : "手机在任何网络（含 5G）通过你自己的阿里云中转服务器连接电脑，电脑无需开放端口。"} className="remote-address-setting">
    <Select aria-label="移动端连接方式" value={transport} disabled={Boolean(host) || Boolean(busy) || Boolean(relay && !relay.hasHostKey && (transport === "relay" || transport === "auto"))} onChange={event => setTransport(event.target.value as "lan" | "relay" | "auto")}>
      <option value="lan">局域网直连</option>
      <option value="relay" disabled={Boolean(relay && !relay.hasHostKey)}>公网中转 · 阿里云</option>
      <option value="auto" disabled={Boolean(relay && !relay.hasHostKey)}>自动选择 · 局域网 + Relay</option>
    </Select>
  </SettingRow>;
  const relaySetting = <div className="remote-relay-config">
    <SettingRow title="Relay 地址" description="你的阿里云中转服务器地址，格式 wss://IP 或 wss://域名。" className="remote-relay-setting">
      <Input aria-label="Relay 地址" value={relayUrl} disabled={Boolean(host) || relaySaving} placeholder="wss://101.201.45.25" autoCapitalize="none" autoComplete="off" spellCheck={false} onChange={event => setRelayUrl(event.target.value)} />
    </SettingRow>
    <SettingRow title="Host Key" description={relay?.hasHostKey ? "已保存在本机，只有你的电脑能以这台电脑身份连入中转。留空表示不修改。" : "电脑连入中转服务器的身份密钥，不会出现在手机二维码里。可用「生成」自动创建。"} className="remote-relay-setting">
      <div className="remote-host-key-row">
        <Input type="password" aria-label="Host Key" value={hostKey} disabled={Boolean(host) || relaySaving} placeholder={relay?.hasHostKey ? "已配置，留空保持不变" : "粘贴或生成 Host Key"} autoComplete="off" onChange={event => setHostKey(event.target.value)} />
        <Button variant="outline" disabled={Boolean(host) || relaySaving} onClick={() => setHostKey(randomRelaySecret())}>生成</Button>
      </div>
    </SettingRow>
    <div className="remote-relay-actions"><Button disabled={Boolean(host) || relaySaving || !relayUrl.trim()} onClick={() => void saveRelay()}>{relaySaving ? "保存中…" : "保存 Relay 配置"}</Button></div>
  </div>;
  if (pageMode) {
    const relayReady = Boolean(relay?.hasHostKey);
    return <div className="mobile-access-page">
      <SettingsGroup title="电脑 Host" icon="desktop" description="开启后，手机 Orbit 可以连接这台电脑查看会话、继续对话。">
        <SettingRow title={host ? "Host 运行中" : "Host 未开启"} description={host ? connectedLabel || statusLabel : "开启后用手机 Orbit 扫描下方二维码即可配对。"}>
          <Switch aria-label="电脑 Host" checked={Boolean(host)} disabled={loading || Boolean(busy)} onChange={checked => void (checked ? start() : stop())} />
        </SettingRow>
        {transportSetting}
        <details className="settings-item mobile-access-relay-item">
          <summary>
            <div className="settings-item-copy"><strong>公网中转配置</strong><p>{relayReady ? "已配置中转服务器，可从外网（含 5G）连接。" : "配置阿里云 Relay 后可从外网（含 5G）连接，电脑无需开放端口。"}</p></div>
            <span className="mobile-access-pill"><span className="remote-host-status-dot" data-online={relayReady} />{relayReady ? "已配置" : "未配置"}</span>
          </summary>
          {relaySetting}
        </details>
      </SettingsGroup>

      <SettingsGroup title="扫码连接" icon="device-mobile" description="手机与电脑连接同一 Wi-Fi 后扫码配对。">
        {host ? <div className="mobile-access-qr-block">
          <div className="mobile-access-qr"><QRCode type="svg" errorLevel="M" value={host.pairingUri} size={176} bordered={false} color="#111111" bgColor="#ffffff" /></div>
          <p className="mobile-access-qr-copy">{host.mode === "relay" ? "任何网络均可连接" : "同一 Wi-Fi 下直连电脑，连接速度更快"}</p>
          <Button variant="ghost" title="复制配对链接" aria-label="复制配对链接" onClick={() => void copyPairingUri()}>复制配对链接</Button>
          {connectionFeedback && <p className="remote-host-feedback" role="status">{connectionFeedback}</p>}
          <p className="remote-host-security"><Icon name="shield-check" />已配对的手机与这台电脑等同权限：能浏览、读取和修改这里的文件，也能执行 Git 与终端命令。配对链接只发到自己的设备。</p>
        </div> : <div className="mobile-access-qr-block"><div className="mobile-access-qr-empty"><ScanLine /><strong>开启电脑 Host 后显示二维码</strong><span>使用手机 Orbit 扫描即可连接</span></div></div>}
      </SettingsGroup>
    </div>;
  }
  return <>
    <SettingRow title="电脑 Host" description="手机通过局域网直连，或经你自己的阿里云中转服务器从外网连接这台电脑。">
      <div className="remote-host-control">
        <span className="remote-host-status" aria-live="polite"><span className="remote-host-status-dot" data-online={Boolean(host)} />{statusLabel}{host && <small>{connectedLabel}</small>}</span>
        <Switch aria-label="电脑 Host" checked={Boolean(host)} disabled={loading || Boolean(busy)} onChange={checked => void (checked ? start() : stop())} />
      </div>
    </SettingRow>
    {transportSetting}
    {relaySetting}
    <div className="remote-host-details">
      {host ? <>
        <div className="remote-host-detail">
          <span>电脑</span>
          <strong className="remote-host-machine">{host.machineName}</strong>
        </div>
        <div className="remote-host-detail">
          <span>{host.mode === "relay" ? "中转服务器" : "连接地址"}</span>
          <code title={host.mode === "relay" ? host.relayUrl ?? "" : remoteAddress(host)}>{host.mode === "relay" ? host.relayUrl ?? "" : remoteAddress(host)}</code>
        </div>
        <div className="remote-host-detail remote-host-pairing">
          <span>配对链接</span>
          <code title={revealed ? host.pairingUri : "配对凭据已隐藏"}>{revealed ? host.pairingUri : hiddenPairingUri(host.pairingUri)}</code>
          <div className="remote-host-detail-actions">
            <Button variant="ghost" size="icon" title={revealed ? "隐藏配对链接" : "显示配对链接"} aria-pressed={revealed} onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff /> : <Eye />}</Button>
            <Button variant="ghost" size="icon" title="复制配对链接" onClick={() => void copyPairingUri()}><Icon name="copy" /></Button>
            <Button variant="ghost" size="icon" title={showQr ? "隐藏二维码" : "显示二维码"} aria-pressed={showQr} onClick={() => setShowQr(value => !value)}><ScanLine /></Button>
          </div>
        </div>
        {showQr && <div className="remote-host-qr"><QRCode type="svg" errorLevel="M" value={host.pairingUri} size={240} bordered={false} color="#111111" bgColor="#ffffff" /><span>用手机 Orbit 扫描此二维码，连接这台电脑</span></div>}
        {connectionFeedback && <p className="remote-host-feedback" role="status">{connectionFeedback}</p>}
        <p className="remote-host-security"><Icon name="shield-check" />配对链接包含访问凭据，请只发送到自己的设备。</p>
        <div className="remote-host-devices">
          <strong>已连接的设备</strong>
          {host.connectedClients > 0
            ? Array.from({ length: host.connectedClients }, (_, index) => <div className="remote-host-device" key={index}><Icon name="device-mobile" /><span>移动端设备 {index + 1}</span><small><i />在线</small></div>)
            : <p>暂无设备连接</p>}
        </div>
      </> : <>
        <div className="remote-host-qr remote-host-qr-empty"><ScanLine /><strong>开启电脑 Host 后显示二维码</strong><span>手机扫描二维码即可连接当前电脑</span></div>
        <div className="remote-host-detail remote-host-detail-muted"><span>配对状态</span><span>等待开启</span></div>
      </>}
    </div>
  </>;
}

export function MobileAccessSettings() {
  const runtimeTarget = useWorkspace(state => state.runtimeTarget);
  const connection = useWorkspace(state => state.connection);
  if (runtimeTarget !== "mobile") return <DesktopHostSettings pageMode />;
  return <SettingRow title="电脑连接" description="移动访问地址和配对凭据由电脑端管理，请在电脑端开启或关闭 Host。"><span className="remote-host-status" aria-live="polite"><span className="remote-host-status-dot" data-online={connection === "online"} />{connection === "online" ? "已连接电脑" : connection === "connecting" ? "正在连接电脑" : "未连接电脑"}</span></SettingRow>;
}

export function GeneralSettingsPanel() {
  const ask = usePrompt();
  const cwd = useWorkspace(state => state.cwd);
  const status = useWorkspace(state => state.connection);
  const state = useWorkspace(workspace => workspace.state);
  const running = useWorkspace(workspace => workspace.transcript.running);
  const toolStatus = useWorkspace(workspace => workspace.statuses["gui-tools"]);
  const runtimeTarget = useWorkspace(workspace => workspace.runtimeTarget);
  const desktop = runtimeTarget === "desktop";
  const [historyBusy, setHistoryBusy] = useState(false);
  const [trustMode, setTrustMode] = useState<ProjectTrustMode>("ask");
  const [trustBusy, setTrustBusy] = useState(false);
  let tools: GuiTools = { tools: [], active: [] };
  try { if (toolStatus) tools = JSON.parse(toolStatus); } catch { /* Older extension output stays in diagnostics. */ }

  useEffect(() => {
    if (status !== "online") return;
    void request<{ commands: { name: string }[] }>({ type: "get_commands" }).then(data => {
      if (data.commands.some(command => command.name === "gui-tools")) return request({ type: "prompt", message: "/gui-tools" });
    }).catch(report);
  }, [status]);
  useEffect(() => { if (desktop) void getProjectTrustMode().then(setTrustMode).catch(report); }, [desktop]);

  async function manualCompact() {
    const instructions = await ask({ title: "压缩说明（可以留空）", multiline: true });
    if (instructions !== null) await request({ type: "compact", customInstructions: instructions }, 180000).then(() => loadMessages(cwd));
  }
  async function changeTrustMode(mode: ProjectTrustMode) {
    if (!desktopRuntime()) return;
    setTrustBusy(true);
    try {
      await setProjectTrustMode(mode);
      setTrustMode(mode);
      if (status === "online") { await disconnect(); await connect(cwd); }
      gooeyToast.success("项目权限已更新", { showTimestamp: false });
    } catch (error) { report(error); }
    finally { setTrustBusy(false); }
  }

  return <>
    <div className="panel-heading"><div><h1><Icon name="gear-six" />常规</h1></div></div>
    <SettingsGroup title="桌面集成" icon="desktop" description="启动页面、屏幕保持唤醒、系统通知、全局快捷键与开机自启。"><DesktopIntegrationSettings desktop={desktop} /></SettingsGroup>
    <SettingsGroup title="工作区" icon="folder-simple"><TrustSettings mode={trustMode} busy={trustBusy} desktop={desktop} onChange={changeTrustMode} /></SettingsGroup>
    {runtimeTarget === "mobile" && <SettingsGroup title="后台与更新" icon="arrows-clockwise" description="保持配对连接，以及从 GitHub Release 检查 Android 安装包。"><BackgroundConnectionSettings /><MobileAppUpdateSettings /></SettingsGroup>}
    <SettingsGroup title="上下文" icon="brain" description="管理当前会话的容量与压缩方式。"><ContextSettings cwd={cwd} status={status} running={running} state={state} onCompact={manualCompact} /></SettingsGroup>
    <SettingsGroup title="消息队列" icon="chats"><QueueSettings status={status} state={state} /></SettingsGroup>
    <SettingsGroup title="运行环境" icon="terminal-window" description="Pi、Node、配置和资源目录的实际解析结果。"><RuntimeSettings desktop={desktop} cwd={cwd} /></SettingsGroup>
    <SettingsGroup title="更新" icon="arrows-clockwise"><DesktopUpdateSettings desktop={desktop} /></SettingsGroup>
    <SettingsGroup title="工具与终端" icon="wrench"><ToolsSettings tools={tools} running={running} /><TerminalSettings cwd={cwd} desktop={desktop} /></SettingsGroup>
    <SettingsGroup title="Pi 1.0 能力" icon="plugs-connected" description="MCP、Codemode、Tool Search、图片与分类器模型、虚拟路由模型。"><PiCapabilitiesSettings desktop={desktop} online={status === "online"} running={running} tools={tools} /></SettingsGroup>
    <SettingsGroup title="数据管理" icon="trash" description="管理保存在电脑上的会话历史。"><HistorySettings cwd={cwd} desktop={desktop} busy={historyBusy} setBusy={setHistoryBusy} /></SettingsGroup>
  </>;
}
