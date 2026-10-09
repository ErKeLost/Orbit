import { useWorkspace, type SettingsPage } from "../../lib/store";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import {
  ArrowLeft,
  Bot,
  CursorMagicSelection,
  DashboardSquare,
  Inbox,
  Palette,
  Sparkles,
  SlidersHorizontal,
  Wrench,
  type IconComponent,
} from "../../shared/ui/icons";

export type SettingsSection = { id: SettingsPage; label: string; description: string; icon: IconComponent; desktopOnly?: boolean };

export const SETTINGS_GROUPS: { id: string; label: string; sections: SettingsSection[] }[] = [
  {
    id: "app",
    label: "应用",
    sections: [
      { id: "general", label: "General", description: "运行位置、Pi 能力、移动访问与更新。", icon: SlidersHorizontal },
      { id: "appearance", label: "外观", description: "主题、色调、透明度、聊天背景与 Diff 颜色。", icon: Palette },
      { id: "screen", label: "屏幕", description: "手机端看到的电脑屏幕与小窗。", icon: DashboardSquare },
    ],
  },
  {
    id: "agents",
    label: "智能体",
    sections: [
      { id: "providers", label: "Providers", description: "Pi 的模型端点、API Key 与模型目录。", icon: Bot, desktopOnly: true },
      { id: "computer-use", label: "操作电脑", description: "让 Pi 用自然语言点选本机界面所用的决策模型。", icon: CursorMagicSelection, desktopOnly: true },
      { id: "skills", label: "技能", description: "查看与管理 Pi 加载的技能和命令。", icon: Sparkles },
      { id: "pi-tools", label: "常用工具", description: "直接在终端里运行的 Pi 命令。", icon: Wrench },
    ],
  },
  {
    id: "workspace",
    label: "工作区",
    sections: [
      { id: "inbox", label: "Inbox", description: "管理各项目的收件箱来源与通知。", icon: Inbox },
    ],
  },
];

export const ALL_SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.sections);

export function sectionOf(page: SettingsPage) {
  return ALL_SECTIONS.find((section) => section.id === page) ?? ALL_SECTIONS[0];
}

function NavRow({ label, icon: Icon, active = false, disabled = false, onClick }: { label: string; icon: IconComponent; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "请在电脑端管理" : undefined}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:cursor-default disabled:opacity-40 ${
        active ? "bg-selection text-content" : "text-content/50 hover:bg-content/5 hover:text-content"
      }`}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{label}</span>
    </button>
  );
}

/** Body of the project rail while settings are open (MonoCode `SettingsNav`). */
export function SettingsNav() {
  const page = useWorkspace((state) => state.settingsPage);
  // A phone reaches these pages over the paired socket, so only the browser
  // preview has nothing behind them.
  const target = useWorkspace((state) => state.runtimeTarget);
  const desktop = target === "desktop" || target === "mobile";
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  return (
    <>
      <div ref={lockOverscroll} aria-label="设置" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-none px-2 py-3">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.id} className="flex flex-col gap-px">
            <div className="px-2 pb-1 text-xs font-semibold text-content/35">{group.label}</div>
            {group.sections.map((item) => (
              <NavRow
                key={item.id}
                label={item.label}
                icon={item.icon}
                active={item.id === page}
                disabled={Boolean(item.desktopOnly && !desktop)}
                onClick={() => useWorkspace.getState().set({ settingsPage: item.id })}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-px p-2">
        <NavRow label="Back" icon={ArrowLeft} onClick={() => useWorkspace.getState().set({ panel: "chat" })} />
      </div>
    </>
  );
}
