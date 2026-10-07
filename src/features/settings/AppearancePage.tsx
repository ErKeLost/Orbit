import { useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImagePlus } from "../../shared/ui/icons";
import { SecondaryButton } from "../../shared/ui/controls";
import { UI_SCALE_PERCENTS, useAppearance, type DiffPalette, type ThemePreference } from "../../lib/appearance";
import { useShell } from "../shell/shellStore";
import { Group, Row, Segmented, Select, Slider, Toggle } from "../../shared/ui/controls";

/** MonoCode ACCENT_COLOR_PRESETS. */
const ACCENT_PRESETS = ["#4da3f5", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#10b981"] as const;

function AccentSwatch({ color, active, onSelect, label }: { color: string | null; active: boolean; onSelect: () => void; label: string }) {
  if (color == null) {
    // The "default" swatch: the theme accent with a subtle ring, like MonoCode's.
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={label}
        onClick={onSelect}
        className={`size-5 shrink-0 rounded-full border border-content/20 shadow-inner ${active ? "ring-2 ring-accent/70 ring-offset-2 ring-offset-background-base" : ""}`}
      />
    );
  }
  if (color === "custom") {
    return (
      <span className="relative size-5 shrink-0">
        <button
          type="button"
          role="radio"
          aria-checked={active}
          aria-label={label}
          onClick={onSelect}
          className={`size-5 rounded-full ${active ? "ring-2 ring-accent/70 ring-offset-2 ring-offset-background-base" : ""}`}
          style={{ background: "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #38bdf8, #a78bfa, #f472b6, #f87171)" }}
        />
        <input
          type="color"
          aria-label="自定义强调色"
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={() => onSelect()}
          onInput={(event) => useAppearance.getState().setAccent((event.target as HTMLInputElement).value)}
        />
      </span>
    );
  }
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      onClick={onSelect}
      className={`size-5 shrink-0 rounded-full ${active ? "ring-2 ring-accent/70 ring-offset-2 ring-offset-background-base" : ""}`}
      style={{ background: color }}
    />
  );
}

/** MonoCode's Appearance page: theme + accent + diff colors, then the tint sliders. */
export function AppearancePage() {
  const appearance = useAppearance();
  const glassDisabled = appearance.scheme === "light";
  const collapsedRailMode = useShell((state) => state.collapsedRailMode);
  const setCollapsedRailMode = useShell((state) => state.setCollapsedRailMode);

  async function chooseBackground() {
    const picked = await open({ multiple: false, title: "选择聊天背景图", filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    if (typeof picked === "string") appearance.setChatBackground(picked);
  }
  const customRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Group title="主题" description="深色与浅色共用同一套色调，下面的颜色设置对两者都生效。">
        <Row label="主题" description="跟随系统外观设置。">
          <Segmented<ThemePreference>
            label="主题"
            value={appearance.preference}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "dark", label: "深色" },
              { value: "light", label: "浅色" },
            ]}
            onChange={appearance.setPreference}
          />
        </Row>
        <Row label="强调色" description="发送按钮、消息气泡、Working 状态、加载图标、焦点环等强调色元素。">
          <div role="radiogroup" aria-label="强调色" className="flex items-center gap-2">
            <AccentSwatch color={null} active={appearance.accent == null} onSelect={() => appearance.setAccent(null)} label="默认" />
            {ACCENT_PRESETS.map((color) => (
              <AccentSwatch key={color} color={color} active={appearance.accent === color} onSelect={() => appearance.setAccent(color)} label={color} />
            ))}
            <AccentSwatch color="custom" active={Boolean(appearance.accent) && !ACCENT_PRESETS.includes(appearance.accent as never)} onSelect={() => customRef.current?.click()} label="自定义" />
            <input
              ref={customRef}
              type="color"
              aria-hidden
              tabIndex={-1}
              className="size-0 opacity-0"
              onChange={(event) => appearance.setAccent(event.target.value)}
            />
          </div>
        </Row>
        <Row
          label="Diff 颜色"
          description="新增与删除行的颜色。色盲友好与高对比用蓝橙替代红绿，高对比还会加强底色和文字。"
        >
          <Segmented<DiffPalette>
            label="Diff 颜色"
            value={appearance.diffPalette}
            options={[
              { value: "default", label: "默认" },
              { value: "colorblind", label: "色盲友好" },
              { value: "high-contrast", label: "高对比" },
            ]}
            onChange={appearance.setDiffPalette}
          />
        </Row>
      </Group>

      <Group title="颜色" description="色相与饱和度给所有表面着色，亮度只影响深色主题。">
        <Row label="色相" description="强调色与着色表面的基础色相。">
          <Slider label="色相" value={appearance.hue} display={`${appearance.hue}°`} min={0} max={360} onChange={(value) => appearance.setTint({ hue: value })} />
        </Row>
        <Row label="饱和度" description="色相对界面的着色强度，0 保持中性。">
          <Slider label="饱和度" value={appearance.saturation} display={`${appearance.saturation}%`} min={0} max={100} onChange={(value) => appearance.setTint({ saturation: value })} />
        </Row>
        <Row
          label="深色亮度"
          description={glassDisabled ? "只影响深色模式，你的深色设置会被保留。" : "深色主题的基础亮度，越低越暗，0 为纯黑。"}
        >
          <Slider label="深色亮度" value={appearance.darkLightness} display={`${appearance.darkLightness}%`} min={0} max={30} onChange={(value) => appearance.setTint({ darkLightness: value })} disabled={glassDisabled} />
        </Row>
      </Group>

      <Group
        title="透明度"
        description={glassDisabled ? "浅色模式始终使用不透明窗口，因此这些设置已关闭；你的深色设置会被保留。" : "桌面透过 Orbit 的程度。模糊半径越大，合成开销越高。"}
      >
        <Row label="侧栏不透明度" description="作用于项目栏与其他玻璃面板。">
          <Slider
            label="侧栏不透明度"
            value={Math.round(appearance.sidebarOpacity * 100)}
            display={`${Math.round(appearance.sidebarOpacity * 100)}%`}
            min={15}
            max={100}
            onChange={(value) => appearance.setTint({ sidebarOpacity: value / 100 })}
            disabled={glassDisabled}
          />
        </Row>
        <Row label="模糊半径" description="窗口背后的背景模糊。">
          <Slider label="模糊半径" value={appearance.blur} display={String(appearance.blur)} min={0} max={60} onChange={appearance.setBlur} disabled={glassDisabled} />
        </Row>
        <Row label="主面板玻璃" description="把半透明效果延伸到会话与编辑器所在的主面板。">
          <Toggle label="Main pane glass" on={appearance.bodyGlass} onChange={appearance.setBodyGlass} disabled={glassDisabled} />
        </Row>
      </Group>

      <Group title="聊天背景" description="聊天面板背后的图片，只保存在本机。">
        <div className="px-4 py-3.5">
          <div className="relative flex min-h-[168px] items-center justify-center overflow-hidden rounded-xl border border-content/10 bg-content/2">
            {appearance.chatBackground ? (
              <>
                <img src={convertFileSrc(appearance.chatBackground)} alt="聊天背景" className="max-h-[240px] w-full object-cover" />
                <div className="absolute right-2 top-2 flex gap-1.5">
                  <SecondaryButton onClick={() => void chooseBackground()}>更换</SecondaryButton>
                  <SecondaryButton danger onClick={() => appearance.setChatBackground(null)}>移除</SecondaryButton>
                </div>
              </>
            ) : (
              <button type="button" onClick={() => void chooseBackground()} className="flex flex-col items-center gap-2 px-6 py-10 text-content/45 hover:text-content/70">
                <ImagePlus className="size-6" strokeWidth={1.5} />
                <span className="text-[13px]">选择图片</span>
              </button>
            )}
          </div>
        </div>
      </Group>

      <Group title="布局">
        <Row label="收起时的项目栏" description="收起后保留为紧凑图标栏，或完全隐藏。">
          <Segmented<"compact" | "hidden">
            label="Collapsed project rail"
            value={collapsedRailMode}
            options={[
              { value: "compact", label: "图标栏" },
              { value: "hidden", label: "隐藏" },
            ]}
            onChange={setCollapsedRailMode}
          />
        </Row>
        <Row label="界面缩放" description="缩放整个界面，也可用 Ctrl+=、Ctrl+-、Ctrl+0（macOS 为 Cmd）。">
          <Select
            label="Interface scale"
            value={String(Math.round(appearance.uiScale * 100))}
            options={UI_SCALE_PERCENTS.map((percent) => ({ value: String(percent), label: `${percent}%` }))}
            onChange={(value) => appearance.setUiScale(Number(value) / 100)}
          />
        </Row>
        <Row label="显示被忽略的文件" description="在资源管理器中显示 Git 忽略的文件与目录，例如构建产物和依赖。">
          <Toggle label="Show excluded files" on={appearance.showExcludedFiles} onChange={appearance.setShowExcludedFiles} />
        </Row>
      </Group>
    </>
  );
}
