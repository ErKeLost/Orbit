/**
 * Appearance prefs the source-control surface reads (MonoCode's
 * settings/model/appearance, trimmed to what is ported so far).
 */

export type ColorScheme = "dark" | "light";
export type ThemePreference = ColorScheme | "system";

export type ChangesView = "list" | "tree";

export const CHANGES_VIEW_DEFAULT: ChangesView = "list";

const CHANGES_VIEW_KEY = "orbit.changesView";
const THEME_KEY = "orbit.theme";

function isChangesView(value: string | null | undefined): value is ChangesView {
  return value === "list" || value === "tree";
}

export function loadChangesView(): ChangesView {
  try {
    const raw = localStorage.getItem(CHANGES_VIEW_KEY);
    return isChangesView(raw) ? raw : CHANGES_VIEW_DEFAULT;
  } catch {
    return CHANGES_VIEW_DEFAULT;
  }
}

export function saveChangesView(value: ChangesView) {
  try {
    localStorage.setItem(CHANGES_VIEW_KEY, value);
  } catch {
    // private mode / quota
  }
}

export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    return "system";
  }
}

export function systemColorScheme(): ColorScheme {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

export function resolveColorScheme(value: ThemePreference): ColorScheme {
  return value === "system" ? systemColorScheme() : value;
}

/** Fired on `window` whenever the color scheme flips (detail: ColorScheme). */
export const SCHEME_CHANGE_EVENT = "orbit:color-scheme-changed";
