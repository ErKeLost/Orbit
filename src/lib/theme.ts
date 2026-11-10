export type ResolvedTheme = "light" | "dark";

/** Window chrome color, kept equal to `--color-surface` for the default tint. */
export const themeColor: Record<ResolvedTheme, string> = {
  light: "#f5f5f7",
  dark: "#121317",
};

/**
 * Tauri accepts `null` to follow the operating system. Keeping that intent
 * intact lets native title bars and menus update when the OS theme changes.
 */
export function nativeThemePreference(preference: string | undefined): ResolvedTheme | null {
  return preference === "light" || preference === "dark" ? preference : null;
}

export function isResolvedTheme(value: string | undefined): value is ResolvedTheme {
  return value === "light" || value === "dark";
}
