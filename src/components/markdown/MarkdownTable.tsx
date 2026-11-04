/**
 * 表格：横向滚动 + 「复制为 markdown」。移植自 t3code 的 `MarkdownTable`，
 * 去掉了展开/收起与 base-ui 的菜单——Orbit 的表格不截断单元格，横向滚动
 * 已经够用，多一个状态只会让流式中的表格重新挂载。
 */
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps } from "react";

function escapeCell(text: string): string {
  return text.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

export function serializeTableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((row) =>
    Array.from(row.cells).map((cell) => escapeCell(cell.textContent ?? "")),
  );
  const [header, ...body] = rows;
  if (!header) return "";
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = () => {
    const table = tableRef.current;
    if (!table || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(serializeTableToMarkdown(table))
      .then(() => {
        setCopied(true);
        if (timerRef.current != null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div className="md-table">
      <div className="md-table-scroll">
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </div>
      <div className="md-table-actions">
        <button
          type="button"
          className="md-table-copy"
          aria-label={copied ? "已复制表格" : "复制表格"}
          onClick={copy}
        >
          {copied ? <Check aria-hidden size={12} /> : <Copy aria-hidden size={12} />}
        </button>
      </div>
    </div>
  );
}
