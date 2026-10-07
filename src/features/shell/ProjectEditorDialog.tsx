import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { projectRoots, type Project } from "../../lib/projects";
import { desktopRuntime, report } from "../../lib/rpc";
import { shortenPath } from "../../lib/workspace-roots";
import { Modal } from "../../shared/ui/Modal";
import { SecondaryButton, TextField } from "../../shared/ui/controls";
import { Folder, FolderOpen, FolderPlus, Loader, X } from "../../shared/ui/icons";

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
        className="flex flex-col gap-4 p-4 text-[13px]"
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
            <span className="text-[11px] text-content/40">{roots.length} 个 app root</span>
          </div>
          <div className="overflow-hidden rounded-lg border border-content/10 bg-content/3">
            {roots.map((path, index) => {
              const rootName = path.split("/").filter(Boolean).at(-1) || path;
              return (
                <div key={path} className="flex items-center gap-2.5 border-b border-content/5 px-3 py-2 last:border-b-0">
                  {index === 0 ? (
                    <FolderOpen className="size-3.5 shrink-0 text-content/55" strokeWidth={1.75} />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-content/55" strokeWidth={1.75} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-content">{rootName}</span>
                    <span className="block truncate font-mono text-[11px] text-content/45" title={path}>
                      {shortenPath(path, homeDir)}
                    </span>
                  </span>
                  {index === 0 ? (
                    <span className="shrink-0 text-[11px] text-content/40">主目录</span>
                  ) : (
                    <button
                      type="button"
                      title={`移除 ${rootName}`}
                      aria-label={`移除 ${rootName}`}
                      onClick={() => setRoots((current) => current.filter((root) => root !== path))}
                      className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content"
                    >
                      <X className="size-3.5" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <SecondaryButton disabled={!desktopRuntime()} onClick={() => void addRoots().catch(report)}>
              <FolderPlus className="size-3.5" strokeWidth={1.75} />
              添加目录
            </SecondaryButton>
          </div>
        </section>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onClose} className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]">
            取消
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 font-medium text-background-base hover:bg-content/80 active:scale-[0.97] disabled:opacity-40"
          >
            {saving ? <Loader className="size-3.5 animate-spin" /> : null}
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
