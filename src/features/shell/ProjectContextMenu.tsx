import { useEffect, useRef, useState } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { PROJECT_PALETTE, type Project, useProjects } from "../../lib/projects";
import { report } from "../../lib/rpc";
import { Popover } from "../../shared/ui/Popover";
import {
  Archive,
  Check,
  Copy,
  FolderOpen,
  ImagePlus,
  Pencil,
  Pin,
  PinOff,
  Trash2 as Trash,
  X,
} from "../../shared/ui/icons";

/**
 * 项目右键菜单（monocode 的项目菜单精简版）：顶部改名、色板，下面是
 * 置顶 / 访达 / 默认应用 / 编辑 / 复制路径 / 移除。
 */
export function ProjectContextMenu({
  project,
  x,
  y,
  onEdit,
  onRemove,
  onClose,
}: {
  project: Project;
  x: number;
  y: number;
  /** 打开现有的 ProjectEditorDialog（管理 app roots）。 */
  onEdit: (project: Project) => void;
  /** 打开移除确认。 */
  onRemove: (project: Project) => void;
  onClose: () => void;
}) {
  const { update } = useProjects();
  const [name, setName] = useState(project.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 浮层出现后选中名称文本，直接输入即可覆盖（monocode 的行为）。
    input.current?.select();
  }, []);

  const patch = (next: Partial<Project>) => update({ ...project, ...next });

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== project.name) patch({ name: trimmed });
    else setName(project.name);
  };

  async function chooseLogo() {
    const picked = await pickFile({
      multiple: false,
      title: "选择项目 Logo",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] }],
    });
    if (typeof picked === "string") patch({ logoPath: picked });
  }

  return (
    <Popover anchor={{ x, y }} width={288} onDismiss={onClose} role="menu" aria-label="项目选项" className="p-1.5">
      <input
        ref={input}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            saveName();
            onClose();
          }
        }}
        onBlur={saveName}
        aria-label="项目名称"
        className="h-8 w-full rounded-md border border-content/10 bg-content/5 px-2 text-[13px] text-content outline-none focus-visible:border-accent/60"
      />

      {/* Logo 行：替换侧栏里的文件夹图标，可移除（monocode 的 Project logo）。 */}
      <div className="mt-1.5 grid grid-cols-[1fr_auto] items-center gap-1">
        <MenuRow
          icon={<ImagePlus className="size-4" strokeWidth={1.75} />}
          label={project.logoPath ? "更换 Logo…" : "设置 Logo…"}
          onClick={() => void chooseLogo()}
        />
        {project.logoPath ? (
          <MenuRow
            icon={<X className="size-4" strokeWidth={1.75} />}
            label="移除"
            onClick={() => patch({ logoPath: undefined })}
          />
        ) : null}
      </div>

      {/* 颜色板：第一颗是「跟随默认」，最后是自定义取色。 */}
      <div className="mt-2 flex items-center gap-1.5 px-0.5" role="radiogroup" aria-label="项目颜色">
        <Swatch
          label="默认颜色"
          color="hsl(210 8% 45%)"
          active={project.colorIndex == null && !project.customColor}
          onClick={() => patch({ colorIndex: undefined, customColor: undefined })}
        />
        {PROJECT_PALETTE.slice(1).map((value, index) => (
          <Swatch
            key={value}
            label={`颜色 ${index + 1}`}
            color={value}
            active={!project.customColor && project.colorIndex === index + 1}
            onClick={() => patch({ colorIndex: index + 1, customColor: undefined })}
          />
        ))}
        <label
          title="自定义颜色"
          className="relative grid size-5 shrink-0 cursor-pointer place-items-center rounded-full"
          style={{ background: "conic-gradient(#f66, #fc0, #6f9, #6cf, #96f, #f66)" }}
        >
          <input
            type="color"
            aria-label="自定义颜色"
            value={/^#[0-9a-fA-F]{6}$/.test(project.customColor ?? "") ? project.customColor : "#7c7c7c"}
            onChange={(event) => patch({ customColor: event.target.value, colorIndex: undefined })}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>

      <div className="my-1.5 border-t border-stroke" />

      <MenuRow
        icon={project.pinned ? <PinOff className="size-4" strokeWidth={1.75} /> : <Pin className="size-4" strokeWidth={1.75} />}
        label={project.pinned ? "取消置顶" : "置顶项目"}
        onClick={() => {
          patch({ pinned: !project.pinned });
          onClose();
        }}
      />
      <MenuRow
        icon={<FolderOpen className="size-4" strokeWidth={1.75} />}
        label={navigator.platform.includes("Mac") ? "在访达中显示" : "在文件管理器中显示"}
        onClick={() => {
          void revealItemInDir(project.path).catch(report);
          onClose();
        }}
      />
      <MenuRow
        icon={<FolderOpen className="size-4" strokeWidth={1.75} />}
        label="用默认应用打开"
        onClick={() => {
          void openPath(project.path).catch(report);
          onClose();
        }}
      />
      <MenuRow
        icon={<Pencil className="size-4" strokeWidth={1.75} />}
        label="编辑项目…"
        onClick={() => {
          onEdit(project);
          onClose();
        }}
      />
      <MenuRow
        icon={<Copy className="size-4" strokeWidth={1.75} />}
        label="复制路径"
        onClick={() => {
          void navigator.clipboard.writeText(project.path).catch(report);
          onClose();
        }}
      />

      <div className="my-1.5 border-t border-stroke" />

      <MenuRow
        icon={<Archive className="size-4" strokeWidth={1.75} />}
        label="归档项目"
        onClick={() => {
          patch({ archivedAt: Date.now() });
          onClose();
        }}
      />
      <MenuRow
        danger
        icon={<Trash className="size-4" strokeWidth={1.75} />}
        label="移除项目"
        onClick={() => {
          onRemove(project);
          onClose();
        }}
      />
    </Popover>
  );
}

function Swatch({ color, label, active, onClick }: { color: string; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      title={label}
      onClick={onClick}
      className={`relative grid size-5 shrink-0 place-items-center rounded-full ring-offset-1 ring-offset-background-base ${
        active ? "ring-2 ring-content/50" : "hover:scale-110"
      }`}
      style={{ background: color }}
    >
      {active ? <Check className="size-3 text-white mix-blend-difference" strokeWidth={2.5} /> : null}
    </button>
  );
}

function MenuRow({ icon, label, danger = false, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
        danger ? "text-danger hover:bg-danger/10" : "text-content hover:bg-content/10"
      }`}
    >
      <span className={`shrink-0 ${danger ? "text-danger" : "text-content/50"}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
