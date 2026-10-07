import { describe, expect, test } from "bun:test";
import { isResolvedTheme, nativeThemePreference, themeColor } from "../src/lib/theme";

describe("theme synchronization", () => {
  test("preserves system preference for native window chrome", () => {
    expect(nativeThemePreference("system")).toBeNull();
    expect(nativeThemePreference(undefined)).toBeNull();
    expect(nativeThemePreference("light")).toBe("light");
    expect(nativeThemePreference("dark")).toBe("dark");
  });

  test("only accepts resolved themes and provides matching browser chrome colors", () => {
    expect(isResolvedTheme("light")).toBe(true);
    expect(isResolvedTheme("dark")).toBe(true);
    expect(isResolvedTheme("system")).toBe(false);
    expect(themeColor.light).toBe("#f7f7f7");
    expect(themeColor.dark).toBe("#171717");
  });
});
