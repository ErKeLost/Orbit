import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "../../../lib/native";
import { readTextFile } from "../../../lib/git";
import { Markdown } from "../../../components/Markdown";
import { Loader } from "../../../shared/ui/icons";
import type { PreviewKind } from "./kind";

type PreviewPayload = {
  kind: string;
  title?: string;
  paragraphs?: string[];
  sheets?: { name: string; rows: string[][] }[];
  slides?: { title: string; lines: string[] }[];
  chapters?: { title: string; html: string }[];
  tables?: { name: string; rows: Record<string, unknown>[] }[];
  cells?: { kind: string; source: string }[];
  entries?: { name: string; size: number }[];
  truncated?: boolean;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length && rows.length < 80; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") quoted = false;
      else cell += char;
      continue;
    }
    if (char === "\"" && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.slice(0, 80);
}

function SheetGrid({ rows }: { rows: string[][] }) {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const [cols, setCols] = useState<number[]>(() => Array.from({ length: width }, () => 128));
  const [heights, setHeights] = useState<number[]>(() => rows.map(() => 28));

  function drag(event: ReactPointerEvent<HTMLElement>, apply: (delta: number) => void) {
    event.preventDefault();
    const start = event.clientX;
    const startY = event.clientY;
    const horizontal = event.currentTarget.dataset.axis === "x";
    const move = (next: PointerEvent) => apply(horizontal ? next.clientX - start : next.clientY - startY);
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <div className="overflow-auto">
      <table className="border-collapse text-xs">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} style={{ height: heights[rowIndex] ?? 28 }}>
              {Array.from({ length: width }, (_, colIndex) => (
                <td
                  key={colIndex}
                  className="relative border border-line px-2 align-top text-ink-1"
                  style={{ width: cols[colIndex] ?? 128, minWidth: 48, maxWidth: 480 }}
                >
                  <span className="block overflow-hidden">{row[colIndex] ?? ""}</span>
                  <span
                    data-axis="x"
                    className="absolute inset-y-0 right-0 w-1 cursor-col-resize"
                    onPointerDown={(event) => drag(event, (delta) => setCols((current) => current.map((value, index) => index === colIndex ? Math.min(480, Math.max(48, (cols[colIndex] ?? 128) + delta)) : value)))}
                  />
                  <span
                    data-axis="y"
                    className="absolute inset-x-0 bottom-0 h-1 cursor-row-resize"
                    onPointerDown={(event) => drag(event, (delta) => setHeights((current) => current.map((value, index) => index === rowIndex ? Math.min(160, Math.max(22, (heights[rowIndex] ?? 28) + delta)) : value)))}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MAX_FONT_BYTES = 10 * 1024 * 1024;

/** Load path from T3 `FontViewer`: cap the bytes, prove FontFace can decode them, then show a sandboxed specimen. */
function FontPreview({ path, name }: { path: string; name: string }) {
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setError("字体加载超时");
      controller.abort();
    }, 30_000);
    const src = convertFileSrc(path);
    void fetch(src, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("字体读不出来");
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_FONT_BYTES) throw new Error("字体预览上限是 10 MB");
        await new FontFace("file-preview", buffer).load();
        const blob = new Blob([buffer]);
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
          reader.addEventListener("error", () => reject(new Error("字体解码失败")), { once: true });
          reader.readAsDataURL(blob);
        });
      })
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "这个字体没法预览");
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [path]);
  if (error) return <p className="p-4 text-xs text-ink-3">{error}</p>;
  if (!data) return <div className="grid h-full place-items-center text-ink-3"><Loader className="size-4 animate-spin" /></div>;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>@font-face{font-family:preview;src:url('${data}')}body{margin:0;padding:32px;font-family:preview}h1{font-size:40px;font-weight:normal}p{line-height:1.4}small{font:12px monospace;display:block;opacity:.6;margin-bottom:8px}</style></head><body><h1>${name.replace(/[<>&]/g, "")}</h1><p style="font-size:24px">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br>abcdefghijklmnopqrstuvwxyz<br>0123456789 !?&amp;@#%(){}[]</p>${[12, 16, 24, 40, 64].map((size) => `<p style="font-size:${size}px"><small>${size} px</small>The quick brown fox jumps over the lazy dog.</p>`).join("")}</body></html>`;
  return <iframe title={name} srcDoc={srcDoc} sandbox="" className="min-h-0 flex-1 border-0" />;
}

export function DocumentPreview({ path, kind, name }: { path: string; kind: PreviewKind; name: string }) {
  const csv = kind === "sheet" && path.toLowerCase().endsWith(".csv");
  const remote = useQuery({
    queryKey: ["preview", path],
    queryFn: () => invoke<PreviewPayload>("preview_document", { path }),
    enabled: kind !== "font" && !csv,
  });
  const text = useQuery({
    queryKey: ["file", path],
    queryFn: () => readTextFile(path),
    enabled: csv,
  });
  const csvRows = useMemo(() => (text.data ? parseCsv(text.data) : []), [text.data]);

  if (kind === "font") return <FontPreview path={path} name={name} />;
  if (csv) {
    if (text.isPending) return <div className="grid h-full place-items-center text-ink-3"><Loader className="size-4 animate-spin" /></div>;
    if (text.isError) return <p className="p-4 text-xs text-ink-3">{String(text.error)}</p>;
    return <div className="min-h-0 flex-1 overflow-auto p-4"><SheetGrid rows={csvRows} /></div>;
  }
  if (remote.isPending) return <div className="grid h-full place-items-center text-ink-3"><Loader className="size-4 animate-spin" /></div>;
  if (remote.isError) return <p className="p-4 text-xs text-ink-3">{String(remote.error)}</p>;
  const data = remote.data;
  if (!data) return null;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {data.kind === "document" ? (
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {data.paragraphs?.map((paragraph, index) => <p key={index} className="text-ui leading-6 text-ink-1">{paragraph}</p>)}
        </div>
      ) : null}
      {data.kind === "sheet" ? (
        <div className="flex flex-col gap-4">
          {data.sheets?.map((sheet) => (
            <section key={sheet.name}>
              <h3 className="mb-2 text-xs text-ink-3">{sheet.name}</h3>
              <SheetGrid rows={sheet.rows} />
            </section>
          ))}
        </div>
      ) : null}
      {data.kind === "slides" ? (
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {data.slides?.map((slide, index) => (
            <article key={index} className="rounded-lg border border-line bg-fill-weak p-4">
              <h3 className="text-sm font-medium text-ink-1">{slide.title}</h3>
              <ul className="mt-2 flex flex-col gap-1 text-xs leading-5 text-ink-2">
                {slide.lines.slice(1).map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}
              </ul>
            </article>
          ))}
        </div>
      ) : null}
      {data.kind === "epub" ? (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <h2 className="text-sm font-medium text-ink-1">{data.title}</h2>
          {data.chapters?.map((chapter) => (
            <iframe key={chapter.title} title={chapter.title} sandbox="" srcDoc={chapter.html} className="h-[70vh] w-full rounded-lg border border-line bg-white" />
          ))}
        </div>
      ) : null}
      {data.kind === "sqlite" ? (
        <div className="flex flex-col gap-4">
          {data.tables?.map((table) => {
            const columns = Object.keys(table.rows[0] ?? {});
            const rows = table.rows.map((row) => columns.map((column) => String(row[column] ?? "")));
            return (
              <section key={table.name}>
                <h3 className="mb-2 font-mono text-xs text-ink-3">{table.name}</h3>
                <SheetGrid rows={[columns, ...rows]} />
              </section>
            );
          })}
        </div>
      ) : null}
      {data.kind === "notebook" ? (
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {data.cells?.map((cell, index) => (
            <article key={index} className="rounded-lg border border-line bg-fill-weak p-3">
              {cell.kind === "markdown" ? <Markdown content={cell.source} /> : <pre className="overflow-auto font-mono text-xs leading-5 text-ink-1">{cell.source}</pre>}
            </article>
          ))}
        </div>
      ) : null}
      {data.kind === "archive" ? (
        <ul className="mx-auto flex max-w-xl flex-col gap-1 font-mono text-xs">
          {data.entries?.map((entry) => (
            <li key={entry.name} className="flex justify-between gap-3 text-ink-2">
              <span className="min-w-0 truncate">{entry.name}</span>
              <span className="shrink-0 text-ink-3">{entry.size}</span>
            </li>
          ))}
          {data.truncated ? <li className="text-ink-3">只列出前 400 项</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
