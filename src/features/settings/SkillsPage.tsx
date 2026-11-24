import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "../../lib/store";
import { request } from "../../lib/rpc";
import { Button, Input, SecondaryButton, Toggle } from "../../shared/ui/controls";
import { invoke } from "../../lib/native";
import { toast } from "../../shared/ui/toast";
import { Copy, Eye, Loader, RefreshCw, Search, Terminal } from "../../shared/ui/icons";
import { skillBadge as badge } from "../../shared/lib/skillBadge";
import { useShell } from "../shell/shellStore";

const HIDDEN_KEY = "orbit.skillsHidden.v1";

type Command = { name: string; description?: string; source: string; sourceInfo?: { path?: string; origin?: string } };

/** Orbit's Skills page: count + filter + refresh + add, then one card of rows. */
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
  const desktop = useWorkspace((state) => state.runtimeTarget === "desktop");
  const [showPackages, setShowPackages] = useState(false);
  const query = search.trim().toLowerCase();
  const skills = (data.data?.commands ?? []).filter((command) => !command.name.startsWith("gui-"));
  const visible = skills
    .filter((command) => !hidden.includes(command.name))
    .filter((command) => !query || `${command.name} ${command.description ?? ""} ${command.sourceInfo?.path ?? ""}`.toLowerCase().includes(query));

  return (
    <>
      <div className="flex items-center gap-3 pb-4 text-ui text-ink-3">
        <span className="shrink-0 tabular-nums">{skills.length} 个技能</span>
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line px-2.5 text-ink-3 focus-within:border-line-strong">
          <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="筛选"
            aria-label="筛选技能"
            className="min-w-0 flex-1 bg-transparent text-ui text-ink-1 outline-none placeholder:text-ink-3"
          />
        </label>
        <button
          type="button"
          title="重新读取"
          aria-label="重新读取技能"
          disabled={!online || data.isFetching}
          onClick={() => void data.refetch()}
          className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40"
        >
          {data.isFetching ? <Loader className="size-4 animate-spin" /> : <RefreshCw className="size-4" strokeWidth={1.75} />}
        </button>
        <SecondaryButton disabled={!desktop} title="安装 Pi 扩展包（npm / git）" onClick={() => setShowPackages((open) => !open)}>
          {showPackages ? "收起扩展" : "添加技能"}
        </SecondaryButton>
      </div>

      {showPackages ? <PackagesPanel onInstalled={() => void data.refetch()} /> : null}

      <div className="overflow-hidden rounded-xl border border-line bg-fill-weak">
        {visible.map((command) => {
          const path = command.sourceInfo?.path ?? command.sourceInfo?.origin ?? "";
          const fileName = path.split("/").at(-1) ?? "";
          const enabled = !hidden.includes(command.name);
          return (
            <div key={command.name} className={`border-b border-line px-5 py-4 last:border-b-0 ${enabled ? "" : "opacity-55"}`}>
              <div className="flex items-start gap-6">
                <div className="min-w-0 flex-1">
                  <div className="text-ui font-semibold text-ink-1">{command.name}</div>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-2">{command.description || "没有提供说明"}</p>
                  {path ? <p className="mt-1.5 truncate font-mono text-2xs text-ink-3" title={path}>{path}</p> : null}
                </div>
                <div className="flex w-[190px] shrink-0 flex-col items-end gap-2 pt-0.5">
                  <span className="rounded-md bg-fill-strong px-2 py-0.5 text-2xs font-semibold tracking-wide text-ink-2">{badge(command)}</span>
                  <span className="flex items-center gap-2.5">
                    <span className="text-2xs text-ink-3">pi</span>
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
                  <span className="flex items-center gap-1 text-ink-3">
                    {path && fileName.endsWith(".md") ? (
                      <button
                        type="button"
                        title="打开 SKILL.md"
                        aria-label={`打开 ${command.name} 的文件`}
                        onClick={() => useShell.getState().openFile(path, { pin: true })}
                        className="grid size-6 place-items-center rounded-md hover:bg-fill-strong hover:text-ink-1"
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
                      className="grid size-6 place-items-center rounded-md hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40"
                    >
                      <Copy className="size-3.5" strokeWidth={1.75} />
                    </button>
                    <button
                      type="button"
                      title="在会话中使用"
                      aria-label={`使用 ${command.name}`}
                      disabled={!online}
                      onClick={() => useWorkspace.getState().set({ draft: `/${command.name} `, panel: "chat" })}
                      className="grid size-6 place-items-center rounded-md hover:bg-fill-strong hover:text-ink-1 disabled:opacity-40"
                    >
                      <Terminal className="size-3.5" strokeWidth={1.75} />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {!online ? <p className="px-5 py-6 text-center text-xs text-ink-3">连接 Pi 后读取技能。</p> : null}
        {online && !data.isLoading && visible.length === 0 ? (
          <p className="px-5 py-6 text-center text-xs text-ink-3">{query ? "没有匹配的技能" : "还没有加载技能或命令"}</p>
        ) : null}
      </div>
    </>
  );
}

type PackageEntry = { source: string; autoload?: boolean };
type PackageListing = {
  packages: PackageEntry[];
  skills: string[];
  settingsPath?: string;
  listing?: { ok: boolean; stdout: string; stderr: string } | null;
};
type PackageRun = { ok: boolean; timedOut: boolean; exitCode: number | null; stdout: string; stderr: string; elapsedMs: number };
type InstallResult = { source: string; run: PackageRun; packages: PackageEntry[] };
type UpdateResult = { run: PackageRun; changes: { name: string; from: string; to: string }[]; status: string; packages: PackageEntry[] };

/**
 * 扩展包管理：装、卸、更新都走会话用的同一个 Pi runtime。
 *
 * 之前这里只有一句「在终端运行 pi install 后刷新」。安装本身可能要跑几十秒
 * npm/git，所以按钮有 busy 状态，失败时把命令输出原样贴出来——包管理器说了什么，
 * 比一句「安装失败」有用得多。
 */
function PackagesPanel({ onInstalled }: { onInstalled: () => void }) {
  const listing = useQuery({ queryKey: ["pi", "packages"], queryFn: () => invoke<PackageListing>("list_pi_packages"), refetchOnWindowFocus: false });
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ ok: boolean; text: string } | null>(null);
  const [updateReport, setUpdateReport] = useState<UpdateResult | null>(null);
  const packages = listing.data?.packages ?? [];

  async function install() {
    const trimmed = source.trim();
    if (!trimmed) return;
    setBusy("install");
    setLastRun(null);
    try {
      const result = await invoke<InstallResult>("install_pi_package", { source: trimmed, local: false });
      const text = (result.run.stderr || result.run.stdout).trim();
      setLastRun({ ok: result.run.ok, text: text || (result.run.ok ? "已安装" : "命令失败，没有输出") });
      if (result.run.ok) {
        setSource("");
        toast.success(`已安装 ${result.source}`, { description: "重连项目后生效", showTimestamp: false });
        onInstalled();
        await listing.refetch();
      }
    } catch (error) {
      setLastRun({ ok: false, text: String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(target: string) {
    setBusy(`remove:${target}`);
    setLastRun(null);
    try {
      const result = await invoke<InstallResult>("remove_pi_package", { source: target, local: false });
      const text = (result.run.stderr || result.run.stdout).trim();
      setLastRun({ ok: result.run.ok, text: text || (result.run.ok ? "已卸载" : "命令失败，没有输出") });
      if (result.run.ok) {
        toast.success(`已卸载 ${target}`, { showTimestamp: false });
        onInstalled();
        await listing.refetch();
      }
    } catch (error) {
      setLastRun({ ok: false, text: String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function updateAll() {
    setBusy("update");
    setLastRun(null);
    try {
      const result = await invoke<UpdateResult>("update_pi_packages");
      setUpdateReport(result);
      const text = (result.run.stderr || result.run.stdout).trim();
      setLastRun({ ok: result.run.ok, text: text || result.status || "已更新" });
      if (result.run.ok) {
        toast.success(result.changes.length ? `更新了 ${result.changes.length} 个扩展` : "扩展已是最新", { showTimestamp: false });
        await listing.refetch();
      }
    } catch (error) {
      setLastRun({ ok: false, text: String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-line bg-fill-weak">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Input
          aria-label="扩展源"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void install(); }}
          placeholder="npm:@foo/bar 或 git:github.com/user/repo"
          spellCheck={false}
          className="min-w-0 flex-1"
          disabled={busy !== null}
        />
        <Button variant="default" disabled={busy !== null || !source.trim()} onClick={() => void install()}>
          {busy === "install" ? "安装中…" : "安装"}
        </Button>
        <Button variant="outline" disabled={busy !== null || !packages.length} onClick={() => void updateAll()}>
          {busy === "update" ? "更新中…" : "更新全部"}
        </Button>
      </div>

      <div className="divide-y divide-line">
        {packages.map((item) => (
          <div key={item.source} className="flex items-center gap-3 px-4 py-2.5">
            <code className="min-w-0 flex-1 truncate text-xs text-ink-1" title={item.source}>{item.source}</code>
            {item.autoload === false ? <span className="shrink-0 text-2xs text-ink-3">未自动加载</span> : null}
            <Button variant="ghost" disabled={busy !== null} onClick={() => void remove(item.source)}>
              {busy === `remove:${item.source}` ? "卸载中…" : "卸载"}
            </Button>
          </div>
        ))}
        {!packages.length ? (
          <div className="px-4 py-4 text-xs text-ink-3">
            {listing.isLoading ? "正在读取已安装的扩展…" : "还没有安装扩展。粘贴一个 npm 或 git 源后按「安装」。"}
            {listing.data?.listing && !listing.data.listing.ok ? (
              <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all text-[11px] text-negative">
                {(listing.data.listing.stderr || listing.data.listing.stdout).trim()}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>

      {updateReport?.changes.length ? (
        <div className="border-t border-line px-4 py-2.5">
          {updateReport.changes.map((change) => (
            <p key={change.name} className="font-mono text-2xs text-ink-2">{change.name} {change.from} → {change.to}</p>
          ))}
        </div>
      ) : null}

      {lastRun ? (
        <pre className={`max-h-44 overflow-auto whitespace-pre-wrap break-all border-t border-line px-4 py-2.5 text-[11px] leading-relaxed ${lastRun.ok ? "text-ink-2" : "text-negative"}`}>
          {lastRun.text}
        </pre>
      ) : null}

      {listing.data?.settingsPath ? (
        <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">
          写入 <code>{listing.data.settingsPath}</code>，安装后重连项目生效。
        </p>
      ) : null}
    </div>
  );
}
