/**
 * Raw platform role -> closed role class.
 *
 * Cua Driver publishes each platform's native role string unchanged
 * (`AXTextField` on macOS, `Edit` on Windows, `entry` on Linux), so the runner
 * owns this mapping. Unknown roles are excluded, never guessed.
 */
export type RoleClass =
  | "button"
  | "link"
  | "text_entry"
  | "combo_box"
  | "checkbox"
  | "radio"
  | "menu_item"
  | "menu"
  | "tab"
  | "row"
  | "list"
  | "scroll_area"
  | "image"
  | "text"
  | "window"
  | "group"
  | "slider"
  | "unknown"

const TABLE: Record<string, RoleClass> = {
  // macOS AX
  axbutton: "button",
  axlink: "link",
  axtextfield: "text_entry",
  axsecuretextfield: "text_entry",
  axtextarea: "text_entry",
  axsearchfield: "text_entry",
  axcombobox: "combo_box",
  axpopupbutton: "combo_box",
  axcheckbox: "checkbox",
  axradiobutton: "radio",
  axmenuitem: "menu_item",
  axmenubaritem: "menu_item",
  axmenu: "menu",
  axmenubar: "menu",
  axradioGroup: "group",
  axradiogroup: "group",
  axtabgroup: "tab",
  axrow: "row",
  axtable: "list",
  axoutline: "list",
  axlist: "list",
  axscrollarea: "scroll_area",
  aximage: "image",
  axstatictext: "text",
  axheading: "text",
  axwindow: "window",
  axgroup: "group",
  axwebarea: "group",
  axslider: "slider",
  // Windows UIA
  button: "button",
  hyperlink: "link",
  edit: "text_entry",
  combobox: "combo_box",
  checkbox: "checkbox",
  radiobutton: "radio",
  menuitem: "menu_item",
  menu: "menu",
  tabitem: "tab",
  dataitem: "row",
  list: "list",
  listitem: "row",
  document: "group",
  text: "text",
  pane: "group",
  window: "window",
  // Linux AT-SPI
  pushbutton: "button",
  togglebutton: "button",
  entry: "text_entry",
  passwordtext: "text_entry",
  "combo box": "combo_box",
  "check box": "checkbox",
  "radio button": "radio",
  "menu item": "menu_item",
  "page tab": "tab",
  "table row": "row",
  "scroll pane": "scroll_area",
  "text field": "text_entry",
}

function normalize(role: string): string {
  return role
    .trim()
    .toLowerCase()
    .replace(/^ax(?=[a-z])/, "")
    .replace(/[\s_-]+/g, " ")
}

const NORMALIZED: Record<string, RoleClass> = Object.fromEntries(
  Object.entries(TABLE).map(([key, value]) => [normalize(key).replace(/ /g, ""), value]),
)

/** Role class, or `unknown` when the platform role is not recognised. */
export function roleClass(role: string): RoleClass {
  const key = normalize(role).replace(/ /g, "")
  return NORMALIZED[key] ?? "unknown"
}

export function isTextRole(value: RoleClass): boolean {
  return value === "text_entry" || value === "combo_box"
}

export function isActionable(value: RoleClass): boolean {
  return value === "button" || value === "link" || value === "tab" || value === "row" || value === "checkbox" || value === "radio" || value === "slider"
}

/** macOS reports AX actions; Windows and Linux report their own names. */
export function hasPress(actions: readonly string[]): boolean {
  return actions.some(action => /^(axpress|press|click|invoke|activate|select|open)$/i.test(action))
}

export function hasShowMenu(actions: readonly string[]): boolean {
  return actions.some(action => /^(axshowmenu|show_menu|showmenu|contextmenu|expandcollap|expand)$/i.test(action))
}

export function hasPick(actions: readonly string[]): boolean {
  return actions.some(action => /^(axpick|pick)$/i.test(action))
}
