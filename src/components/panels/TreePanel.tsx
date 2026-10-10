import { useQuery } from "@tanstack/react-query";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { useWorkspace } from "../../lib/store";
import { changeSession, refresh, reloadMessages, report, request } from "../../lib/rpc";
import { Button } from "../UI";
import { usePrompt } from "../../lib/prompt";
import { Icon } from "../Icon";
import { toast as gooeyToast } from "../../shared/ui/toast";

function TreeNode({ node, leafId, depth = 0, disabled }: { node: SessionTreeNode; leafId: string | null; depth?: number; disabled: boolean }) {
  const ask = usePrompt();
  const entry = node.entry;
  const text = entry.type === "message" ? ("content" in entry.message ? (typeof entry.message.content === "string" ? entry.message.content : JSON.stringify(entry.message.content)) : JSON.stringify(entry.message)).slice(0, 150) : entry.type;
  async function navigate(summarize = false) {
    await request({ type: "prompt", message: `/gui-tree ${JSON.stringify({ id: entry.id, summarize })}` }, 60000);
    // 切分支会整体换掉 transcript：先上骨架屏，别让旧分支停在原地再突然抽掉。
    await reloadMessages();
  }
  async function label() {
    const value = await ask({ title: "为这个节点命名", initial: node.label ?? "" });
    if (value === null) return;
    await request({ type: "prompt", message: `/gui-label ${JSON.stringify({ id: entry.id, label: value })}` });
    await refresh();
    gooeyToast.success("节点名称已更新", { showTimestamp: false });
  }
  return <div className="tree-node" style={{ paddingLeft: depth ? 18 : 0 }}><div className={`tree-entry ${entry.id === leafId ? "current" : ""}`}><Icon name="git-commit" /><div><small>{entry.type === "message" ? entry.message.role : entry.type}{entry.id === leafId ? " · 当前分支" : ""}</small><p>{node.label || text}</p></div><Button title="从这里继续" disabled={disabled} onClick={() => void navigate().catch(report)}><Icon name="arrow-bend-up-right" /></Button><Button title="从这里继续并总结" disabled={disabled} onClick={() => void navigate(true).catch(report)}><Icon name="sparkle" /></Button><Button title="标签" disabled={disabled} onClick={() => void label().catch(report)}><Icon name="bookmark-simple" /></Button>{entry.type === "message" && entry.message.role === "user" && <Button title="从这里创建分叉会话" disabled={disabled} onClick={() => void changeSession({ type: "fork", entryId: entry.id }).catch(report)}><Icon name="git-fork" /></Button>}</div>{node.children.map(child => <TreeNode key={child.entry.id} node={child} leafId={leafId} depth={depth + 1} disabled={disabled} />)}</div>;
}

export function TreePanel() {
  const cwd = useWorkspace(state => state.cwd);
  const online = useWorkspace(state => state.connection === "online");
  const running = useWorkspace(state => state.transcript.running);
  const tree = useQuery({ queryKey: ["pi", "tree", cwd], queryFn: () => request<{ tree: SessionTreeNode[]; leafId: string | null }>({ type: "get_tree" }), enabled: online });
  return <>
    <div className="panel-heading"><div><h1><Icon name="tree-structure" />会话树</h1><p>查看历史节点、切换分支，或从一条消息重新开始。</p></div><Button className="secondary" disabled={!online || running} onClick={() => void changeSession({ type: "clone" }).catch(report)}><Icon name="copy" />克隆当前分支</Button></div>
    {tree.error && <p className="error-inline">{String(tree.error)}</p>}
    {!!tree.data?.tree.length && <div className="tree-list">{tree.data.tree.map(node => <TreeNode key={node.entry.id} node={node} leafId={tree.data!.leafId} disabled={!online || running} />)}</div>}
    {!tree.data?.tree.length && <div className="empty-panel"><Icon name="tree-structure" /><p>消息与分支会出现在这里。</p></div>}
  </>;
}
