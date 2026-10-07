import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DisplayMessage, Part, PiMessage, Tool } from "../../lib/protocol";
import { formatTranscriptError, toolImageDataUrl, toolResultText } from "../../lib/protocol";
import { getToolCodePresentation } from "../../lib/changes";
import { branchFromMessage, report } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { Markdown } from "../../components/Markdown";
import { CodeChange } from "../../components/LazyCodeChange";
import { GridReveal } from "../../components/ui/grid-reveal";
import { ImageActionsMenu } from "../../components/chat/ImageActions";
import { Shimmer } from "../../shared/ui/Shimmer";
import {
  Bot,
  Check,
  ChevronRight,
  CircleDashed,
  Copy,
  CursorMagicSelection,
  GitBranch,
  Minus,
  PenLine,
  RefreshCw,
  Search,
  Terminal,
  Wrench,
  X,
} from "../../shared/ui/icons";
import { FileTypeIcon } from "../shell/FileTypeIcon";
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

function messageTime(message?: PiMessage) {
  const raw = message?.timestamp;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw < 1e12 ? raw * 1000 : raw;
}

/* ---------------------------------------------------------------- fold rows */

/** MonoCode `TurnRow`: animates a row into and out of the fold. */
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

/** The line a turn's work folds behind (MonoCode `WorkFoldLine`). */
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
  const text = proseSummary(step.text ?? "") || "Thinking";
  const pulse = step.live ? "zen-thinking-pulse" : "";
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "收起思考" : `展开思考：${text}`}
        onClick={() => setOpen((value) => !value)}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left"
      >
        <span className={`min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/75 ${pulse}`}>{text}</span>
      </button>
      {open ? (
        <div className="min-w-0 pb-2">
          <Markdown className="agent-reasoning" content={step.text ?? ""} />
        </div>
      ) : null}
    </div>
  );
}

function NoteRow({ step }: { step: TurnStep }) {
  const [open, setOpen] = useState(false);
  const text = proseSummary(step.text ?? "");
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="group flex min-w-0 items-center gap-1.5 py-1 text-left">
        <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/75">{text}</span>
      </button>
      {open ? (
        <div className="min-w-0 pb-2">
          <Markdown content={step.text ?? ""} />
        </div>
      ) : null}
    </div>
  );
}

/** A tool call in MonoCode's "<Verb> <file chip>" form; opens onto its result. */
function ToolRow({ part, tools }: { part: Part; tools: Record<string, Tool> }) {
  const [open, setOpen] = useState(false);
  const tool = tools[part.id ?? ""];
  const name = toolName(part, tools);
  const { action, target, file } = toolLabel(part, tools);
  const failed = Boolean(tool?.isError);
  const running = Boolean(tool?.running);
  const result = toolResultText(tool?.result);
  const request = part.argsText ?? JSON.stringify(part.arguments ?? {});
  const code = useMemo(
    () => (open ? getToolCodePresentation(name, part.arguments ?? {}, result, tool?.details) : {}),
    [open, name, part.arguments, result, tool?.details],
  );
  const fileName = target.split(/[\\/]/).filter(Boolean).at(-1) ?? target;
  const actionTone = failed ? "text-red-400" : "text-content/50";
  const targetTone = failed ? "text-red-400" : "text-content/70";
  const patch = tool?.details?.patch;
  const additions = patch ? patch.split("\n").filter((line) => /^\+(?!\+\+)/.test(line)).length : 0;
  const deletions = patch ? patch.split("\n").filter((line) => /^-(?!--)/.test(line)).length : 0;
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
            <CircleDashed className="zen-tool-spin size-3.5 text-content/40" strokeWidth={1.75} />
          ) : (
            <PhaseIcon kind={workCategory(name)} className={failed ? "text-red-400/70" : ""} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px]">
          <span className={`shrink-0 font-sans text-sm ${actionTone}`}>{action}</span>
          {target ? (
            file ? (
              <span className={`-my-0.5 flex min-w-0 max-w-full items-center gap-1 rounded bg-content/6 px-1 py-0.5 group-hover:bg-content/10 ${targetTone}`} title={target}>
                <FileTypeIcon name={fileName} isDir={false} />
                <span className="min-w-0 truncate">{target}</span>
              </span>
            ) : (
              <span className={`flex min-w-0 flex-1 items-center pl-1 ${targetTone}`} title={target}>
                <span className="min-w-0 truncate">{target}</span>
              </span>
            )
          ) : null}
          {additions || deletions ? (
            <span className="shrink-0 font-sans text-[11px] font-semibold tabular-nums">
              <span className="text-diff-add-fg">+{additions}</span> <span className="text-diff-del-fg">-{deletions}</span>
            </span>
          ) : null}
        </span>
        {failed ? <X className="size-3.5 shrink-0 text-red-400" strokeWidth={2} /> : null}
        <ChevronRight className={`size-3.5 shrink-0 text-content/35 opacity-0 transition-[opacity,transform] group-hover:opacity-100 ${open ? "rotate-90 opacity-100" : ""}`} strokeWidth={1.75} />
      </button>
      {open ? (
        <div className="min-w-0 pb-1.5">
          {code.request ? <CodeChange change={code.request} compact /> : null}
          {!code.request && !code.result ? (
            <pre className="mt-1 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-content/4 px-2.5 py-2 font-mono text-[12px] leading-5 text-content/55">{request}</pre>
          ) : null}
          {code.result && !running ? <CodeChange change={code.result} compact /> : null}
          {!code.result && (result || !running) ? (
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
  const sources = tool?.images?.length ? tool.images.map(toolImageDataUrl) : [null];
  if (tool?.isError) return <ToolRow part={part} tools={tools} />;
  return (
    <div className="tool-image-generation">
      {sources.map((src, index) => (
        <ImageActionsMenu key={`${part.id ?? "image"}-${index}`} dataUrl={src} path={tool?.image?.paths?.[index]} prompt={index === 0 ? prompt : undefined}>
          <GeneratedImage src={src} knownAspect={knownAspect} prompt={index === 0 ? prompt : undefined} />
        </ImageActionsMenu>
      ))}
    </div>
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
  return <GridReveal src={src} aspect={aspect} alt={prompt ?? "生成的图片"} caption={prompt} />;
}

function StepRow({ step, tools }: { step: TurnStep; tools: Record<string, Tool> }) {
  if (step.kind === "think") return <ThinkingRow step={step} />;
  if (step.kind === "note") return <NoteRow step={step} />;
  if (step.kind === "image" && step.part?.type === "toolCall") return <GeneratedImageStep part={step.part} tools={tools} />;
  if (step.kind === "image" && step.part) {
    const src = step.part.data ? `data:${step.part.mimeType};base64,${step.part.data}` : step.part.url;
    return src ? <img className="message-image my-1" src={src} alt="会话附件" decoding="async" /> : null;
  }
  if (step.part) return <ToolRow part={step.part} tools={tools} />;
  return null;
}

/** MonoCode `ActivityPhaseGroup`. */
function PhaseGroup({ phase, tools, active }: { phase: Phase; tools: Record<string, Tool>; active: boolean }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  const title = phaseTitle(phase, tools, active);

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
  const label = active ? (
    <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>{title}</Shimmer>
  ) : (
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/80">{title}</span>
  );
  if (phase.steps.length === 0) {
    return (
      <div className="flex min-w-0 flex-col">
        <button type="button" aria-expanded={open} onClick={() => setOverride(!open)} className="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left">
          <PhaseIcon kind={phase.kind} />
          {label}
        </button>
        {open && phase.headline?.text ? (
          <div className="pb-2 pl-5">
            <Markdown content={phase.headline.text} />
          </div>
        ) : null}
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
          <div className={active ? "zen-phase-live" : undefined}>
            <div className="flex min-w-0 flex-col">
              {override === true && phase.headline?.text ? (
                <div className="zen-phase-step py-1">
                  <Markdown content={phase.headline.text} />
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

const ActivityPhases = memo(function ActivityPhases({ steps, tools, done }: { steps: TurnStep[]; tools: Record<string, Tool>; done: boolean }) {
  const phases = useMemo(() => buildPhases(steps, tools), [steps, tools]);
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4">
      {phases.map((phase, index) => (
        <PhaseGroup key={phase.key || index} phase={phase} tools={tools} active={!done && index === phases.length - 1} />
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

/** MonoCode `TurnDuration`: copy · branch · • model worked for · • time. */
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

/** MonoCode `UserMessageBlock` in its chat layout. */
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
            {photos.map((src) => (
              <img key={src.slice(0, 64)} src={src} alt="附件" decoding="async" className="max-h-48 max-w-[14rem] rounded-xl object-cover" />
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
          <Markdown className="agent-reasoning" content={summary} />
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

/** One answered turn in MonoCode's layout: fold line, work, answer, footer. */
const AssistantTurn = memo(
  function AssistantTurn({ items, tools, streaming, startedAt, elapsedMs, activity }: AssistantTurnProps) {
    const turn = useMemo(() => projectTurn(items, tools, streaming), [items, tools, streaming]);
    const [workOverride, setWorkOverride] = useState<boolean | null>(null);
    const liveElapsed = useElapsed(startedAt, streaming);
    const hasWork = turn.work.length > 0 || Boolean(activity);
    const answered = turn.answer.length > 0;
    // Work stays open while the agent is still working; once it has answered,
    // it folds behind the "worked for" line (MonoCode `foldableWork`).
    const workOpen = workOverride ?? (streaming && !answered);
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
                {activity ? <div className="px-4 py-1">{activity}</div> : null}
              </div>
            )}
          </TurnRow>
        ) : null}
        {turn.answer.map((step, index) =>
          step.kind === "note" ? (
            <div
              key={step.key}
              data-selectable-agent-response={streaming ? undefined : step.key}
              data-chat-message={step.key}
              data-chat-message-role="assistant"
              className={`min-w-0 px-4 pb-1 text-content ${index === 0 && hasWork ? "pt-1" : "pt-3"}`}
            >
              <Markdown content={step.text ?? ""} animated={streaming && step.live} />
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

export function TranscriptGroupView({
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
    // prompt sits at the top with room for the answer below it (MonoCode keeps
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
}

/** "Working…" before the first token arrives (MonoCode `InitialThinking`). */
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

export { workSummaryLine };
