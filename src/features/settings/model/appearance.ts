/**
 * Changes view 偏好：源码管理面板读的列表/树视图选择。
 *
 * 真正的主题偏好不在这里——它归 `lib/appearance`（`orbit.colorScheme`）。
 */

export type ChangesView = "list" | "tree";

export const CHANGES_VIEW_DEFAULT: ChangesView = "list";

const CHANGES_VIEW_KEY = "orbit.changesView";

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
