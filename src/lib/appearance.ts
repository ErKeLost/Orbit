import { create } from "zustand";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { nativeThemePreference, themeColor, type ResolvedTheme } from "./theme";
import { isLowPerf } from "./perf-tier";
import { isDegraded, onPerfDegrade } from "./perf-monitor";

/**
 * Orbit's appearance model, ported: one hue, one saturation, one dark
 * lightness, and a light class. Every surface color in `styles/orbit-theme.css`
 * derives from these, so a theme change is four variables, not a stylesheet.
 */
export type ThemePreference = "system" | "light" | "dark";

const SCHEME_KEY = "orbit.colorScheme";
const LEGACY_SCHEME_KEY = "pi-gui.theme";
const ACCENT_KEY = "orbit.accentColor";
const BLUR_KEY = "orbit.blurRadius";
const BODY_GLASS_KEY = "orbit.bodyGlass";
const UI_SCALE_KEY = "orbit.uiScale";
const EXCLUDED_KEY = "orbit.showExcludedFiles";
const CHAT_BG_KEY = "orbit.chatBackground";
const CHAT_BG_OPACITY_KEY = "orbit.chatBackgroundOpacity";
const DIFF_KEY = "orbit.diffPalette";
const HUE_KEY = "orbit.themeHue";
const SATURATION_KEY = "orbit.themeSaturation";
const LIGHTNESS_KEY = "orbit.themeDarkLightness";
const SIDEBAR_OPACITY_KEY = "orbit.sidebarOpacity";

/**
 * 墨蓝色调：色相 226、饱和度 14%、底色亮度 8%。三个值一起决定整条中性色阶
 * （见 styles/orbit-theme.css 的 @theme static），不是只给页面刷一层蓝。
 */
export const DEFAULT_APPEARANCE = { hue: 255, saturation: 16, darkLightness: 8, sidebarOpacity: 0.85 };

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

export function loadThemePreference(): ThemePreference {
  const raw = read(SCHEME_KEY) ?? read(LEGACY_SCHEME_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

const systemQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: light)")
  : null;

export function resolveColorScheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return systemQuery?.matches ? "light" : "dark";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function loadNumber(key: string, fallback: number) {
  const raw = read(key);
  const value = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export type DiffPalette = "default" | "colorblind" | "high-contrast";

function readAccent() {
  const raw = read(ACCENT_KEY);
  return raw && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null;
}

function readDiffPalette(): DiffPalette {
  const raw = read(DIFF_KEY);
  return raw === "colorblind" || raw === "high-contrast" ? raw : "default";
}

/**
 * Text on an accent background, picked from the accent's own luminance instead
 * of always white. A fill at 66% lightness (`#6187ef`, the cobalt default) can
 * never carry white text at 4.5:1; near-black ink gives it 5.5:1, while a dark
 * user accent (`#ef4444`) keeps white.
 */
function accentForeground(color: string) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!match) return "#ffffff";
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.35 ? "#0b0d13" : "#ffffff";
}

export const UI_SCALE_PERCENTS = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.1) * 100));

function readBlur() {
  return clamp(loadNumber(BLUR_KEY, 24), 1, 64);
}

function readBodyGlass() {
  // 默认关闭：窗口玻璃要求窗口非不透明，macOS 合成器每帧都要和桌面混合，
  // 这是「整台电脑跟着卡」的结构性成本。需要时在设置里打开，外观与以前一样。
  return read(BODY_GLASS_KEY) === "true";
}

type AppearanceState = {
  preference: ThemePreference;
  scheme: ResolvedTheme;
  hue: number;
  saturation: number;
  darkLightness: number;
  sidebarOpacity: number;
  /** Null = the theme's own accent (Orbit's first swatch). */
  accent: string | null;
  diffPalette: DiffPalette;
  blur: number;
  bodyGlass: boolean;
  uiScale: number;
  showExcludedFiles: boolean;
  chatBackground: string | null;
  /** 0–1，作用于聊天背景图片的透明度。 */
  chatBackgroundOpacity: number;
  setBlur: (blur: number) => void;
  setBodyGlass: (on: boolean) => void;
  setUiScale: (scale: number) => void;
  setShowExcludedFiles: (on: boolean) => void;
  setChatBackground: (path: string | null) => void;
  setChatBackgroundOpacity: (opacity: number) => void;
  setPreference: (preference: ThemePreference) => void;
  setTint: (patch: Partial<Pick<AppearanceState, "hue" | "saturation" | "darkLightness" | "sidebarOpacity">>) => void;
  setAccent: (accent: string | null) => void;
  setDiffPalette: (palette: DiffPalette) => void;
  restoreDefaults: () => void;
};

/** macOS native vibrancy, the same path Orbit uses (has-native-glass). */
async function applyNativeGlass(state: Pick<AppearanceState, "scheme" | "blur" | "bodyGlass" | "sidebarOpacity">) {
  const root = document.documentElement;
  // 低配档不挂原生活体模糊：带 vibrancy 的窗口必须是非不透明窗口，合成器要把
  // 每一帧的内容和背后的桌面混合一次（Electron 版 t3code 用的就是不透明窗口）。
  // 运行时自动降级（perf-monitor 量到持续低帧率）也一样撤掉。
  // 而且默认就是关闭的：`bodyGlass` 是「窗口玻璃」的总开关，只有打开它才会挂
  // vibrancy / 让侧栏半透明。
  const eligible = state.scheme === "dark" && IS_MAC_RUNTIME && !isLowPerf && !isDegraded() && state.bodyGlass;
  root.classList.toggle("has-native-glass", eligible);
  root.classList.toggle("glass-body", eligible);
  root.style.setProperty("--sidebar-blur", `${state.blur}px`);
  if (!eligible) {
    // 从深色切到浅色（或降级）时把已经挂上的 effect 撤掉，否则窗口会一直带着
    // 一层没人看得见、但一直在算的模糊。
    if (!glassApplied) return;
    glassApplied = false;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setEffects({ effects: [] });
    } catch { /* 没有 effect API（非 macOS / 旧版） */ }
    return;
  }
  try {
    const { getCurrentWindow, Effect, EffectState } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setEffects({
      effects: [Effect.Sidebar],
      state: EffectState.FollowsWindowActiveState,
      radius: state.blur,
    });
    glassApplied = true;
  } catch {
    root.classList.remove("has-native-glass", "glass-body");
  }
}

const IS_MAC_RUNTIME = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** 窗口上是否真的挂着 vibrancy，撤掉时不必再发一次 IPC。 */
let glassApplied = false;

/**
 * 量到持续低帧率时立刻把 vibrancy 撤掉，不等下一次主题变化。
 *
 * 整窗活体模糊是「整个电脑跟着卡」的结构性成本：窗口必须非不透明，合成器每帧
 * 都要和桌面混合。装饰动画一停，这条混合链上的重算频率也跟着降下来。
 */
let degradeHooked = false;
function hookPerfDegrade() {
  if (degradeHooked || typeof window === "undefined") return;
  degradeHooked = true;
  onPerfDegrade(() => {
    document.documentElement.classList.remove("has-native-glass", "glass-body");
    if (!glassApplied) return;
    glassApplied = false;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        await getCurrentWindow().setEffects({ effects: [] });
      })
      .catch(() => {
        /* 没有 effect API（非 macOS / 旧版） */
      });
  });
}
hookPerfDegrade();

function applyToDocument(state: Pick<AppearanceState, "scheme" | "hue" | "saturation" | "darkLightness" | "sidebarOpacity" | "accent" | "diffPalette" | "blur" | "bodyGlass">) {
  const root = document.documentElement;
  void applyNativeGlass(state);
  if (state.accent) {
    root.classList.add("has-user-accent");
    root.style.setProperty("--user-accent-color", state.accent);
    root.style.setProperty("--user-accent-foreground", accentForeground(state.accent));
    // 强调色接管 --color-accent：Working 状态、加载图标、焦点环这些原来固定
    // 蓝色的 UI 全部跟着主题强调色走，而不是只有气泡和发送按钮。
    root.style.setProperty("--color-accent", state.accent);
    root.style.setProperty("--color-accent-foreground", accentForeground(state.accent));
  } else {
    root.classList.remove("has-user-accent");
    root.style.removeProperty("--user-accent-color");
    root.style.removeProperty("--user-accent-foreground");
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-foreground");
  }
  root.classList.toggle("diff-palette-colorblind", state.diffPalette === "colorblind");
  root.classList.toggle("diff-palette-high-contrast", state.diffPalette === "high-contrast");
  root.classList.toggle("theme-light", state.scheme === "light");
  // Older Orbit surfaces (and third-party widgets) still key off `.dark`.
  root.classList.toggle("dark", state.scheme === "dark");
  root.dataset.theme = state.scheme;
  root.style.colorScheme = state.scheme;
  root.style.setProperty("--theme-hue", String(state.hue));
  root.style.setProperty("--theme-saturation", `${state.saturation}%`);
  root.style.setProperty("--theme-dark-lightness", `${state.darkLightness}%`);
  // The token ramp does its math in OKLCH, where chroma and lightness are
  // numbers, not percentages. Publish the raw values next to the display ones.
  root.style.setProperty("--theme-saturation-unit", String(state.saturation));
  root.style.setProperty("--theme-lightness-unit", String(state.darkLightness));
  root.style.setProperty("--sidebar-opacity", String(state.sidebarOpacity));
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColor[state.scheme]);
}

const initialPreference = loadThemePreference();

/**
 * Orbit 原样的默认色板（中性灰 + 240 色相）。它不是用户挑过的值，而是升级前写进
 * localStorage 的初始值；换 token 后如果继续沿用，新色板在别人的机器上永远看不到。
 * 三个值全中才算旧默认，用户自己调过的任何一个都不动。
 */
const LEGACY_DEFAULT_TINTS = [
  { hue: 240, saturation: 0, darkLightness: 9 },
  { hue: 226, saturation: 14, darkLightness: 8 },
];

function initialTint() {
  const tint = {
    hue: clamp(loadNumber(HUE_KEY, DEFAULT_APPEARANCE.hue), 0, 360),
    saturation: clamp(loadNumber(SATURATION_KEY, DEFAULT_APPEARANCE.saturation), 0, 100),
    darkLightness: clamp(loadNumber(LIGHTNESS_KEY, DEFAULT_APPEARANCE.darkLightness), 0, 30),
  };
  const isLegacyDefault = LEGACY_DEFAULT_TINTS.some(
    (legacy) =>
      tint.hue === legacy.hue &&
      tint.saturation === legacy.saturation &&
      tint.darkLightness === legacy.darkLightness,
  );
  return isLegacyDefault
    ? { hue: DEFAULT_APPEARANCE.hue, saturation: DEFAULT_APPEARANCE.saturation, darkLightness: DEFAULT_APPEARANCE.darkLightness }
    : tint;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  preference: initialPreference,
  scheme: resolveColorScheme(initialPreference),
  ...initialTint(),
  sidebarOpacity: clamp(loadNumber(SIDEBAR_OPACITY_KEY, DEFAULT_APPEARANCE.sidebarOpacity), 0.15, 1),
  accent: readAccent(),
  diffPalette: readDiffPalette(),
  blur: readBlur(),
  bodyGlass: readBodyGlass(),
  uiScale: clamp(loadNumber(UI_SCALE_KEY, 1), 0.5, 2),
  showExcludedFiles: read(EXCLUDED_KEY) === "true",
  chatBackground: read(CHAT_BG_KEY),
  chatBackgroundOpacity: clamp(loadNumber(CHAT_BG_OPACITY_KEY, 0.22), 0, 1),
  setPreference: preference => {
    write(SCHEME_KEY, preference);
    write(LEGACY_SCHEME_KEY, preference);
    set({ preference, scheme: resolveColorScheme(preference) });
  },
  setTint: patch => {
    const next = { ...get(), ...patch };
    write(HUE_KEY, String(next.hue));
    write(SATURATION_KEY, String(next.saturation));
    write(LIGHTNESS_KEY, String(next.darkLightness));
    write(SIDEBAR_OPACITY_KEY, String(next.sidebarOpacity));
    set(patch);
  },
  setAccent: accent => {
    write(ACCENT_KEY, accent);
    set({ accent });
  },
  setDiffPalette: diffPalette => {
    write(DIFF_KEY, diffPalette);
    set({ diffPalette });
  },
  setBlur: blur => {
    write(BLUR_KEY, String(blur));
    set({ blur });
  },
  setBodyGlass: bodyGlass => {
    write(BODY_GLASS_KEY, String(bodyGlass));
    set({ bodyGlass });
  },
  setUiScale: uiScale => {
    write(UI_SCALE_KEY, String(uiScale));
    set({ uiScale });
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(uiScale))
      .catch(() => document.documentElement.style.setProperty("zoom", String(uiScale)));
  },
  setShowExcludedFiles: showExcludedFiles => {
    write(EXCLUDED_KEY, String(showExcludedFiles));
    set({ showExcludedFiles });
  },
  setChatBackground: chatBackground => {
    write(CHAT_BG_KEY, chatBackground);
    set({ chatBackground });
  },
  setChatBackgroundOpacity: chatBackgroundOpacity => {
    write(CHAT_BG_OPACITY_KEY, String(chatBackgroundOpacity));
    set({ chatBackgroundOpacity });
  },
  restoreDefaults: () => {
    for (const key of [HUE_KEY, SATURATION_KEY, LIGHTNESS_KEY, SIDEBAR_OPACITY_KEY, ACCENT_KEY, DIFF_KEY, BLUR_KEY, BODY_GLASS_KEY, UI_SCALE_KEY, EXCLUDED_KEY, CHAT_BG_KEY, CHAT_BG_OPACITY_KEY]) write(key, null);
    set({ ...DEFAULT_APPEARANCE, accent: null, diffPalette: "default" as DiffPalette, blur: 24, bodyGlass: false, uiScale: 1, showExcludedFiles: false, chatBackground: null, chatBackgroundOpacity: 0.22 });
  },
}));

let installed = false;

/** Applies the store to <html> and follows the OS while preference is "system". */
export function installAppearance(nativeSync: () => boolean) {
  if (installed) return;
  installed = true;
  const sync = () => {
    const state = useAppearance.getState();
    applyToDocument(state);
    if (nativeSync()) {
      void setNativeTheme(nativeThemePreference(state.preference)).catch(() => undefined);
    }
  };
  sync();
  const scale = useAppearance.getState().uiScale;
  if (scale !== 1) void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(scale)).catch(() => undefined);
  useAppearance.subscribe(sync);
  systemQuery?.addEventListener("change", () => {
    const { preference } = useAppearance.getState();
    if (preference === "system") useAppearance.setState({ scheme: resolveColorScheme("system") });
  });
}

export function useColorScheme(): ResolvedTheme {
  return useAppearance(state => state.scheme);
}
