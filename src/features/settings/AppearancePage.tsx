import { useRef, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImagePlus } from "../../shared/ui/icons";
import { SecondaryButton, Segmented, Select, Slider, Toggle } from "../../shared/ui/controls";
import { UI_SCALE_PERCENTS, useAppearance, type DiffPalette, type ThemePreference } from "../../lib/appearance";
import { WORKSPACE_THEMES, type WorkspacePalette } from "./model/workspaceThemes";
import { useShell } from "../shell/shellStore";

function hueName(hue: number) {
  const names: [number, string][] = [
    [20, "Red"],
    [45, "Orange"],
    [70, "Yellow"],
    [150, "Green"],
    [190, "Teal"],
    [250, "Blue"],
    [285, "Purple"],
    [330, "Pink"],
    [360, "Red"],
  ];
  const wrapped = ((hue % 360) + 360) % 360;
  return names.find(([edge]) => wrapped <= edge)?.[1] ?? "Blue";
}

const ACCENT_SWATCHES = ["#4da3f5", "#6fbf73", "#f08a4b", "#b57cf0", "#e7798f", "#d9b25c", "#3fc1b5", "#7aa7ff"] as const;

type ThemeCard = ThemePreference | "high-contrast";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="pt-8 first:pt-1">
      <h2 className="text-sm font-medium text-ink-1">{title}</h2>
      {description ? <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-3">{description}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Surface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-fill-weak ${className}`}>{children}</div>;
}

function MiniLines({ strong = false, light = false }: { strong?: boolean; light?: boolean }) {
  const bar = strong ? "bg-white" : light ? "bg-neutral-300" : "bg-white/25";
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-2">
      <span className={`h-1 w-8 rounded-full ${bar}`} />
      <span className={`h-1 w-12 rounded-full ${bar} opacity-70`} />
      <span className={`mt-1 flex h-2.5 items-center rounded-full px-1 ${strong ? "border border-white" : light ? "bg-neutral-100" : "bg-white/10"}`}>
        <span className="ml-auto size-1.5 rounded-full bg-sky-400" />
      </span>
    </div>
  );
}

function MiniSide({ strong = false, light = false }: { strong?: boolean; light?: boolean }) {
  const bar = strong ? "bg-white" : light ? "bg-neutral-400" : "bg-white/30";
  return (
    <div className={`flex w-7 shrink-0 flex-col gap-1 p-1.5 ${strong ? "border-r border-white bg-black" : light ? "bg-neutral-100" : "bg-black/35"}`}>
      <span className={`h-0.5 w-4 rounded-full ${bar}`} />
      <span className={`h-0.5 w-3 rounded-full ${bar} opacity-70`} />
      <span className={`h-0.5 w-3.5 rounded-full ${bar} opacity-50`} />
    </div>
  );
}

function MiniApp({ tone }: { tone: "light" | "dark" | "contrast" }) {
  const light = tone === "light";
  const strong = tone === "contrast";
  return (
    <div className={`flex h-full ${light ? "bg-white" : strong ? "bg-black" : "bg-[#17171a]"}`}>
      <MiniSide strong={strong} light={light} />
      <MiniLines strong={strong} light={light} />
    </div>
  );
}

function ThemePreview({ card }: { card: ThemeCard }) {
  if (card !== "system") return <MiniApp tone={card === "light" ? "light" : card === "high-contrast" ? "contrast" : "dark"} />;
  return (
    <div className="relative h-full">
      <MiniApp tone="dark" />
      <div className="absolute inset-0" style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}>
        <MiniApp tone="light" />
      </div>
    </div>
  );
}

const THEME_CARDS: { id: ThemeCard; label: string }[] = [
  { id: "system", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "high-contrast", label: "高对比" },
];

/** Appearance, in the task-card language: preview tiles, then a color card. */
export function AppearancePage() {
  const appearance = useAppearance();
  const lightScheme = appearance.scheme === "light";
  const namedTheme = appearance.workspaceTheme !== "default";
  const collapsedRailMode = useShell((state) => state.collapsedRailMode);
  const setCollapsedRailMode = useShell((state) => state.setCollapsedRailMode);
  const customRef = useRef<HTMLInputElement>(null);
  const selected: ThemeCard = appearance.diffPalette === "high-contrast" ? "high-contrast" : appearance.preference;

  async function chooseBackground() {
    const picked = await open({ multiple: false, title: "选择聊天背景图", filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }] });
    if (typeof picked === "string") appearance.setChatBackground(picked);
  }

  function pickTheme(card: ThemeCard) {
    if (card === "high-contrast") {
      appearance.setDiffPalette("high-contrast");
      return;
    }
    appearance.setPreference(card);
    if (appearance.diffPalette === "high-contrast") appearance.setDiffPalette("default");
  }

  function pickHue(hue: number) {
    appearance.setTint({ hue });
  }

  return (
    <>
      <Section title="主题" description="跟随设备。高对比加强差异行的边缘和文字，不改变浅色或深色。">
        <Surface className="p-3">
          <div data-setting-id="theme" role="radiogroup" aria-label="主题" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {THEME_CARDS.map((card) => {
              const active = selected === card.id;
              return (
                <button key={card.id} type="button" role="radio" aria-checked={active} onClick={() => pickTheme(card.id)} className="flex flex-col items-center gap-2 text-center">
                  <span className={`block h-[74px] w-full overflow-hidden rounded-xl border ${active ? "border-ink-1 ring-1 ring-ink-1" : "border-line"}`}>
                    <ThemePreview card={card.id} />
                  </span>
                  <span className={`text-sm ${active ? "text-ink-1" : "text-ink-3"}`}>{card.label}</span>
                </button>
              );
            })}
          </div>
        </Surface>
      </Section>

      <Section title="配色" description="每套都有自己的深色和浅色。默认继续用下面的色相和饱和度。">
        <Surface className="p-3">
          <div data-setting-id="workspace-theme" role="radiogroup" aria-label="配色" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {WORKSPACE_THEMES.map((theme) => {
              const active = appearance.workspaceTheme === theme.id;
              const palette = appearance.scheme === "light" ? theme.light : theme.dark;
              return (
                <button
                  key={theme.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => appearance.setWorkspaceTheme(theme.id)}
                  className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 text-left ${active ? "border-ink-1 bg-fill" : "border-line"}`}
                >
                  <WorkspaceThemeSwatch palette={palette} />
                  <span className={`text-sm ${active ? "text-ink-1" : "text-ink-3"}`}>{theme.id === "default" ? "默认" : theme.label}</span>
                </button>
              );
            })}
          </div>
        </Surface>
      </Section>

      <Section title="颜色">
        <Surface className="px-4 py-4">
          <div data-setting-id="accent">
            <h3 className="text-sm font-medium text-ink-1">强调色</h3>
            <p className="mt-1 text-sm text-ink-3">按钮和你的消息。不选则用当前配色自己的强调色。</p>
            <div role="radiogroup" aria-label="强调色" className="mt-3 flex items-center gap-2.5">
              <button
                type="button"
                role="radio"
                aria-checked={!appearance.accent}
                aria-label="配色默认"
                onClick={() => appearance.setAccent(null)}
                className={`size-5 shrink-0 rounded-full bg-accent ${!appearance.accent ? "ring-2 ring-ink-1 ring-offset-2 ring-offset-background-base" : ""}`}
              />
              {ACCENT_SWATCHES.map((color) => {
                const active = appearance.accent?.toLowerCase() === color;
                return (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={color}
                    onClick={() => appearance.setAccent(color)}
                    className={`size-5 shrink-0 rounded-full ${active ? "ring-2 ring-ink-1 ring-offset-2 ring-offset-background-base" : ""}`}
                    style={{ background: color }}
                  />
                );
              })}
              <button
                type="button"
                aria-label="自定义强调色"
                onClick={() => customRef.current?.click()}
                className={`size-5 shrink-0 rounded-full ${appearance.accent && !ACCENT_SWATCHES.includes(appearance.accent.toLowerCase() as (typeof ACCENT_SWATCHES)[number]) ? "ring-2 ring-ink-1 ring-offset-2 ring-offset-background-base" : ""}`}
                style={{ background: appearance.accent ?? "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #38bdf8, #a78bfa, #f472b6, #f87171)" }}
              />
              <input ref={customRef} type="color" aria-hidden tabIndex={-1} className="size-0 opacity-0" onChange={(event) => appearance.setAccent(event.target.value)} />
            </div>
          </div>

          <div className="my-4 h-px bg-line" />

          <div data-setting-id="hue" className={namedTheme ? "opacity-40" : ""}>
            <h3 className="text-sm font-medium text-ink-1">背景色相</h3>
            <p className="mt-1 text-sm text-ink-3">{namedTheme ? "当前配色自己带颜色，切回默认后这些滑杆才起作用。" : "给中性底色上一层色相。0% 饱和度时看不出来。"}</p>
            <div className="mt-4 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={360}
                value={appearance.hue}
                aria-label="背景色相"
                disabled={namedTheme}
                className="appearance-hue min-w-0 flex-1 disabled:cursor-not-allowed"
                style={{ ["--hue" as string]: String(appearance.hue) }}
                onChange={(event) => pickHue(Number(event.target.value))}
              />
              <span className="w-20 shrink-0 text-right text-sm tabular-nums text-ink-2">
                {hueName(appearance.hue)} {appearance.hue}°
              </span>
            </div>
          </div>

          <div className="my-4 h-px bg-line" />

          <div data-setting-id="saturation" className="flex items-center gap-6">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-ink-1">背景着色</h3>
              <p className="mt-1 text-sm text-ink-3">色相在背景里露出多少。</p>
            </div>
            <Slider
              label="背景着色"
              value={appearance.saturation}
              display={`${appearance.saturation}%`}
              min={0}
              max={100}
              onChange={(value) => appearance.setTint({ saturation: value })}
              disabled={namedTheme}
            />
          </div>

          <div className="my-4 h-px bg-line" />

          <div data-setting-id="dark-lightness" className="flex items-center gap-6">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-ink-1">深色亮度</h3>
              <p className="mt-1 text-sm text-ink-3">{namedTheme ? "由配色决定。" : lightScheme ? "只影响深色模式，你的设置会被保留。" : "越低越暗，0 为纯黑。"}</p>
            </div>
            <Slider
              label="深色亮度"
              value={appearance.darkLightness}
              display={`${appearance.darkLightness}%`}
              min={0}
              max={30}
              onChange={(value) => appearance.setTint({ darkLightness: value })}
              disabled={lightScheme || namedTheme}
            />
          </div>
        </Surface>
      </Section>

      <Section title="差异" description="新增与删除行的颜色。高对比主题已经用了更强的边缘。">
        <Surface className="px-4 py-3">
          <div data-setting-id="diff-colors" className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">Diff 颜色</h3>
              <p className="mt-1 text-sm text-ink-3">色盲友好用蓝橙替代红绿。</p>
            </div>
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
          </div>
        </Surface>
      </Section>

      <Section title="聊天背景" description="只保存在本机。">
        <Surface>
          <div data-setting-id="chat-background" className="p-3">
            <div className="relative flex min-h-[148px] items-center justify-center overflow-hidden rounded-xl bg-fill">
              {appearance.chatBackground ? (
                <>
                  <img src={convertFileSrc(appearance.chatBackground)} alt="聊天背景" className="max-h-[220px] w-full object-cover" />
                  <div className="absolute right-2 top-2 flex gap-1.5">
                    <SecondaryButton onClick={() => void chooseBackground()}>更换</SecondaryButton>
                    <SecondaryButton danger onClick={() => appearance.setChatBackground(null)}>移除</SecondaryButton>
                  </div>
                </>
              ) : (
                <button type="button" onClick={() => void chooseBackground()} className="flex flex-col items-center gap-2 px-6 py-8 text-ink-3 hover:text-ink-2">
                  <ImagePlus className="size-6" strokeWidth={1.5} />
                  <span className="text-sm">选择图片</span>
                </button>
              )}
            </div>
          </div>
          <div data-setting-id="chat-background-opacity" className="flex items-center justify-between gap-6 border-t border-line px-4 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">背景不透明度</h3>
              <p className="mt-1 text-sm text-ink-3">0 为完全不可见。</p>
            </div>
            <Slider
              label="聊天背景不透明度"
              value={Math.round(appearance.chatBackgroundOpacity * 100)}
              display={`${Math.round(appearance.chatBackgroundOpacity * 100)}%`}
              min={0}
              max={100}
              onChange={(value) => appearance.setChatBackgroundOpacity(value / 100)}
            />
          </div>
        </Surface>
      </Section>

      <Section title="布局">
        <Surface className="divide-y divide-line px-4">
          <div data-setting-id="collapsed-rail" className="flex items-center justify-between gap-4 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">收起时的项目栏</h3>
              <p className="mt-1 text-sm text-ink-3">保留为紧凑图标栏，或完全隐藏。</p>
            </div>
            <Segmented<"compact" | "hidden">
              label="Collapsed project rail"
              value={collapsedRailMode}
              options={[
                { value: "compact", label: "图标栏" },
                { value: "hidden", label: "隐藏" },
              ]}
              onChange={setCollapsedRailMode}
            />
          </div>
          <div data-setting-id="ui-scale" className="flex items-center justify-between gap-4 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">界面缩放</h3>
              <p className="mt-1 text-sm text-ink-3">也可用 Ctrl+=、Ctrl+-、Ctrl+0。</p>
            </div>
            <Select
              label="Interface scale"
              value={String(Math.round(appearance.uiScale * 100))}
              options={UI_SCALE_PERCENTS.map((percent) => ({ value: String(percent), label: `${percent}%` }))}
              onChange={(value) => appearance.setUiScale(Number(value) / 100)}
            />
          </div>
          <div data-setting-id="show-excluded-files" className="flex items-center justify-between gap-4 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">显示被忽略的文件</h3>
              <p className="mt-1 text-sm text-ink-3">在资源管理器中显示 Git 忽略的文件与目录。</p>
            </div>
            <Toggle label="Show excluded files" on={appearance.showExcludedFiles} onChange={appearance.setShowExcludedFiles} />
          </div>
        </Surface>
      </Section>
    </>
  );
}

/** The shell, the card inside it and the accent, at the size of a menu icon. */
function WorkspaceThemeSwatch({ palette }: { palette: WorkspacePalette }) {
  return (
    <span
      aria-hidden
      className="relative block size-4 shrink-0 overflow-hidden rounded-[4px] border border-content/15"
      style={{ background: palette.surface }}
    >
      <span className="absolute inset-y-[3px] right-0 left-[5px] rounded-l-[2px]" style={{ background: palette.panelSolid }} />
      <span className="absolute top-[6px] left-[8px] size-[5px] rounded-full" style={{ background: palette.accent }} />
    </span>
  );
}
