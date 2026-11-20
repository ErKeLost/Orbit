import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_THEMES,
  WORKSPACE_THEME_DEFAULT,
  WORKSPACE_THEME_VARIABLE_NAMES,
  applyWorkspaceTheme,
  workspaceThemeVariables,
} from "../src/features/settings/model/workspaceThemes";

describe("workspace themes", () => {
  test("gives every theme a unique id and complete hex palettes", () => {
    const ids = WORKSPACE_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of WORKSPACE_THEMES) {
      for (const palette of [theme.dark, theme.light]) {
        const { syntax, ...shell } = palette;
        for (const color of [...Object.values(shell), ...Object.values(syntax)]) {
          expect(color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  test("sets no variables for the default theme", () => {
    expect(workspaceThemeVariables(WORKSPACE_THEME_DEFAULT)).toEqual({});
  });

  test("applies one theme's variables and clears them on switching back", () => {
    const props = new Map<string, string>();
    const classes = new Set<string>();
    const root = {
      style: {
        setProperty(name: string, value: string) { props.set(name, value); },
        removeProperty(name: string) { props.delete(name); },
        getPropertyValue(name: string) { return props.get(name) ?? ""; },
      },
      classList: {
        toggle(name: string, on: boolean) { if (on) classes.add(name); else classes.delete(name); },
        contains(name: string) { return classes.has(name); },
      },
    };
    applyWorkspaceTheme("ember", root as unknown as HTMLElement);
    expect(root.classList.contains("has-workspace-theme")).toBe(true);
    expect(root.style.getPropertyValue("--wt-dark-surface")).toBe("#120e0c");
    expect(root.style.getPropertyValue("--wt-light-panel-solid")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--wt-dark-syntax-keyword")).toBe("#fe8019");

    applyWorkspaceTheme(WORKSPACE_THEME_DEFAULT, root as unknown as HTMLElement);
    expect(root.classList.contains("has-workspace-theme")).toBe(false);
    for (const name of WORKSPACE_THEME_VARIABLE_NAMES) {
      expect(root.style.getPropertyValue(name)).toBe("");
    }
  });
});
