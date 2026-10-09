import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { projectRoots, type Project } from "../../lib/projects";
import { desktopRuntime, report } from "../../lib/rpc";
import { shortenPath } from "../../lib/workspace-roots";
import { Modal } from "../../shared/ui/Modal";
import { TextField } from "../../shared/ui/controls";
import { Folder, FolderOpen, Loader, Plus, X } from "../../shared/ui/icons";

/**
 * Orbit `ProjectEditorDialog`, on Orbit's tokens.
 *
 * The roots list is the point of this dialog: every row is a small card (icon
 * tile, name over a mono path) instead of a bare line, the home root wears a
 * badge rather than a text label, and removal appears on hover so the resting
 * state stays quiet. Adding is a full-width dashed row — the same affordance as
 * "drop something here", which is what attaching a workspace is.
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
    if (!desktopRuntime()) return;
    const selected = await open({ directory: true, multiple: true, title: "添加项目目录", defaultPath: project.path });
    if (!selected) return;
    const next = (Array.isArray(selected) ? selected : [selected]).map((path) => path.replace(/\/+$/, "") || "/");
    setRoots((current) => [...new Set([...current, ...next])]);
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
        className="flex flex-col gap-5 p-5 text-[13px]"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-content/55">项目名称</span>
          <TextField wide value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </label>

        <section aria-label="项目目录" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-content/55">目录</span>
            <span className="rounded-full bg-content/6 px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-content/45">
              {roots.length} 个 root
            </span>
          </div>
          <div className="overflow-hidden rounded-xl border border-content/10 bg-content/3">
            {roots.map((path, index) => {
              const rootName = path.split("/").filter(Boolean).at(-1) || path;
              const home = index === 0;
              return (
                <div
                  key={path}
                  className={`group flex items-center gap-3 px-3 py-2.5 ${index > 0 ? "border-t border-content/5" : ""}`}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-content/6 text-content/60">
                    {home ? <FolderOpen className="size-3.5" strokeWidth={1.75} /> : <Folder className="size-3.5" strokeWidth={1.75} />}
                  </span>
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[12.5px] font-medium text-content">{rootName}</span>
                    <span className="block truncate font-mono text-[11px] text-content/45" title={path}>
                      {shortenPath(path, homeDir)}
                    </span>
                  </span>
                  {home ? (
                    <span className="shrink-0 rounded-full bg-selection px-2 py-0.5 text-[10.5px] text-content/60">主目录</span>
                  ) : (
                    <button
                      type="button"
                      title={`移除 ${rootName}`}
                      aria-label={`移除 ${rootName}`}
                      onClick={() => setRoots((current) => current.filter((root) => root !== path))}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-content/40 opacity-0 transition hover:bg-red-400/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
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
              className="flex h-9.5 w-full items-center justify-center gap-1.5 border-t border-dashed border-content/12 text-[12px] text-content/50 transition-colors hover:bg-content/5 hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
              添加目录
            </button>
          </div>
          <p className="text-[11px] leading-4 text-content/35">附加目录里的 AGENTS.md 与技能会一并提供给会话。</p>
        </section>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-content/60 transition-colors hover:bg-content/8 hover:text-content active:scale-[0.97] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-content px-3.5 py-1.5 font-medium text-background-base transition hover:bg-content/80 active:scale-[0.97] disabled:opacity-40"
          >
            {saving ? <Loader className="size-3.5 animate-spin" /> : null}
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
