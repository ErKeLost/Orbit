export type ResolvedTheme = "light" | "dark";

/** Window chrome, equal to MonoCode's default HSL: 97% light, 9% dark. */
export const themeColor: Record<ResolvedTheme, string> = {
  light: "#f7f7f7",
  dark: "#171717",
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
