import { projectColor } from "../../shell/chrome";

/**
 * Orbit has no tab groups; the notes surface only reads these to decorate
 * project marks. Logos/mascots come back empty so the mascot fallback (with
 * Orbit's own project colors) is what renders.
 */

export const TAB_GROUP_LOGOS_CHANGED = "monocode:tab-group-logos-changed";

export function loadTabGroupLogos(): Record<string, string> {
  return {};
}

export function loadTabGroupMascots(): Record<string, string> {
  return {};
}

export function loadTabGroupColors(): Record<string, number> {
  return {};
}

export function loadTabGroupCustomColors(): Record<string, string> {
  return {};
}

export function resolveTabGroupMascot(
  project: string,
  overrides?: Record<string, string>,
): string | null {
  return overrides?.[project] ?? null;
}

export function resolveTabGroupLogo(
  project: string,
  logos?: Record<string, string>,
): string | undefined {
  return logos?.[project];
}

export function resolveTabGroupColor(
  project: string,
  overrides?: Record<string, number>,
  customOverrides?: Record<string, string>,
  fallbackKey?: string,
): string {
  void overrides;
  void customOverrides;
  return projectColor(fallbackKey || project);
}
