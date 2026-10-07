import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { request } from "../../lib/rpc";
import { SecondaryButton, Toggle } from "../../shared/ui/controls";
import { toast } from "../../shared/ui/toast";
import { Copy, Eye, Loader, RefreshCw, Search, Terminal } from "../../shared/ui/icons";
import { useShell } from "../shell/shellStore";

const HIDDEN_KEY = "orbit.skillsHidden.v1";

type Command = { name: string; description?: string; source: string; sourceInfo?: { path?: string; origin?: string } };

function badge(command: Command): string {
  if (command.source === "extension") return "扩展";
  if (command.source === "skill") return (command.sourceInfo?.path ?? "").includes("/.pi/agent/") ? "个人" : "项目";
  return "模板";
}

/** MonoCode's Skills page: count + filter + refresh + add, then one card of rows. */
export function SkillsPage() {
  const cwd = useWorkspace((state) => state.cwd);
  const online = useWorkspace((state) => state.connection === "online");
  const data = useQuery({
    queryKey: ["pi", "commands", cwd],
    queryFn: () => request<{ commands: Command[] }>({ type: "get_commands" }, 30000),
    enabled: online,
  });
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[]; } catch { return []; }
  });
  const query = search.trim().toLowerCase();
  const skills = (data.data?.commands ?? []).filter((command) => !command.name.startsWith("gui-"));
  const visible = skills
    .filter((command) => !hidden.includes(command.name))
    .filter((command) => !query || `${command.name} ${command.description ?? ""} ${command.sourceInfo?.path ?? ""}`.toLowerCase().includes(query));

  return (
    <>
      <div className="flex items-center gap-3 pb-4 text-[13px] text-content/45">
        <span className="shrink-0 tabular-nums">{skills.length} 个技能</span>
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-content/10 px-2.5 text-content/45 focus-within:border-content/20">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="筛选"
            aria-label="筛选技能"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/35"
          />
        </label>
        <button
          type="button"
          title="重新读取"
          aria-label="重新读取技能"
          disabled={!online || data.isFetching}
          onClick={() => void data.refetch()}
          className="grid size-8 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          {data.isFetching ? <Loader className="size-4 animate-spin" /> : <RefreshCw className="size-4" strokeWidth={1.75} />}
        </button>
        <SecondaryButton disabled title="在终端运行 pi install 后刷新">添加技能</SecondaryButton>
      </div>

      <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
        {visible.map((command) => {
          const path = command.sourceInfo?.path ?? command.sourceInfo?.origin ?? "";
          const fileName = path.split("/").at(-1) ?? "";
          const enabled = !hidden.includes(command.name);
          return (
            <div key={command.name} className={`border-b border-content/5 px-5 py-4 last:border-b-0 ${enabled ? "" : "opacity-55"}`}>
              <div className="flex items-start gap-6">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-content">{command.name}</div>
                  <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-content/55">{command.description || "没有提供说明"}</p>
                  {path ? <p className="mt-1.5 truncate font-mono text-[11px] text-content/40" title={path}>{path}</p> : null}
                </div>
                <div className="flex w-[190px] shrink-0 flex-col items-end gap-2 pt-0.5">
                  <span className="rounded-md bg-content/8 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-content/60">{badge(command)}</span>
                  <span className="flex items-center gap-2.5">
                    <span className="text-[11px] text-content/45">pi</span>
                    <Toggle
                      label={`${command.name} 显示`}
                      on={enabled}
                      onChange={(on) => {
                        setHidden((current) => {
                          const next = on ? current.filter((name) => name !== command.name) : [...current, command.name];
                          try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
                          return next;
                        });
                        toast.success(on ? `${command.name} 已恢复显示` : `${command.name} 已停用显示`, { description: `Pi 侧仍可用 /${command.name} 调用` });
                      }}
                    />
                  </span>
                  <span className="flex items-center gap-1 text-content/45">
                    {path && fileName.endsWith(".md") ? (
                      <button
                        type="button"
                        title="打开 SKILL.md"
                        aria-label={`打开 ${command.name} 的文件`}
                        onClick={() => useShell.getState().openFile(path, { pin: true })}
                        className="grid size-6 place-items-center rounded-md hover:bg-content/10 hover:text-content"
                      >
                        <Eye className="size-3.5" strokeWidth={1.75} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      title="复制路径"
                      aria-label={`复制 ${command.name} 的路径`}
                      disabled={!path}
                      onClick={() => void navigator.clipboard.writeText(path)}
                      className="grid size-6 place-items-center rounded-md hover:bg-content/10 hover:text-content disabled:opacity-40"
                    >
                      <Copy className="size-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      title="在会话中使用"
                      aria-label={`使用 ${command.name}`}
                      disabled={!online}
                      onClick={() => useWorkspace.getState().set({ draft: `/${command.name} `, panel: "chat" })}
                      className="grid size-6 place-items-center rounded-md hover:bg-content/10 hover:text-content disabled:opacity-40"
                    >
                      <Terminal className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {!online ? <p className="px-5 py-6 text-center text-[12px] text-content/45">连接 Pi 后读取技能。</p> : null}
        {online && !data.isLoading && visible.length === 0 ? (
          <p className="px-5 py-6 text-center text-[12px] text-content/45">{query ? "没有匹配的技能" : "还没有加载技能或命令"}</p>
        ) : null}
      </div>
    </>
  );
}
