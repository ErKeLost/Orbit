import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Modal } from "../../shared/ui/Modal";
import { Select } from "../../shared/ui/controls";
import { LAYER } from "../../shared/lib/layers";

/**
 * A dropdown inside a dialog has to outrank the dialog.
 *
 * Popovers portal to `document.body`, so their layer is compared with the whole
 * app. At the default 80 they were painted *under* a modal (90): an open select
 * showed only the slice that stuck out past the dialog's edge, with the dialog's
 * footer drawn on top of it.
 */
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const options = [{ value: "", label: "未设置" }, { value: "128000", label: "128,000" }];

function dialog(child: React.ReactNode) {
  return (
    <Modal title="编辑 Provider" onClose={() => {}}>
      {child}
    </Modal>
  );
}

function picker(onChange: (value: string) => void = () => {}) {
  return <Select label="回退上下文长度" value="" options={options} onChange={onChange} />;
}

async function openSelect(container: ParentNode) {
  const trigger = Array.from(container.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "回退上下文长度")
    ?? Array.from(document.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "回退上下文长度");
  expect(trigger).toBeTruthy();
  await act(async () => trigger!.click());
  return document.querySelector<HTMLElement>("[data-dialog-popover]");
}

test("a select opened inside a dialog is layered above the dialog", async () => {
  await act(async () => root.render(dialog(picker())));
  const frame = await openSelect(host);
  expect(frame).toBeTruthy();
  expect(frame!.style.zIndex).toBe(String(LAYER.dialogPopover));
  expect(Number(frame!.style.zIndex)).toBeGreaterThan(LAYER.dialog);
});

test("the dialog's own Escape handling leaves an open menu's Escape alone", async () => {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <Modal title="编辑 Provider" onClose={onClose}>
        {picker()}
      </Modal>,
    ),
  );
  const surface = await openSelect(host);
  expect(surface).toBeTruthy();
  // The marker is what `ModalPanel` checks before closing the dialog.
  expect(surface!.closest("[data-dialog-popover]")).toBe(surface);
  await act(async () => {
    (surface as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(onClose).not.toHaveBeenCalled();
});

test("a select outside any dialog keeps the ordinary popover layer", async () => {
  await act(async () => root.render(picker()));
  const trigger = Array.from(host.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "回退上下文长度")
    ?? Array.from(document.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "回退上下文长度");
  await act(async () => trigger!.click());
  const frames = Array.from(document.body.querySelectorAll<HTMLElement>("[data-popover-side]"));
  const frame = frames.find((element) => element.style.position === "fixed" && element.style.zIndex);
  expect(frame?.style.zIndex).toBe(String(LAYER.popover));
  expect(document.querySelector("[data-dialog-popover]")).toBeNull();
});
