import { createContext } from "react";
import { LAYER } from "../lib/layers";

/**
 * How much a popover has to move up because it was opened inside a surface that
 * already outranks it.
 *
 * A `Popover` portals itself to `document.body`, which means its layer is
 * compared with the whole app rather than with its own pane. That is right for a
 * menu hanging off the chrome (`LAYER.popover`, 80) and wrong for a menu opened
 * from a control *inside* a dialog: the dialog sits at 90, so the menu was
 * painted underneath it — an open select that looked clipped, with only the part
 * sticking out past the dialog's bottom edge visible, and a footer drawn over
 * it.
 *
 * The surface that raises the bar owns that fact, so it publishes the offset
 * here instead of every call site remembering to pass `layer`. Popover adds it,
 * which keeps the relationship (a flyout above its parent menu) intact at any
 * depth.
 */
export const PopoverLayerOffset = createContext(0);

/** Enough to clear a dialog and stay below toasts: 80 → 91, submenu 81 → 92. */
export const DIALOG_POPOVER_OFFSET = LAYER.dialogPopover - LAYER.popover;
