import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DisplayMessage, Part, PiMessage, Tool } from "../../lib/protocol";
import { formatTranscriptError, toolResultText, type Part as MessagePart, type ToolImage } from "../../lib/protocol";
import { getToolCodePresentation } from "../../lib/changes";
import { branchFromMessage, report } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { Markdown } from "../../components/Markdown";
import { CodeChange } from "../../components/LazyCodeChange";
import { GridReveal } from "../../shared/ui/GridReveal";
import { ImageActionsMenu } from "../../components/chat/ImageActions";
import { Shimmer } from "../../shared/ui/Shimmer";
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  CursorMagicSelection,
  GitBranch,
  Loader,
  Minus,
  PenLine,
  RefreshCw,
  Search,
  Terminal,
  Wrench,
  X,
} from "../../shared/ui/icons";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { SiteLogo } from "./site-logo";
import { useImageSrc } from "../../lib/media-src";
import { resultSites, urlHost, urlOrigin } from "./web-search-site";
import {
  buildPhases,
  formatWorkingDuration,
  workCategory,
  phaseTitle,
  projectTurn,
  proseSummary,
  toolLabel,
  toolName,
  userImages,
  userText,
  workSummaryLine,
  type Phase,
  type TurnStep,
} from "./turnModel";

const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * A read of an image returns its pixels plus a line of framing
 * (`Read image file [image/png]`), and flattened content adds `[图片]` where the
 * image was. Both are placeholders for something the preview already shows, so
 * they are dropped once the image is on screen.
 */
const IMAGE_RESULT_NOTE = /^(Read image file \[[^\]]*\]|\[图片\])$/
function withoutImageNotes(text: string) {
  const kept = text.split("\n").filter((line) => !IMAGE_RESULT_NOTE.test(line.trim()));
  return kept.join("\n").trim();
}
/** A tool that returned no pixels shares this, so the row allocates nothing. */
const EMPTY_IMAGES: ToolImage[] = [];

/**
 * One image from a tool result. The bytes may still be in the session file
 * (`{session, at, ordinal}`, see `history::project`), so the source is resolved
 * here rather than in a `.map()` — the hook fetches only what is rendered.
 */
function PreviewImage({ image, path, label }: { image: ToolImage; path?: string; label: string }) {
  const src = useImageSrc(image);
  if (!src) {
    return <div aria-hidden className="h-24 w-32 animate-pulse rounded-xl border border-content/10 bg-content/5" />;
  }
  return (
    <ImageActionsMenu dataUrl={src} file={image.file} path={path}>
      <img
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="max-h-52 max-w-full rounded-xl object-contain"
      />
    </ImageActionsMenu>
  );
}
/** A read's path is only worth handing to the file manager when it is absolute. */
const isAbsolutePath = (path: string | undefined): path is string => Boolean(path && /^([/\\]|[A-Za-z]:)/.test(path));

/** One attachment on a user message; the bytes may live in the session file. */
function UserPhoto({ part }: { part: MessagePart }) {
  const src = useImageSrc(part);
  if (!src) return <div aria-hidden className="h-24 w-24 animate-pulse rounded-xl bg-content/5" />;
  return <img src={src} alt="附件" decoding="async" className="max-h-48 max-w-[14rem] rounded-xl object-cover" />;
}

/** An image that arrived inside the answer's prose (not a tool result). */
function InlineImage({ part }: { part: MessagePart }) {
  const src = useImageSrc(part);
  return src ? <img className="message-image my-1" src={src} alt="会话附件" decoding="async" /> : null;
}

function messageTime(message?: PiMessage) {
  const raw = message?.timestamp;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
}

/* ---------------------------------------------------------------- fold rows */

/** Orbit `TurnRow`: animates a row into and out of the fold. */
function TurnRow({ folded, children }: { folded: boolean; children: ReactNode | (() => ReactNode) }) {
  const [state, setState] = useState<"open" | "opening" | "closing" | "closed">(folded ? "closed" : "open");
  useLayoutEffect(() => {
    setState((current) => {
      if (folded) return current === "closed" || current === "closing" ? current : "closing";
      return current === "open" || current === "opening" ? current : "opening";
    });
  }, [folded]);
  useEffect(() => {
    if (state !== "opening" && state !== "closing") return;
    const timer = window.setTimeout(() => setState(folded ? "closed" : "open"), 350);
    return () => window.clearTimeout(timer);
  }, [state, folded]);
  if (folded && state === "closed") return null;
  return (
    <div
      className="zen-fold-item"
      data-fold-state={state}
      inert={folded}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setState(folded ? "closed" : "open");
      }}
    >
      <div>
        <div className="pb-1">{typeof children === "function" ? children() : children}</div>
      </div>
    </div>
  );
}

function useElapsed(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return startedAt == null ? null : Math.max(0, now - startedAt);
}

/** The line a turn's work folds behind (Orbit `WorkFoldLine`). */
function WorkFoldLine({
  title,
  live,
  expandable,
  open,
  onToggle,
}: {
  title: ReactNode;
  live: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const label = live ? (
    title
  ) : (
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/80">{title}</span>
  );
  const row = `flex w-full min-w-0 items-center gap-1.5 px-4 pb-1 pt-1.5 text-left${open ? " zen-fold-drop" : ""}`;
  // The caret leads the line, hugging the left edge like the rest of the turn.
  if (!expandable) {
    return (
      <div className={`group ${row}`} role={live ? "status" : undefined} aria-live={live ? "polite" : undefined}>
        <span aria-hidden className="size-3.5 shrink-0" />
        {label}
      </div>
    );
  }
  return (
    <button type="button" aria-expanded={open} aria-label={open ? "收起过程" : "展开过程"} onClick={onToggle} className={`group ${row}`}>
      <ChevronRight
        className={`size-3.5 shrink-0 text-content/45 transition-transform ${open ? "rotate-90" : ""}`}
        strokeWidth={1.75}
      />
      {label}
    </button>
  );
}

/* -------------------------------------------------------------- phase rows */

function PhaseIcon({ kind, className = "" }: { kind: Phase["kind"]; className?: string }) {
  const props = { className: `size-3.5 shrink-0 text-content/45 ${className}`, strokeWidth: 1.75 };
  if (kind === "edit") return <PenLine {...props} />;
  if (kind === "research") return <Search {...props} />;
  if (kind === "run") return <Terminal {...props} />;
  if (kind === "agent") return <Bot {...props} />;
  if (kind === "computer") return <CursorMagicSelection {...props} />;
  if (kind === "think") return null;
  if (kind === "other") return <Wrench {...props} />;
  return <Minus {...props} />;
}

function ThinkingRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const full = (step.text ?? "").trim();
  const text = proseSummary(full) || "Thinking";
  // A short block's summary *is* its text, so an expand affordance would print
  // the same words twice. Only a block that actually has more to show gets one.
  const expandable = full !== text;
  const pulse = step.live ? "zen-thinking-pulse" : "";
  const label = (
    <span className={`min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/75 ${pulse}`}>{text}</span>
  );
  return (
    <div className="flex min-w-0 flex-col">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "收起思考" : `展开思考：${text}`}
          onClick={() => setOpen((value) => !value)}
          className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
        >
          {label}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 py-1">{label}</div>
      )}
      {open && expandable ? (
        <div className="min-w-0 pb-2">
          <Markdown className="agent-reasoning" content={full} links="panel" />
        </div>
      ) : null}
    </div>
  );
}

function NoteRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const full = (step.text ?? "").trim();
  const text = proseSummary(full);
  const expandable = Boolean(text) && full !== text;
  const label = (
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/75">{text}</span>
  );
  return (
    <div className="flex min-w-0 flex-col">
      {expandable ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="group flex min-w-0 items-center gap-1.5 py-1 text-left">
          {label}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-1.5 py-1">{label}</div>
      )}
      {open && expandable ? (
        <div className="min-w-0 pb-2">
          <Markdown content={full} links="panel" />
        </div>
      ) : null}
    </div>
  );
}

/** A tool call in Orbit's "<Verb> <file chip>" form; opens onto its result. */
function ToolRow({ part, tools }: { part: Part; tools: Record<string, Tool> }) {
  const [open, setOpen] = useState(false);
  const tool = tools[part.id ?? ""];
  const name = toolName(part, tools);
  const { action, target, file, web, href } = toolLabel(part, tools);
  // A fetch names one site: its logo leads the row. A search only knows its
  // query, so the *returned* sites' logos are appended once the result lands.
  const siteOrigin = web && href ? urlOrigin(href) : undefined;
  const siteHost = web && href ? urlHost(href) : undefined;
  const failed = Boolean(tool?.isError);
  const running = Boolean(tool?.running);
  const rawResult = toolResultText(tool?.result);
  // Reads of images, PDFs, exports: anything the tool handed back as pixels is
  // shown here rather than described. Only the image tool renders its own card.
  // (Not memoized: the compiler gives up on the whole row when a memo's deps are
  // narrower than the value it reads, and the data URLs are cached by object.)
  const previews = failed ? EMPTY_IMAGES : tool?.images ?? EMPTY_IMAGES;
  // 状态行的小缩略图也用同一套解析：历史图片的字节在会话文件里。
  const firstPreview = useImageSrc(previews[0]);
  const result = previews.length ? withoutImageNotes(rawResult) : rawResult;
  const previewPath = typeof part.arguments?.path === "string" && isAbsolutePath(part.arguments.path) ? part.arguments.path : undefined;
  const searched = useMemo(() => (web && !href && !failed ? resultSites(result) : []), [web, href, failed, result]);
  const request = useMemo(() => part.argsText ?? JSON.stringify(part.arguments ?? {}), [part.argsText, part.arguments]);
  const code = useMemo(
    () => (open ? getToolCodePresentation(name, part.arguments ?? {}, result, tool?.details) : {}),
    [open, name, part.arguments, result, tool?.details],
  );
  const fileName = target.split(/[\\/]/).filter(Boolean).at(-1) ?? target;
  const actionTone = failed ? "text-red-400" : "text-content/50";
  const targetTone = failed ? "text-red-400" : "text-content/70";
  const patch = tool?.details?.patch;
  // patch 的增删行数扫两遍全量 diff：流式时这一行每帧重渲染，没必要重算。
  const { additions, deletions } = useMemo(() => {
    if (!patch) return { additions: 0, deletions: 0 };
    let add = 0;
    let del = 0;
    for (const line of patch.split("\n")) {
      if (/^\+(?!\+\+)/.test(line)) add += 1;
      else if (/^-(?!--)/.test(line)) del += 1;
    }
    return { additions: add, deletions: del };
  }, [patch]);
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${failed ? "失败的" : ""}工具调用：${action} ${target}`}
        onClick={() => setOpen((value) => !value)}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
      >
        <span className="grid size-3.5 shrink-0 place-items-center">
          {running ? (
            <Loader className="size-3.5 shrink-0 animate-spin text-content/40" strokeWidth={1.75} />
          ) : (
            <PhaseIcon kind={workCategory(name)} className={failed ? "text-red-400/70" : ""} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px]">
          <span className={`shrink-0 font-sans text-sm ${actionTone}`}>{action}</span>
          {target || web ? (
            web && href ? (
              <span className={`-my-0.5 flex min-w-0 max-w-full items-center gap-1 rounded bg-content/6 px-1 py-0.5 group-hover:bg-content/10 ${targetTone}`} title={siteHost ? `${siteHost} · ${target}` : target}>
                {siteOrigin ? <SiteLogo origin={siteOrigin} /> : null}
                {siteHost ? <span className="shrink-0 font-sans text-[11px] text-content/45">{siteHost}</span> : null}
                {target ? <span className="min-w-0 truncate">{target}</span> : null}
              </span>
            ) : file ? (
              <span className={`-my-0.5 flex min-w-0 max-w-full items-center gap-1 rounded bg-content/6 px-1 py-0.5 group-hover:bg-content/10 ${targetTone}`} title={target}>
                {firstPreview ? (
                  <img src={firstPreview} alt="" className="size-4 shrink-0 rounded-[4px] object-cover" draggable={false} />
                ) : (
                  <FileTypeIcon name={fileName} isDir={false} />
                )}
                <span className="min-w-0 truncate">{target}</span>
              </span>
            ) : (
              <span className={`flex min-w-0 flex-1 items-center pl-1 ${targetTone}`} title={target}>
                <span className="min-w-0 truncate">{target}</span>
              </span>
            )
          ) : null}
          {searched.length ? (
            <span className="flex shrink-0 items-center gap-1 pl-0.5" title={searched.join(" · ")}>
              {searched.map((host) => <SiteLogo key={host} origin={`https://${host}`} />)}
            </span>
          ) : null}
          {additions || deletions ? (
            <span className="shrink-0 font-sans text-[11px] font-semibold tabular-nums">
              <span className="text-diff-add-fg">+{additions}</span> <span className="text-diff-del-fg">-{deletions}</span>
            </span>
          ) : null}
        </span>
        {!running && typeof tool?.durationMs === "number" && tool.durationMs >= 1000 ? (
          <span className="shrink-0 font-sans text-[11px] tabular-nums text-content/40" title={`工具执行耗时 ${tool.durationMs} ms`}>
            {(tool.durationMs / 1000).toFixed(1)}s
          </span>
        ) : null}
        {failed ? <X className="size-3.5 shrink-0 text-red-400" strokeWidth={2} /> : null}
        <ChevronRight className={`size-3.5 shrink-0 text-content/35 opacity-0 transition-[opacity,transform] group-hover:opacity-100 ${open ? "rotate-90 opacity-100" : ""}`} strokeWidth={1.75} />
      </button>
      {previews.length ? (
        <div className="flex flex-wrap gap-1.5 py-1 pl-5">
          {previews.map((image, index) => (
            <PreviewImage key={`${part.id ?? "preview"}-${index}`} image={image} path={previewPath} label={`${fileName} 预览`} />
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="min-w-0 pb-1.5">
          {code.request ? <CodeChange change={code.request} compact /> : null}
          {!code.request && !code.result ? (
            <pre className="mt-1 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-content/4 px-2.5 py-2 font-mono text-[12px] leading-5 text-content/55">{request}</pre>
          ) : null}
          {code.result && !running ? <CodeChange change={code.result} compact /> : null}
          {!code.result && !previews.length && (result || !running) ? (
            <pre
              className={`mt-1 max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-content/4 px-2.5 py-2 font-mono text-[12px] leading-5 ${
                failed ? "text-red-400/80" : "text-content/55"
              }`}
            >
              {result || "未返回输出"}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GeneratedImageStep({ part, tools }: { part: Part; tools: Record<string, Tool> }) {
  const tool = tools[part.id ?? ""];
  const prompt = typeof part.arguments?.prompt === "string" ? part.arguments.prompt : undefined;
  const aspectArg = typeof part.arguments?.aspect === "string" ? /^(\d+):(\d+)$/.exec(part.arguments.aspect) : null;
  const knownAspect = aspectArg ? Number(aspectArg[1]) / Number(aspectArg[2]) : undefined;
  const images = tool?.images ?? EMPTY_IMAGES;
  if (tool?.isError) return <ToolRow part={part} tools={tools} />;
  return (
    <div className="tool-image-generation">
      {images.length === 0 ? (
        <GeneratedImage src={null} knownAspect={knownAspect} prompt={prompt} />
      ) : (
        images.map((image, index) => (
          <GeneratedImageItem
            key={`${part.id ?? "image"}-${index}`}
            image={image}
            path={tool?.image?.paths?.[index]}
            knownAspect={knownAspect}
            prompt={index === 0 ? prompt : undefined}
          />
        ))
      )}
    </div>
  );
}

/** Resolves one generated image (possibly still in the session file) and wraps it. */
function GeneratedImageItem({
  image,
  path,
  knownAspect,
  prompt,
}: {
  image: ToolImage;
  path?: string;
  knownAspect?: number;
  prompt?: string;
}) {
  const src = useImageSrc(image);
  return (
    <ImageActionsMenu dataUrl={src ?? null} file={image.file} path={path} prompt={prompt}>
      <GeneratedImage src={src ?? null} knownAspect={knownAspect} prompt={prompt} />
    </ImageActionsMenu>
  );
}

function GeneratedImage({ src, knownAspect, prompt }: { src: string | null; knownAspect?: number; prompt?: string }) {
  const [measured, setMeasured] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!src) return;
    let active = true;
    const element = new Image();
    element.onload = () => {
      if (active && element.naturalWidth > 0 && element.naturalHeight > 0) setMeasured(element.naturalWidth / element.naturalHeight);
    };
    element.src = src;
    return () => {
      active = false;
      element.onload = null;
    };
  }, [src]);
  const aspect = measured ?? knownAspect;
  if (aspect === undefined) return null;
  // 限宽展示：横向图不超 416px，竖向图按比例收窄（高度不超 416px），
  // 极端长图设下限避免缩没了。保持原始宽高比，不拉伸。
  const factor = Math.min(Math.max(aspect, 0.4), 1);
  return (
    <GridReveal
      src={src}
      aspect={aspect}
      alt={prompt ?? "生成的图片"}
      caption={prompt}
      style={{ width: `min(100%, ${Math.round(416 * factor)}px)` }}
    />
  );
}

function StepRow({ step, tools }: { step: TurnStep; tools: Record<string, Tool> }) {
  if (step.kind === "think") return <ThinkingRow step={step} />;
  if (step.kind === "note") return <NoteRow step={step} />;
  if (step.kind === "image" && step.part?.type === "toolCall") return <GeneratedImageStep part={step.part} tools={tools} />;
  if (step.kind === "image" && step.part) return <InlineImage part={step.part} />;
  if (step.part) return <ToolRow part={step.part} tools={tools} />;
  return null;
}

/**
 * Orbit `ActivityPhaseGroup`. A phase row is the second level: the headline is
 * the agent's own narration, or a tally of what this phase is doing. Its steps
 * (Run rows, thinking text) are the third level and stay folded until the
 * reader opens them — during a run too: the streaming prose lives in the answer
 * area, so nothing is hidden by keeping detail shut. The reader's own toggle
 * still wins.
 */
function PhaseGroup({ phase, tools, live, defaultOpen = false }: { phase: Phase; tools: Record<string, Tool>; live: boolean; defaultOpen?: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  // 默认只开第二层：阶段行（"正在运行 7 条命令"）一眼可见，具体每一步
  // （Run 命令、思考原文）收在它下面，要点一下才展开。
  const open = override ?? defaultOpen;
  const title = phaseTitle(phase, tools, live);

  if (!phase.headline && phase.steps.length === 1) {
    return (
      <div className="flex min-w-0 items-start gap-1.5">
        <PhaseIcon kind={phase.kind} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <StepRow step={phase.steps[0]} tools={tools} />
        </div>
      </div>
    );
  }
  const label = live ? (
    <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>{title}</Shimmer>
  ) : (
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/80">{title}</span>
  );
  // The label already shows `proseSummary` of the headline. Repeating the same
  // words underneath is only worth it when the headline is longer than its
  // summary.
  const headlineDetail = phase.headline?.text && phase.headline.text.trim() !== title ? phase.headline.text : undefined;
  if (phase.steps.length === 0) {
    // A phase that is nothing but prose has nothing to disclose: the label is the
    // same text (`proseSummary` of it), so rendering a label *and* a body printed
    // the same paragraph twice. Show it once, the way a lone step is shown.
    return (
      <div className="flex min-w-0 items-start gap-1.5">
        <PhaseIcon kind={phase.kind} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          {phase.headline?.text ? <Markdown content={phase.headline.text} animated={live} links="panel" /> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `收起 ${title} 的步骤` : `展开 ${title} 的步骤`}
        onClick={() => setOverride(!open)}
        className="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left"
      >
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <PhaseIcon kind={phase.kind} className="group-hover:opacity-0" />
          <ChevronRight
            className={`absolute size-3.5 text-content/45 opacity-0 transition-transform duration-200 group-hover:opacity-100 ${open ? "rotate-90" : ""}`}
            strokeWidth={1.75}
          />
        </span>
        {label}
      </button>
      <div className="zen-phase-body" data-open={open}>
        {open ? (
          <div className={live ? "zen-phase-live" : undefined}>
            <div className="flex min-w-0 flex-col">
              {open && headlineDetail ? (
                <div className="zen-phase-step py-1">
                  <Markdown content={headlineDetail} animated={live} links="panel" />
                </div>
              ) : null}
              {phase.steps.map((step) => (
                <div key={step.key} className="zen-phase-step">
                  <StepRow step={step} tools={tools} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const ActivityPhases = memo(function ActivityPhases({
  steps,
  tools,
  done,
  openSteps = false,
}: {
  steps: TurnStep[];
  tools: Record<string, Tool>;
  done: boolean;
  /** 直接展开每条阶段里的步骤（内容规则的测试用；界面永远从第二层开始）。 */
  openSteps?: boolean;
}) {
  const phases = useMemo(() => buildPhases(steps, tools), [steps, tools]);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4">
      {phases.map((phase, index) => (
        <PhaseGroup key={phase.key || index} phase={phase} tools={tools} live={!done && index === phases.length - 1} defaultOpen={openSteps} />
      ))}
    </div>
  );
});

/* ---------------------------------------------------------------- footers */

function CopyButton({ text, label = "复制回复" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      title={copied ? "已复制" : label}
      aria-label={copied ? "已复制" : label}
      className="-ml-1 rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          if (timer.current != null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 2000);
        }).catch(() => undefined);
      }}
    >
      {copied ? <Check className="size-3.5" strokeWidth={1.75} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    </button>
  );
}

function BranchButton({ message }: { message: PiMessage }) {
  const [busy, setBusy] = useState(false);
  const disabled = useWorkspace((state) => state.connection !== "online" || state.transcript.running || state.transcript.compacting);
  return (
    <button
      type="button"
      title={busy ? "正在创建分支" : "分支到新聊天"}
      aria-label={busy ? "正在创建分支" : "分支到新聊天"}
      disabled={disabled || busy}
      className="rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70 disabled:opacity-40 disabled:hover:bg-transparent"
      onClick={() => {
        setBusy(true);
        void branchFromMessage(message).catch(report).finally(() => setBusy(false));
      }}
    >
      <GitBranch className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

/** Orbit `TurnDuration`: copy · branch · • model worked for · • time. */
function TurnFooter({
  copyText,
  last,
  label,
  labelHidden,
  completedAt,
}: {
  copyText: string;
  last?: PiMessage;
  label: string;
  labelHidden: boolean;
  completedAt?: number;
}) {
  const dot = <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-content/25" />;
  return (
    <div aria-label={label} className="flex w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden px-4 pb-3 pt-1 font-sans text-sm text-content/40">
      <span className="flex shrink-0 items-center gap-1">
        {copyText ? <CopyButton text={copyText} /> : <Check className="size-3.5" strokeWidth={1.75} />}
        {last ? <BranchButton message={last} /> : null}
      </span>
      {labelHidden ? null : (
        <span className="flex min-w-0 items-center gap-2.5">
          {dot}
          <span className="min-w-0 truncate" title={label}>{label}</span>
        </span>
      )}
      {completedAt != null ? (
        <span className="flex shrink-0 items-center gap-2.5">
          {dot}
          <span className="shrink-0 text-content/35">{clockFormatter.format(new Date(completedAt))}</span>
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- messages */

/** Orbit `UserMessageBlock` in its chat layout. */
const UserMessage = memo(function UserMessage({ item }: { item: DisplayMessage }) {
  const text = userText(item.message);
  const photos = userImages(item.message);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLPreElement | null>(null);
  const singleLine = !text.includes("\n") && text.length < 48;
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <div data-prompt-anchor={item.id} className="user-message-row group/usermsg flex flex-col items-end overflow-visible pl-14 pr-4 pt-3">
      <div className="user-message-hover-zone flex w-fit min-w-0 max-w-full flex-col items-end overflow-visible">
        {photos.length ? (
          <div className="mb-1 flex max-w-full flex-wrap justify-end gap-1.5">
            {photos.map((photo, index) => (
              <UserPhoto key={`${photo.id ?? "photo"}-${index}`} part={photo} />
            ))}
          </div>
        ) : null}
        {text ? (
          <div
            data-chat-message={item.id}
            data-chat-message-role="user"
            className={`user-message-bubble relative w-fit min-w-0 max-w-[min(100%,36rem)] bg-content/10 px-3 py-2 font-sans text-content transition-[background-color] duration-200 ${
              singleLine ? "rounded-full" : "rounded-xl"
            }`}
          >
            <pre ref={textRef} data-selectable-agent-response={item.id} className={`min-w-0 whitespace-pre-wrap break-words font-sans text-sm ${expanded ? "" : "line-clamp-4"}`}>
              {text}
            </pre>
            {clamped && !expanded ? (
              <button type="button" className="mt-1 text-[12px] text-content/50 hover:text-content" onClick={() => setExpanded(true)}>
                显示全部
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="user-message-actions flex h-6 items-center gap-1 pt-1 text-content/40">
          {text ? <CopyButton text={text} label="复制消息" /> : null}
          {messageTime(item.message) ? (
            <time className="text-[12px] text-content/35" dateTime={new Date(messageTime(item.message)!).toISOString()}>
              {clockFormatter.format(new Date(messageTime(item.message)!))}
            </time>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function BashExecution({ message }: { message: PiMessage }) {
  const status = message.cancelled ? "已取消" : message.exitCode === 0 ? "完成" : message.exitCode == null ? "运行中" : `退出 ${message.exitCode}`;
  return (
    <div className="px-4 py-1">
      <div className="overflow-hidden rounded-[10px] border border-content/10 bg-content/4">
        <div className="flex h-8 items-center gap-2 border-b border-stroke px-2.5 font-mono text-[12px]">
          <Terminal className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
          <code className="min-w-0 flex-1 truncate text-content/80">{message.command ?? ""}</code>
          <span className="shrink-0 text-[11px] text-content/45">{status}</span>
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-5 text-content/60">{message.output ?? ""}</pre>
      </div>
    </div>
  );
}

function CompactionNotice({ message }: { message: PiMessage }) {
  const [open, setOpen] = useState(false);
  const summary = (message.summary || (typeof message.content === "string" ? message.content : "")).trim();
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="h-px flex-1 bg-stroke" />
      <button type="button" disabled={!summary} onClick={() => setOpen((value) => !value)} className="flex shrink-0 items-center gap-1.5 text-[12px] text-content/45 hover:text-content/75 disabled:hover:text-content/45">
        <RefreshCw className="size-3" strokeWidth={1.75} />
        上下文已压缩
      </button>
      <span className="h-px flex-1 bg-stroke" />
      {open && summary ? (
        <div className="basis-full">
          <Markdown className="agent-reasoning" content={summary} links="panel" />
        </div>
      ) : null}
    </div>
  );
}

export function ErrorRow({ error }: { error: string }) {
  return (
    <div role="alert" className="mx-4 my-1 rounded-lg border border-red-400/25 bg-red-400/8 px-3 py-2 text-[13px] leading-relaxed text-red-300">
      {formatTranscriptError(error)}
    </div>
  );
}

type AssistantTurnProps = {
  items: DisplayMessage[];
  tools: Record<string, Tool>;
  streaming: boolean;
  startedAt?: number;
  elapsedMs?: number;
  modelName?: string;
  activity?: ReactNode;
};

/** One answered turn in Orbit's layout: fold line, work, answer, footer. */
const AssistantTurn = memo(
  function AssistantTurn({ items, tools, streaming, startedAt, elapsedMs, activity }: AssistantTurnProps) {
    const turn = useMemo(() => projectTurn(items, tools, streaming), [items, tools, streaming]);
    const [workOverride, setWorkOverride] = useState<boolean | null>(null);
    const liveElapsed = useElapsed(startedAt, streaming);
    const hasWork = turn.work.length > 0 || Boolean(activity);
    const answered = turn.answer.length > 0;
    // Work folds behind the "worked for" line. While a turn is running the fold
    // opens on its own to the phase rows ("正在运行 7 条命令") — that is the
    // heading the reader is watching — but each phase keeps its own steps shut
    // until someone asks for them. Once the turn settles the whole fold closes
    // again, leaving just the timer. The reader's own toggle always wins.
    const workOpen = workOverride ?? streaming;
    // Only matter when the answer is actually sitting under it. The fold's own
    // rows and the answer share the same left edge, so with the fold expanded
    // and only a few pixels between them the answer reads as one more step.
    // The gap is what makes it "jump out" of Working.
    const workVisible = hasWork && workOpen;
    const duration = elapsedMs ?? (streaming ? liveElapsed : null);
    const foldTitle = streaming ? (
      <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>
        {formatWorkingDuration(liveElapsed, undefined, false)}
      </Shimmer>
    ) : (
      formatWorkingDuration(duration, undefined, true)
    );
    const answerText = turn.answer.flatMap((step) => (step.kind === "note" && step.text ? [step.text] : [])).join("\n\n");
    const lastTime = messageTime(turn.last?.message) ?? (startedAt != null && duration != null ? startedAt + duration : undefined);

    if (turn.specials.length && !turn.work.length && !turn.answer.length) {
      return (
        <div className="transcript-turn flex min-w-0 flex-col">
          {turn.specials.map((item) =>
            item.message.role === "bashExecution" ? <BashExecution key={item.id} message={item.message} /> : <CompactionNotice key={item.id} message={item.message} />,
          )}
        </div>
      );
    }

    return (
      <div className={`transcript-turn flex min-w-0 flex-col${streaming ? " transcript-turn-live" : ""}`}>
        {turn.specials.map((item) =>
          item.message.role === "bashExecution" ? <BashExecution key={item.id} message={item.message} /> : <CompactionNotice key={item.id} message={item.message} />,
        )}
        {hasWork || streaming ? (
          <TurnRow folded={false}>
            <WorkFoldLine title={foldTitle} live={streaming} expandable={hasWork} open={workOpen && hasWork} onToggle={() => setWorkOverride(!workOpen)} />
          </TurnRow>
        ) : null}
        {hasWork ? (
          <TurnRow folded={!workOpen}>
            {() => (
              <div className="zen-fold-rail zen-fold-tail flow-root pl-5">
                <ActivityPhases steps={turn.work} tools={tools} done={!streaming || answered} />
                {/* The worker feed is part of this fold, not a sibling of it: it
                    renders inside the same rail so collapsing "Working…" hides
                    it too. No extra padding, or its rows would sit to the right
                    of the activity steps they belong with. */}
                {activity ?? null}
              </div>
            )}
          </TurnRow>
        ) : null}
        {turn.images.length ? (
          <div className="flex min-w-0 flex-col px-4 pb-1">
            {turn.images.map((step) => (
              <GeneratedImageStep key={step.key} part={step.part!} tools={tools} />
            ))}
          </div>
        ) : null}
        {turn.answer.map((step, index) =>
          step.kind === "note" ? (
            <div
              key={step.key}
              data-selectable-agent-response={streaming ? undefined : step.key}
              data-chat-message={step.key}
              data-chat-message-role="assistant"
              className={`min-w-0 px-4 pb-1 text-content ${index === 0 ? (workVisible ? "pt-5" : "pt-3") : "pt-3"}`}
            >
              <Markdown content={step.text ?? ""} animated={streaming && step.live} links="panel" />
            </div>
          ) : (
            <div key={step.key} className="px-4 py-1">
              <StepRow step={step} tools={tools} />
            </div>
          ),
        )}
        {turn.last?.message.errorMessage && !streaming ? <ErrorRow error={turn.last.message.errorMessage} /> : null}
        {!streaming && (answered || hasWork) ? (
          <TurnFooter
            copyText={answerText}
            last={turn.last?.message}
            label={formatWorkingDuration(duration, undefined, true)}
            labelHidden={hasWork}
            completedAt={lastTime}
          />
        ) : null}
      </div>
    );
  },
  (previous, next) => {
    if (
      previous.streaming !== next.streaming ||
      previous.elapsedMs !== next.elapsedMs ||
      previous.startedAt !== next.startedAt ||
      previous.modelName !== next.modelName ||
      previous.activity !== next.activity ||
      previous.items.length !== next.items.length ||
      previous.items.some((item, index) => item !== next.items[index])
    )
      return false;
    if (previous.tools === next.tools) return true;
    // Settled turns only re-render when one of their own tools changed.
    for (const item of previous.items) {
      const content = item.message.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) if (part.type === "toolCall" && previous.tools[part.id ?? ""] !== next.tools[part.id ?? ""]) return false;
    }
    return true;
  },
);

export type TranscriptGroup = {
  id: string;
  items: DisplayMessage[];
  startedAt?: number;
  elapsedMs?: number;
};

export const TranscriptGroupView = memo(function TranscriptGroupView({
  group,
  tools,
  streaming,
  modelName,
  activity,
}: {
  group: TranscriptGroup;
  tools: Record<string, Tool>;
  streaming: boolean;
  modelName?: string;
  activity?: ReactNode;
}) {
  const first = group.items[0];
  if (first?.message.role === "user") {
    // The turn that owns the newest prompt reserves a pane of height, so the
    // prompt sits at the top with room for the answer below it (Orbit keeps
    // prompt and answer in one turn; our groups are per message).
    return (
      <div className="transcript-turn flex min-w-0 flex-col">
        {group.items.map((item) => (
          <UserMessage key={item.id} item={item} />
        ))}
      </div>
    );
  }
  return (
    <AssistantTurn
      items={group.items}
      tools={tools}
      streaming={streaming}
      startedAt={group.startedAt}
      elapsedMs={group.elapsedMs}
      modelName={modelName}
      activity={activity}
    />
  );
});

/** "Working…" before the first token arrives (Orbit `InitialThinking`). */
export function InitialWorking({ label, startedAt }: { label: string; startedAt?: number | null }) {
  const elapsed = useElapsed(startedAt ?? undefined, true);
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 px-4 py-1" role="status" aria-live="polite">
      <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>
        {elapsed != null && elapsed > 1000 ? `${label} ${Math.round(elapsed / 1000)}s` : label}
      </Shimmer>
    </div>
  );
}

/**
 * 会话加载中的骨架屏（`transcript.loading`）。形状照着对话走：一段提问加一段回答。
 * 切换会话时先把位置占住，hydrate 上来再换内容，不会先把上一个会话的内容留在原地
 * 再突然抽掉。
 *
 * 占位块是静态的：桌面端本地读取很快，呼吸/渐隐动画只会把一次几十毫秒的加载
 * 放大成一次看得见的重绘，也白白让合成器在加载期间一直跑。
 */
export function TranscriptSkeleton() {
  // 每段宽度差一点，避免像同一行复制了三遍。
  const blocks = [
    { ask: "w-[38%]", lines: ["w-full", "w-[92%]", "w-[74%]"] },
    { ask: "w-[26%]", lines: ["w-full", "w-[81%]", "w-[95%]", "w-[58%]"] },
  ];
  return (
    <div
      data-transcript-skeleton
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-6 px-4 pt-6"
    >
      <span className="sr-only">正在加载会话…</span>
      {blocks.map((block) => (
        <div key={block.ask} className="flex min-w-0 flex-col gap-2">
          <div className={`h-4 rounded-md bg-content/6 ${block.ask}`} />
          {block.lines.map((width) => (
            <div key={width} className={`h-3.5 rounded-md bg-content/6 ${width}`} />
          ))}
        </div>
      ))}
      <div className="h-4 w-[31%] rounded-md bg-content/6" />
    </div>
  );
}

export { workSummaryLine };
