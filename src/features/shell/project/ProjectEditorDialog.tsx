import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { normalizeProjectPath, projectRoots, type Project } from "../../../lib/projects";
import { desktopRuntime, report } from "../../../lib/rpc";
import { Modal } from "../../../shared/ui/Modal";
import { TextField } from "../../../shared/ui/controls";
import { Folder, FolderOpen, Loader, Plus, X } from "../../../shared/ui/icons";

/** 路径展示：主目录缩成 `~`。 */
function shortenPath(path: string, homeDir: string) {
  return homeDir && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/**
 * Orbit `ProjectEditorDialog`, on Orbit's tokens.
 *
 * 一个项目 = 一个主目录 + 若干附加 root：路径不是只读的，下面那张表就是
 * 这个对话框存在的理由。附加目录里的 AGENTS.md 与 `.pi/skills` 会和主目录
 * 一起提供给会话，文件引用也能走它们。
 */
export function ProjectEditorDialog({
  project,
  homeDir,
  onClose,
  onSave,
}: {
  project: Project;
  homeDir: string;
  onClose: () => void;
  onSave: (project: Project) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [roots, setRoots] = useState<string[]>(() => projectRoots(project));
  const [saving, setSaving] = useState(false);

  async function addRoots() {
    if (!desktopRuntime()) {
      report("请在电脑端选择文件夹");
      return;
    }
    const selected = await open({ directory: true, multiple: true, title: "添加项目目录", defaultPath: project.path });
    if (!selected) return;
    const next = (Array.isArray(selected) ? selected : [selected]).map((path) => normalizeProjectPath(path as string));
    setRoots((current) => projectRoots({ path: current[0] ?? project.path, name, roots: [...current.slice(1), ...next] }));
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ ...project, name: name.trim(), roots });
      onClose();
    } catch (error) {
      report(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="编辑项目" description={shortenPath(project.path, homeDir)} size="md" onClose={() => { if (!saving) onClose(); }}>
      <form
        className="flex flex-col gap-5 p-5 text-ui"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-ink-2">项目名称</span>
          <TextField wide value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </label>

        <section aria-label="项目目录" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-2">目录</span>
            <span className="rounded-full bg-fill px-2 py-0.5 font-mono text-2xs tabular-nums text-ink-3">
              {roots.length} 个 root
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-fill-weak">
            {roots.map((path, index) => {
              const rootName = path.split("/").filter(Boolean).at(-1) || path;
              const home = index === 0;
              return (
                <div
                  key={path}
                  className={`group flex items-center gap-3 px-3 py-2.5 ${index > 0 ? "border-t border-line" : ""}`}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-fill text-ink-2">
                    {home ? <FolderOpen className="size-3.5" strokeWidth={1.75} /> : <Folder className="size-3.5" strokeWidth={1.75} />}
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-xs font-medium text-ink-1">{rootName}</span>
                    <span className="block truncate font-mono text-2xs text-ink-3" title={path}>
                      {shortenPath(path, homeDir)}
                    </span>
                  </span>
                  {home ? (
                    <span className="shrink-0 rounded-full bg-selection px-2 py-0.5 text-2xs text-ink-2">主目录</span>
                  ) : (
                    <button
                      type="button"
                      title={`移除 ${rootName}`}
                      aria-label={`移除 ${rootName}`}
                      onClick={() => setRoots((current) => current.filter((root) => root !== path))}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 opacity-0 transition hover:bg-negative/10 hover:text-negative focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              disabled={!desktopRuntime()}
              onClick={() => void addRoots().catch(report)}
              className="flex h-9.5 w-full items-center justify-center gap-1.5 border-t border-dashed border-line text-xs text-ink-3 transition-colors hover:bg-fill hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
              添加目录
            </button>
          </div>
          <p className="text-2xs leading-4 text-ink-3">附加目录里的 AGENTS.md 与技能会一并提供给会话。</p>
        </section>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-ink-2 transition-colors hover:bg-fill-strong hover:text-ink-1 active:scale-[0.97] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-ink-1 px-3.5 py-1.5 font-medium text-background-base transition hover:bg-ink-1/70 active:scale-[0.97] disabled:opacity-40"
          >
            {saving ? <Loader className="size-3.5 animate-spin" /> : null}
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
