import { useMemo, useState } from "react";
import { toast as gooeyToast } from "../../shared/ui/toast";
import { useWorkspace } from "../../lib/store";
import { changeSession, report, retireSession } from "../../lib/rpc";
import type { Session } from "../../lib/protocol";
import { mergeProjectSessions, useProjectSessions } from "../../hooks/use-project-sessions";
import { Button, Input } from "../UI";
import { Icon } from "../Icon";
import { ConfirmDialog } from "../../features/shell/ConfirmDialog";
import { MenuItem, MenuSeparator, PointMenu } from "../../shared/ui/controls";

export function SessionsPanel() {
  const cwd = useWorkspace(state => state.cwd);
  const online = useWorkspace(state => state.connection === "online");
  const liveSessions = useWorkspace(state => state.liveSessions);
  const sessions = useProjectSessions(cwd);
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [menu, setMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const merged = useMemo(() => mergeProjectSessions(cwd, sessions.data ?? [], liveSessions), [cwd, liveSessions, sessions.data]);
  const query = search.toLowerCase();
  const visibleSessions = merged.sessions.filter(session => `${session.name ?? ""} ${session.firstMessage}`.toLowerCase().includes(query));

  async function remove() {
    if (!deleting) return;
    try {
      await retireSession(deleting.path);
      setDeleting(null);
      await sessions.refetch();
      gooeyToast.success("会话已删除", { showTimestamp: false });
    } catch (error) {
      report(error);
    }
  }

  return <>
    <div className="panel-heading"><div><h1><Icon name="chats" />所有会话</h1><p>保存在本机的项目对话。</p></div><div className="panel-heading-actions"><span className="badge"><Icon name="chats" />{visibleSessions.length} 个会话</span><Button className="primary" disabled={!online} onClick={() => void changeSession({ type: "new_session" }).catch(report)}><Icon name="plus" />新会话</Button></div></div>
    <label className="settings-page-search"><Icon name="magnifying-glass" /><Input className="search-input" aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={event => setSearch(event.target.value)} /></label>
    {sessions.error && <p className="error-inline">{String(sessions.error)}</p>}
    <div className="session-rows">{visibleSessions.map(session => {
      const working = liveSessions.some(live => live.running && live.path === session.path);
      const label = session.name || session.firstMessage || "未命名会话";
      const openSession = () => void changeSession({ type: "switch_session", sessionPath: session.path }).catch(report);
      return <div key={session.id} className={`session-row${working ? " working" : ""}`} onContextMenu={event => { event.preventDefault(); setMenu({ session, x: event.clientX, y: event.clientY }); }}>
          <Button disabled={!online} aria-busy={working} onClick={openSession}><Icon name="chats" /><span><strong>{label}</strong><small>{session.messageCount} 条消息 · {session.modified ? new Date(session.modified).toLocaleString("zh-CN") : "刚刚"}</small></span>{working ? <span className="session-working-indicator" title="正在工作" aria-hidden /> : <Icon name="arrow-up-right" />}</Button>
          {merged.listedPaths.has(session.path) && <Button title="删除会话" disabled={!online} onClick={() => setDeleting(session)}><Icon name="trash" /></Button>}
        </div>;
    })}</div>
    {!merged.sessions.length && <div className="empty-panel"><Icon name="chats" /><h3>还没有保存的会话</h3><p>发送第一条消息后，Pi 会自动保存。</p></div>}
    {menu && <PointMenu x={menu.x} y={menu.y} label="会话操作" onClose={() => setMenu(null)}>
      <MenuItem disabled={!online} onClick={() => { void changeSession({ type: "switch_session", sessionPath: menu.session.path }).catch(report); setMenu(null); }}>打开会话</MenuItem>
      <MenuItem onClick={() => { void navigator.clipboard.writeText(menu.session.name || menu.session.firstMessage || ""); setMenu(null); }}>复制标题</MenuItem>
      {merged.listedPaths.has(menu.session.path) && <><MenuSeparator /><MenuItem danger disabled={!online} onClick={() => { setDeleting(menu.session); setMenu(null); }}>删除会话</MenuItem></>}
    </PointMenu>}
    {deleting && <ConfirmDialog title="删除会话" confirmLabel="删除" danger onCancel={() => setDeleting(null)} onConfirm={() => void remove()}><p className="font-medium text-content">{deleting.name || deleting.firstMessage || "未命名会话"}</p></ConfirmDialog>}
  </>;
}
