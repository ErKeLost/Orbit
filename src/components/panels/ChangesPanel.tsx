import { useMemo } from "react";
import { useWorkspace } from "../../lib/store";
import { getChange } from "../../lib/changes";
import { Icon } from "../Icon";
import { CodeChange } from "../CodeChange";

export function ChangesPanel() {
  const transcript = useWorkspace(state => state.transcript);
  const changes = useMemo(() => transcript.messages.flatMap(item => Array.isArray(item.message.content) ? item.message.content.flatMap(part => {
    if (part.type !== "toolCall") return [];
    const tool = transcript.tools[part.id ?? ""];
    const change = getChange(part.name ?? "", part.arguments, tool?.details);
    return change ? [{ id: part.id, change }] : [];
  }) : []), [transcript.messages, transcript.tools]);
  return <>
    <div className="panel-heading"><div><h1><Icon name="file-script" />代码变更</h1><p>Pi 工具返回的真实补丁与写入内容。</p></div><span className="badge"><Icon name="git-merge" />{changes.length} 项变更</span></div>
    {!changes.length && <div className="empty-panel"><Icon name="file-script" /><h3>当前会话尚无文件变更</h3><p>edit 的完整 patch 会显示在这里；write 展示写入内容。</p></div>}
    {changes.map(item => item.change && <CodeChange key={item.id} change={item.change} />)}
  </>;
}
