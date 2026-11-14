import { describe, expect, test } from "bun:test";
import { COMPOSER_MAX_HEIGHT, resizeComposer } from "../src/features/chat/composerResize";

function field(scrollHeight: number, height = "") {
  return { style: { height }, scrollHeight };
}

describe("resizeComposer", () => {
  test("grows the field to fit the draft", () => {
    const el = field(88);
    resizeComposer(el);
    expect(el.style.height).toBe("88px");
  });

  test("stops growing at the max height", () => {
    const el = field(400);
    resizeComposer(el);
    expect(el.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
  });

  test("leaves the height alone when the field has no layout box", () => {
    const wrapper = { style: { minHeight: "20px" }, offsetHeight: 0 };
    const el = { ...field(0, "88px"), parentElement: wrapper };
    resizeComposer(el);
    expect(el.style.height).toBe("88px");
    expect(wrapper.style.minHeight).toBe("20px");
  });

  test("keeps the composer space while measuring, then releases it", () => {
    const wrapper = { style: { minHeight: "20px" }, offsetHeight: 88 };
    const style = { height: "88px" };
    let measured = false;
    const el = {
      style,
      parentElement: wrapper,
      get scrollHeight() {
        if (style.height === "auto") {
          // The transcript must not see a taller viewport during this read.
          expect(wrapper.style.minHeight).toBe("88px");
          measured = true;
        }
        return 140;
      },
    };
    resizeComposer(el);
    expect(measured).toBe(true);
    expect(style.height).toBe("140px");
    expect(wrapper.style.minHeight).toBe("20px");
  });

  test("does not publish a 1px scrollHeight wobble", () => {
    const wrapper = { style: { minHeight: "" }, offsetHeight: 46 };
    const style = { height: "46px" };
    const el = {
      style,
      parentElement: wrapper,
      get scrollHeight() {
        return style.height === "auto" ? 47 : 46;
      },
    };
    resizeComposer(el);
    expect(style.height).toBe("46px");
    expect(wrapper.style.minHeight).toBe("");
  });

  test("still grows by a real line", () => {
    const wrapper = { style: { minHeight: "" }, offsetHeight: 46 };
    const style = { height: "46px" };
    const el = {
      style,
      parentElement: wrapper,
      get scrollHeight() {
        return style.height === "auto" ? 68 : 46;
      },
    };
    resizeComposer(el);
    expect(style.height).toBe("68px");
    expect(wrapper.style.minHeight).toBe("");
  });
});
