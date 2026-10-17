import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { SessionTitleField } from "./SessionTitleField";

// React 19 的 act 需要这个标记，否则只会告警不收敛。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 行内改标题只有一个坑：Enter 提交之后输入框会被卸载，浏览器一定会补一个 blur。
 * 如果不挡，就会用同一个值再提交一次（或者用空值覆盖掉刚写好的标题）。
 */
function mount(value = "旧标题") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls: string[] = [];
  act(() =>
    root.render(
      <SessionTitleField
        value={value}
        onCommit={(name) => calls.push(`commit:${name}`)}
        onCancel={() => calls.push("cancel")}
      />,
    ),
  );
  const input = host.querySelector("input");
  if (!input) throw new Error("input not rendered");
  const type = (next: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (name: string) =>
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    });
  // React 的 onBlur 走的是会冒泡的 focusout，不是不冒泡的 blur。
  const blur = () => act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  return { host, root, input, calls, type, key, blur };
}

test("Enter commits the edited title", () => {
  const t = mount();
  t.type("新标题");
  t.key("Enter");
  expect(t.calls).toEqual(["commit:新标题"]);
  t.root.unmount();
});

test("the blur that follows Enter does not commit twice", () => {
  const t = mount();
  t.type("新标题");
  t.key("Enter");
  t.blur();
  expect(t.calls).toEqual(["commit:新标题"]);
  t.root.unmount();
});

test("Escape cancels, and the blur it causes is not a commit", () => {
  const t = mount();
  t.type("写了一半");
  t.key("Escape");
  t.blur();
  expect(t.calls).toEqual(["cancel"]);
  t.root.unmount();
});

test("losing focus commits what is in the field", () => {
  const t = mount();
  t.type("点了别处");
  t.blur();
  expect(t.calls).toEqual(["commit:点了别处"]);
  t.root.unmount();
});
