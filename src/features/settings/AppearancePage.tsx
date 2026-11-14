import { useRef, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ImagePlus } from "../../shared/ui/icons";
import { SecondaryButton, Segmented, Select, Slider, Toggle } from "../../shared/ui/controls";
import { UI_SCALE_PERCENTS, useAppearance, type DiffPalette, type ThemePreference } from "../../lib/appearance";
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

const HUE_DOTS = [252, 285, 330, 15, 35, 70, 145, 175] as const;

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
  const glassUnavailable = appearance.scheme === "light";
  const glassOff = glassUnavailable || !appearance.bodyGlass;
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
    if (appearance.accent) appearance.setAccent(null);
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

      <Section title="颜色">
        <Surface className="px-4 py-4">
          <div data-setting-id="accent">
            <h3 className="text-sm font-medium text-ink-1">强调色</h3>
            <p className="mt-1 text-sm text-ink-3">按钮、链接和你的消息。</p>
            <div data-setting-id="hue" className="mt-4 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={360}
                value={appearance.hue}
                aria-label="色相"
                className="appearance-hue min-w-0 flex-1"
                style={{ ["--hue" as string]: String(appearance.hue) }}
                onChange={(event) => pickHue(Number(event.target.value))}
              />
              <span className="w-20 shrink-0 text-right text-sm tabular-nums text-ink-2">
                {appearance.accent ? "自定义" : `${hueName(appearance.hue)} ${appearance.hue}°`}
              </span>
            </div>
            <div role="radiogroup" aria-label="强调色" className="mt-3 flex items-center gap-2.5">
              {HUE_DOTS.map((hue) => {
                const active = !appearance.accent && Math.abs(appearance.hue - hue) < 8;
                return (
                  <button
                    key={hue}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={hueName(hue)}
                    onClick={() => pickHue(hue)}
                    className={`size-5 shrink-0 rounded-full ${active ? "ring-2 ring-ink-1 ring-offset-2 ring-offset-background-base" : ""}`}
                    style={{ background: `oklch(0.66 0.16 ${hue})` }}
                  />
                );
              })}
              <button
                type="button"
                aria-label="自定义强调色"
                onClick={() => customRef.current?.click()}
                className={`size-5 shrink-0 rounded-full ${appearance.accent ? "ring-2 ring-ink-1 ring-offset-2 ring-offset-background-base" : ""}`}
                style={{ background: appearance.accent ?? "conic-gradient(from 0deg, #f87171, #fbbf24, #34d399, #38bdf8, #a78bfa, #f472b6, #f87171)" }}
              />
              <input ref={customRef} type="color" aria-hidden tabIndex={-1} className="size-0 opacity-0" onChange={(event) => appearance.setAccent(event.target.value)} />
            </div>
          </div>

          <div className="my-4 h-px bg-line" />

          <div data-setting-id="saturation" className="flex items-center gap-6">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-ink-1">背景着色</h3>
              <p className="mt-1 text-sm text-ink-3">强调色在背景里露出多少。</p>
            </div>
            <Slider
              label="背景着色"
              value={appearance.saturation}
              display={`${appearance.saturation}%`}
              min={0}
              max={100}
              onChange={(value) => appearance.setTint({ saturation: value })}
            />
          </div>

          <div className="my-4 h-px bg-line" />

          <div data-setting-id="dark-lightness" className="flex items-center gap-6">
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-ink-1">深色亮度</h3>
              <p className="mt-1 text-sm text-ink-3">{glassUnavailable ? "只影响深色模式，你的设置会被保留。" : "越低越暗，0 为纯黑。"}</p>
            </div>
            <Slider
              label="深色亮度"
              value={appearance.darkLightness}
              display={`${appearance.darkLightness}%`}
              min={0}
              max={30}
              onChange={(value) => appearance.setTint({ darkLightness: value })}
              disabled={glassUnavailable}
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

      <Section
        title="透明度"
        description={glassUnavailable ? "浅色模式始终不透明，深色设置会被保留。" : "窗口玻璃默认关闭。打开后桌面会透过窗口。"}
      >
        <Surface className="divide-y divide-line px-4">
          <div data-setting-id="body-glass" className="flex items-center justify-between gap-4 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">窗口玻璃</h3>
              <p className="mt-1 text-sm text-ink-3">开启后启用下面的不透明度与模糊。</p>
            </div>
            <Toggle label="Window glass" on={appearance.bodyGlass} onChange={appearance.setBodyGlass} disabled={glassUnavailable} />
          </div>
          <div data-setting-id="sidebar-opacity" className="flex items-center justify-between gap-6 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">侧栏不透明度</h3>
              <p className="mt-1 text-sm text-ink-3">项目栏与其他玻璃面板。</p>
            </div>
            <Slider
              label="侧栏不透明度"
              value={Math.round(appearance.sidebarOpacity * 100)}
              display={`${Math.round(appearance.sidebarOpacity * 100)}%`}
              min={15}
              max={100}
              onChange={(value) => appearance.setTint({ sidebarOpacity: value / 100 })}
              disabled={glassOff}
            />
          </div>
          <div data-setting-id="blur" className="flex items-center justify-between gap-6 py-3.5">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink-1">模糊半径</h3>
              <p className="mt-1 text-sm text-ink-3">窗口背后的背景模糊。</p>
            </div>
            <Slider label="模糊半径" value={appearance.blur} display={String(appearance.blur)} min={0} max={60} onChange={appearance.setBlur} disabled={glassOff} />
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
