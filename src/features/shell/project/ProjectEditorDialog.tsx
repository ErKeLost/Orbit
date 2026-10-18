import { useState } from "react";
import type { Project } from "../../../lib/projects";
import { report } from "../../../lib/rpc";
import { Modal } from "../../../shared/ui/Modal";
import { TextField } from "../../../shared/ui/controls";
import { Loader } from "../../../shared/ui/icons";

/** 路径展示：主目录缩成 `~`。 */
function shortenPath(path: string, homeDir: string) {
  return homeDir && path.startsWith(`${homeDir}/`) ? `~${path.slice(homeDir.length)}` : path;
}

/**
 * Orbit `ProjectEditorDialog`, on Orbit's tokens.
 *
 * 一个项目就是一个目录：路径只读展示，这里只改名字。
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
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ ...project, name: name.trim() });
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
