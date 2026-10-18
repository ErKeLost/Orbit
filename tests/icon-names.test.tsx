import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "../src/components/Icon";

/**
 * 图标名就是 `shared/ui/icons.tsx` 的导出名（kebab 化之后），所以这里钉的是
 * 那条派生规则本身：加一个 glyph 就等于加一个可用的名字，删掉名字就该回落。
 */
describe("chrome icon names", () => {
  test("resolves a name from the export it is derived from", () => {
    for (const name of ["chevron-down", "message-square", "git-merge", "id-card", "plug"]) {
      expect(renderToStaticMarkup(<Icon name={name} />)).toContain("<svg");
    }
  });

  test("an unknown name still renders a glyph instead of a hole", () => {
    expect(renderToStaticMarkup(<Icon name="not-a-real-icon" />)).toContain("<svg");
    expect(renderToStaticMarkup(<Icon name="fluent-color:not-a-real-icon" />)).toContain("<svg");
  });

  test("legacy ph: prefix is ignored", () => {
    expect(renderToStaticMarkup(<Icon name="ph:copy" />)).toBe(renderToStaticMarkup(<Icon name="copy" />));
  });
});
