import { create } from "zustand";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { nativeThemePreference, themeColor, type ResolvedTheme } from "./theme";

/**
 * MonoCode's appearance model, ported: one hue, one saturation, one dark
 * lightness, and a light class. Every surface color in `styles/monocode.css`
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
const DIFF_KEY = "orbit.diffPalette";
const HUE_KEY = "orbit.themeHue";
const SATURATION_KEY = "orbit.themeSaturation";
const LIGHTNESS_KEY = "orbit.themeDarkLightness";
const SIDEBAR_OPACITY_KEY = "orbit.sidebarOpacity";

export const DEFAULT_APPEARANCE = { hue: 240, saturation: 0, darkLightness: 9, sidebarOpacity: 0.85 };

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

/** Readable text on an accent background. */
function accentForeground(color: string) {
  const value = Number.parseInt(color.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#171717" : "#ffffff";
}

export const UI_SCALE_PERCENTS = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.1) * 100));

function readBlur() {
  return clamp(loadNumber(BLUR_KEY, 24), 1, 64);
}

function readBodyGlass() {
  return (read(BODY_GLASS_KEY) ?? "true") !== "false";
}

type AppearanceState = {
  preference: ThemePreference;
  scheme: ResolvedTheme;
  hue: number;
  saturation: number;
  darkLightness: number;
  sidebarOpacity: number;
  /** Null = the theme's own accent (MonoCode's first swatch). */
  accent: string | null;
  diffPalette: DiffPalette;
  blur: number;
  bodyGlass: boolean;
  uiScale: number;
  showExcludedFiles: boolean;
  chatBackground: string | null;
  setBlur: (blur: number) => void;
  setBodyGlass: (on: boolean) => void;
  setUiScale: (scale: number) => void;
  setShowExcludedFiles: (on: boolean) => void;
  setChatBackground: (path: string | null) => void;
  setPreference: (preference: ThemePreference) => void;
  setTint: (patch: Partial<Pick<AppearanceState, "hue" | "saturation" | "darkLightness" | "sidebarOpacity">>) => void;
  setAccent: (accent: string | null) => void;
  setDiffPalette: (palette: DiffPalette) => void;
  restoreDefaults: () => void;
};

/** macOS native vibrancy, the same path MonoCode uses (has-native-glass). */
async function applyNativeGlass(state: Pick<AppearanceState, "scheme" | "blur" | "bodyGlass" | "sidebarOpacity">) {
  const root = document.documentElement;
  const eligible = state.scheme === "dark" && IS_MAC_RUNTIME;
  root.classList.toggle("has-native-glass", eligible);
  root.classList.toggle("glass-body", eligible && state.bodyGlass);
  root.style.setProperty("--sidebar-blur", `${state.blur}px`);
  if (!eligible) return;
  try {
    const { getCurrentWindow, Effect, EffectState } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setEffects({
      effects: [Effect.Sidebar],
      state: EffectState.FollowsWindowActiveState,
      radius: state.blur,
    });
  } catch {
    root.classList.remove("has-native-glass", "glass-body");
  }
}

const IS_MAC_RUNTIME = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

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
  root.style.setProperty("--sidebar-opacity", String(state.sidebarOpacity));
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColor[state.scheme]);
}

const initialPreference = loadThemePreference();

export const useAppearance = create<AppearanceState>((set, get) => ({
  preference: initialPreference,
  scheme: resolveColorScheme(initialPreference),
  hue: clamp(loadNumber(HUE_KEY, DEFAULT_APPEARANCE.hue), 0, 360),
  saturation: clamp(loadNumber(SATURATION_KEY, DEFAULT_APPEARANCE.saturation), 0, 100),
  darkLightness: clamp(loadNumber(LIGHTNESS_KEY, DEFAULT_APPEARANCE.darkLightness), 0, 30),
  sidebarOpacity: clamp(loadNumber(SIDEBAR_OPACITY_KEY, DEFAULT_APPEARANCE.sidebarOpacity), 0.15, 1),
  accent: readAccent(),
  diffPalette: readDiffPalette(),
  blur: readBlur(),
  bodyGlass: readBodyGlass(),
  uiScale: clamp(loadNumber(UI_SCALE_KEY, 1), 0.5, 2),
  showExcludedFiles: read(EXCLUDED_KEY) === "true",
  chatBackground: read(CHAT_BG_KEY),
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
  restoreDefaults: () => {
    for (const key of [HUE_KEY, SATURATION_KEY, LIGHTNESS_KEY, SIDEBAR_OPACITY_KEY, ACCENT_KEY, DIFF_KEY, BLUR_KEY, BODY_GLASS_KEY, UI_SCALE_KEY, EXCLUDED_KEY, CHAT_BG_KEY]) write(key, null);
    set({ ...DEFAULT_APPEARANCE, accent: null, diffPalette: "default" as DiffPalette, blur: 24, bodyGlass: true, uiScale: 1, showExcludedFiles: false, chatBackground: null });
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
