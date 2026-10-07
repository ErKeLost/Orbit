import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast as gooeyToast } from "../../shared/ui/toast";
import { useWorkspace } from "../../lib/store";
import { desktopRuntime, loadMessages, refresh, report, request } from "../../lib/rpc";
import { Button, Input } from "../UI";
import { usePrompt } from "../../lib/prompt";
import { Icon } from "../Icon";

export function PiToolsPanel() {
  const cwd = useWorkspace(state => state.cwd);
  const online = useWorkspace(state => state.connection === "online");
  const running = useWorkspace(state => state.transcript.running);
  const desktop = useWorkspace(state => state.runtimeTarget === "desktop");
  const ask = usePrompt();
  const [packageName, setPackageName] = useState("");

  async function command(message: string) {
    try { await request({ type: "prompt", message }, 60000, cwd); await refresh(cwd); }
    catch (error) { report(error); }
  }
  async function terminalCommand(args: string[]) {
    if (!desktopRuntime()) { report("该 Pi 功能需要电脑端"); return; }
    try { await invoke("open_pi_terminal", { cwd, session: null, piArgs: args }); gooeyToast.info("已在终端打开 Pi 命令", { description: args.join(" "), showTimestamp: false }); }
    catch (error) { report(error); }
  }
  async function importSession() {
    if (!desktopRuntime()) { report("会话导入需要电脑端"); return; }
    const selected = await open({ multiple: false, title: "导入 Pi 会话", filters: [{ name: "Pi 会话", extensions: ["jsonl"] }] });
    if (typeof selected !== "string") return;
    await command(`/import ${JSON.stringify(selected)}`);
    await loadMessages(cwd);
    gooeyToast.success("会话已导入", { showTimestamp: false });
  }
  async function rename() {
    const name = await ask({ title: "会话名称", initial: useWorkspace.getState().state?.sessionName ?? "" });
    if (name === null) return;
    try { await request({ type: "set_session_name", name }, 30000, cwd); await refresh(cwd); gooeyToast.success("会话名称已更新", { showTimestamp: false }); }
    catch (error) { report(error); }
  }
  async function copyLast() {
    try {
      const result = await request<{ text: string | null }>({ type: "get_last_assistant_text" }, 30000, cwd);
      if (result.text) { await navigator.clipboard.writeText(result.text); gooeyToast.success("已复制最后一条助手消息", { showTimestamp: false }); }
      else gooeyToast.info("没有可复制的助手消息", { showTimestamp: false });
    } catch (error) { report(error); }
  }
  async function packageCommand(action: "install" | "update" | "remove") {
    if (!desktopRuntime()) { report("Pi Package 管理需要电脑端"); return; }
    if (!packageName.trim() && action !== "update") { report("请输入 Pi Package 名称"); return; }
    const args = action === "install" ? ["install", packageName.trim()] : action === "remove" ? ["remove", packageName.trim()] : ["update", "--extensions"];
    try { await invoke("open_pi_terminal", { cwd, session: null, piArgs: args }); setPackageName(""); }
    catch (error) { report(error); }
  }

  return <>
    <div className="panel-heading"><div><h1><Icon name="wrench" />常用工具</h1><p>把常用的 Pi 命令集中到桌面界面。</p></div></div>
    <section className="settings-section settings-action-section"><h2><Icon name="chats" />会话操作</h2><div className="tool-action-grid"><Button variant="ghost" disabled={!desktop || !online || running} onClick={() => void importSession().catch(report)}><Icon name="download" />导入 JSONL</Button><Button variant="ghost" disabled={!desktop || !online} onClick={() => void terminalCommand(["/share"]).catch(report)}><Icon name="share-network" />分享会话</Button><Button variant="ghost" disabled={!online} onClick={() => void rename().catch(report)}><Icon name="pencil-simple" />重命名</Button><Button variant="ghost" disabled={!online} onClick={() => void copyLast().catch(report)}><Icon name="copy" />复制最后回复</Button></div></section>
    <section className="settings-section settings-action-section"><h2><Icon name="stack" />模型范围与资源</h2><div className="tool-action-grid"><Button variant="ghost" disabled={!desktop || !online || running} onClick={() => void terminalCommand(["/scoped-models"]).catch(report)}><Icon name="funnel" />Scoped Models</Button><Button variant="ghost" disabled={!online} onClick={() => void command("/reload").then(() => gooeyToast.success("资源已刷新", { showTimestamp: false })).catch(report)}><Icon name="arrows-clockwise" />重新加载资源</Button><Button variant="ghost" disabled={!desktop || !online} onClick={() => void terminalCommand(["/hotkeys"]).catch(report)}><Icon name="keyboard" />快捷键</Button><Button variant="ghost" disabled={!desktop || !online} onClick={() => void terminalCommand(["/changelog"]).catch(report)}><Icon name="list" />变更记录</Button></div></section>
    <section className="settings-section settings-package-section"><h2><Icon name="package" />Pi Package</h2><div className="input-row"><Input value={packageName} disabled={!desktop} onChange={event => setPackageName(event.target.value)} placeholder="npm:包名 或 git:仓库" aria-label="Pi Package 名称" /><Button variant="default" disabled={!desktop || !online || running} onClick={() => void packageCommand("install").catch(report)}><Icon name="plus" />安装</Button></div><div className="tool-action-grid"><Button variant="ghost" disabled={!desktop || !online || running} onClick={() => void packageCommand("update").catch(report)}><Icon name="arrows-clockwise" />更新全部</Button><Button variant="ghost" disabled={!desktop || !online || running || !packageName.trim()} onClick={() => void packageCommand("remove").catch(report)}><Icon name="trash" />移除</Button></div></section>
    <section className="settings-section settings-resource-section"><h2><Icon name="puzzle-piece" />资源来源</h2><div className="settings-resource-row"><p>扩展、技能、模板和交互状态会实时同步到当前项目。</p><Button variant="outline" title="刷新技能、模板与扩展" disabled={!online} onClick={() => void command("/reload").then(() => gooeyToast.success("技能、模板与扩展已刷新", { showTimestamp: false })).catch(report)}><Icon name="arrows-clockwise" />刷新资源</Button></div></section>
  </>;
}
