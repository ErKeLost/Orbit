import { create } from "zustand";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { nativeThemePreference, themeColor, type ResolvedTheme } from "./theme";
import {
  applyWorkspaceTheme,
  isWorkspaceThemeId,
  WORKSPACE_THEME_DEFAULT,
  type WorkspaceThemeId,
} from "../features/settings/model/workspaceThemes";

/**
 * MonoCode's appearance model: one hue, one saturation, one dark lightness,
 * and a light class. Named themes write `--wt-*` and the stylesheet overrides
 * the roles; default leaves the HSL tint in charge.
 */
export type ThemePreference = "system" | "light" | "dark";

const SCHEME_KEY = "orbit.colorScheme";
const LEGACY_SCHEME_KEY = "pi-gui.theme";
const ACCENT_KEY = "orbit.accentColor";
const UI_SCALE_KEY = "orbit.uiScale";
const EXCLUDED_KEY = "orbit.showExcludedFiles";
const CHAT_BG_KEY = "orbit.chatBackground";
const CHAT_BG_OPACITY_KEY = "orbit.chatBackgroundOpacity";
const DIFF_KEY = "orbit.diffPalette";
const HUE_KEY = "orbit.themeHue";
const SATURATION_KEY = "orbit.themeSaturation";
const LIGHTNESS_KEY = "orbit.themeDarkLightness";
const WORKSPACE_THEME_KEY = "orbit.workspaceTheme";

/** MonoCode's neutral default: hue 240, saturation 0%, dark lightness 9%. */
export const DEFAULT_APPEARANCE = { hue: 240, saturation: 0, darkLightness: 9 };

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

type AppearanceState = {
  preference: ThemePreference;
  scheme: ResolvedTheme;
  hue: number;
  saturation: number;
  darkLightness: number;
  workspaceTheme: WorkspaceThemeId;
  /** Null = the theme's own accent (`hsl(211 92% 62%)`, or the workspace theme's). */
  accent: string | null;
  diffPalette: DiffPalette;
  uiScale: number;
  showExcludedFiles: boolean;
  chatBackground: string | null;
  /** 0–1，作用于聊天背景图片的透明度。 */
  chatBackgroundOpacity: number;
  setUiScale: (scale: number) => void;
  setShowExcludedFiles: (on: boolean) => void;
  setChatBackground: (path: string | null) => void;
  setChatBackgroundOpacity: (opacity: number) => void;
  setPreference: (preference: ThemePreference) => void;
  setTint: (patch: Partial<Pick<AppearanceState, "hue" | "saturation" | "darkLightness">>) => void;
  setWorkspaceTheme: (theme: WorkspaceThemeId) => void;
  setAccent: (accent: string | null) => void;
  setDiffPalette: (palette: DiffPalette) => void;
  restoreDefaults: () => void;
};

function applyToDocument(state: Pick<AppearanceState, "scheme" | "hue" | "saturation" | "darkLightness" | "workspaceTheme" | "accent" | "diffPalette">) {
  const root = document.documentElement;
  applyWorkspaceTheme(state.workspaceTheme, root);
  if (state.accent) {
    root.classList.add("has-user-accent");
    root.style.setProperty("--user-accent-color", state.accent);
    root.style.setProperty("--user-accent-foreground", accentForeground(state.accent));
    // 强调色接管 --color-accent：Working 状态、加载图标、焦点环这些原来固定
    // 蓝色的 UI 全部跟着主题强调色走，而不是只有气泡和发送按钮。
    root.style.setProperty("--color-accent", state.accent);
    root.style.setProperty("--accent", state.accent);
    root.style.setProperty("--color-accent-foreground", accentForeground(state.accent));
  } else {
    root.classList.remove("has-user-accent");
    root.style.removeProperty("--user-accent-color");
    root.style.removeProperty("--user-accent-foreground");
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--accent");
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
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColor[state.scheme]);
}

const initialPreference = loadThemePreference();

/**
 * The previous OKLCH ramp wrote its own default into localStorage. Those three
 * numbers together are not a choice the user made; a customised value stays.
 */
const LEGACY_DEFAULT_TINTS = [
  { hue: 255, saturation: 16, darkLightness: 8 },
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
  if (!isLegacyDefault) return tint;
  write(HUE_KEY, String(DEFAULT_APPEARANCE.hue));
  write(SATURATION_KEY, String(DEFAULT_APPEARANCE.saturation));
  write(LIGHTNESS_KEY, String(DEFAULT_APPEARANCE.darkLightness));
  return {
    hue: DEFAULT_APPEARANCE.hue,
    saturation: DEFAULT_APPEARANCE.saturation,
    darkLightness: DEFAULT_APPEARANCE.darkLightness,
  };
}

function initialWorkspaceTheme(): WorkspaceThemeId {
  return isWorkspaceThemeId(read(WORKSPACE_THEME_KEY)) ? read(WORKSPACE_THEME_KEY) as WorkspaceThemeId : WORKSPACE_THEME_DEFAULT;
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  preference: initialPreference,
  scheme: resolveColorScheme(initialPreference),
  ...initialTint(),
  workspaceTheme: initialWorkspaceTheme(),
  accent: readAccent(),
  diffPalette: readDiffPalette(),
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
    set(patch);
  },
  setWorkspaceTheme: workspaceTheme => {
    write(WORKSPACE_THEME_KEY, workspaceTheme === WORKSPACE_THEME_DEFAULT ? null : workspaceTheme);
    set({ workspaceTheme });
  },
  setAccent: accent => {
    write(ACCENT_KEY, accent);
    set({ accent });
  },
  setDiffPalette: diffPalette => {
    write(DIFF_KEY, diffPalette);
    set({ diffPalette });
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
    for (const key of [HUE_KEY, SATURATION_KEY, LIGHTNESS_KEY, WORKSPACE_THEME_KEY, ACCENT_KEY, DIFF_KEY, UI_SCALE_KEY, EXCLUDED_KEY, CHAT_BG_KEY, CHAT_BG_OPACITY_KEY]) write(key, null);
    set({ ...DEFAULT_APPEARANCE, workspaceTheme: WORKSPACE_THEME_DEFAULT, accent: null, diffPalette: "default" as DiffPalette, uiScale: 1, showExcludedFiles: false, chatBackground: null, chatBackgroundOpacity: 0.22 });
  },
}));

let installed = false;

/** Applies the store to <html> and follows the OS while preference is "system". */
export function installAppearance(nativeSync: () => boolean) {
  if (installed) return;
  installed = true;
  // Window glass is gone. Drop the keys so an old install does not keep a dead toggle.
  for (const key of ["orbit.blurRadius", "orbit.bodyGlass", "orbit.sidebarOpacity"]) write(key, null);
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
