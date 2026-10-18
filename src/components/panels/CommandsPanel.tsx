import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { request } from "../../lib/rpc";
import { commandSourceLabel, getCommandVisual } from "../../lib/command-visual";
import { Button, Input, Skeleton } from "../../shared/ui/controls";
import { Icon } from "../Icon";

type Command = { name: string; description?: string; source: string; sourceInfo?: { path?: string; origin?: string } };

export function CommandsPanel() {
  const cwd = useWorkspace(state => state.cwd);
  const online = useWorkspace(state => state.connection === "online");
  const data = useQuery({ queryKey: ["pi", "commands", cwd], queryFn: () => request<{ commands: Command[] }>({ type: "get_commands" }), enabled: online });
  const [search, setSearch] = useState("");
  const query = search.toLowerCase();
  const visibleCommands = data.data?.commands.filter(command => !command.name.startsWith("gui-") && `${command.name} ${command.description} ${command.sourceInfo?.path ?? ""} ${command.sourceInfo?.origin ?? ""}`.toLowerCase().includes(query)) ?? [];
  const hasCommands = data.data?.commands.some(command => !command.name.startsWith("gui-"));
  return <>
    <div className="panel-heading"><div><h1>技能与命令</h1><p>Pi 当前加载的技能、提示模板和扩展命令。</p></div></div>
    <Input className="search-input" placeholder="查找命令或技能" value={search} onChange={event => setSearch(event.target.value)} />
    {data.isLoading && <Skeleton paragraph={{ rows: 5 }} />}
    {data.error && <p className="error-inline">{String(data.error)}</p>}
    <div className="command-list">{visibleCommands.map(command => {
      const visual = getCommandVisual(command.name, command.source);
      const location = command.sourceInfo?.path || command.sourceInfo?.origin;
      return <Button className="command-row" key={command.name} onClick={() => useWorkspace.getState().set({ draft: `/${command.name} `, panel: "chat" })}><span className={`command-icon command-icon-${visual.tone}`}><Icon name={visual.icon} /></span><span className="command-copy"><span className="command-title"><strong>/{command.name}</strong><span className={`command-source command-source-${command.source}`}>{commandSourceLabel(command.source)}</span></span><span className="command-description">{command.description || "没有提供说明"}</span>{location && <span className="command-location" title={location}>{location}</span>}</span><Icon className="command-arrow" name="arrow-right" /></Button>;
    })}</div>
    {data.data && !hasCommands && <div className="empty-panel"><Icon name="puzzle-piece" /><h3>还没有加载扩展或技能</h3><p>在 Pi 中安装后重新连接，就能从这里使用。</p></div>}
  </>;
}
