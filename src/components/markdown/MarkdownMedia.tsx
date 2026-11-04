import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { base64ToBytes } from "../../lib/image-bytes";
import { mediaKind, readMediaFile } from "../../lib/media";
import { useWorkspace } from "../../lib/store";
import { TriangleAlertIcon } from "lucide-react";
import { Pause, Play } from "../../shared/ui/icons";

/**
 * Markdown 里 `![alt](src)` 的落地形态。
 *
 * t3code 的规则这里照搬：图片语法不只画图片，按扩展名分派——`mp4/webm/mov`
 * 是 `<video controls>`，`wav/mp3/flac…` 是一行播放器，`png/gif/webp/svg…`
 * 才是 `<img>`。这样 agent 写 `![](demo.mp4)` 或 `![](music.wav)` 时得到的是能
 * 播的东西，而不是一张永远加载不出来的破图。
 *
 * 地址同样按 t3code 分两类：
 * - 网络地址（`https:`、`data:`、`blob:`、`//`）原样给 `<img>`；
 * - 工作区里的路径（相对、绝对、`file:`）在桌面走 Tauri asset 协议，在手机上
 *   走配对 socket 取字节再转 object URL——手机上没有"这台机器的磁盘"。
 */
type MediaKind = "image" | "video" | "audio" | "pdf";

type ResolvedSource =
  | { kind: "direct"; url: string; media: MediaKind }
  | { kind: "file"; path: string; media: MediaKind }
  | { kind: "blocked"; label: string };

const KIND_BY_EXTENSION: Record<string, MediaKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  avif: "image", bmp: "image", ico: "image", svg: "image",
  mp4: "video", m4v: "video", webm: "video", mov: "video", mkv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", m4a: "audio",
  flac: "audio", aac: "audio", opus: "audio", aiff: "audio",
  pdf: "pdf",
};

function extensionOf(value: string) {
  const path = value.split(/[?#]/, 1)[0] ?? value;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function mediaKindOf(value: string): MediaKind | null {
  const byExtension = KIND_BY_EXTENSION[extensionOf(value)];
  if (byExtension) return byExtension;
  const byMime = /^data:(image|video|audio|application\/pdf)/i.exec(value)?.[1]?.toLowerCase();
  if (byMime === "image" || byMime === "video" || byMime === "audio") return byMime;
  if (byMime === "application/pdf") return "pdf";
  return mediaKind(value);
}

function decodeFilePath(url: string) {
  const raw = url.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 把作者写的地址落到一个可渲染的来源上；分不清的一律不猜。 */
export function resolveMediaSource(raw: string, cwd: string): ResolvedSource {
  const source = raw.trim().replace(/^<(.*)>$/, "$1");
  if (!source) return { kind: "blocked", label: "" };

  const media = mediaKindOf(source) ?? "image";
  if (/^(?:https?:|data:|blob:|\/\/)/i.test(source)) {
    return { kind: "direct", url: source.startsWith("//") ? `https:${source}` : source, media };
  }
  if (/^file:/i.test(source)) return { kind: "file", path: decodeFilePath(source), media };
  // 没有工作区（artifact、独立预览）时按原样交给浏览器：那里没有"本机路径"
  // 可言，但同源的相对地址仍然能显示。
  if (!cwd) return { kind: "direct", url: source, media };

  const decoded = (() => {
    try {
      return decodeURIComponent(source.split(/[?#]/, 1)[0] ?? source);
    } catch {
      return source;
    }
  })();
  if (decoded.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(decoded)) {
    return { kind: "file", path: decoded, media };
  }
  const separator = cwd.includes("\\") ? "\\" : "/";
  return { kind: "file", path: `${cwd.replace(/[\\/]+$/, "")}${separator}${decoded}`, media };
}

/** 手机：文件在另一台机器上，只能通过配对 socket 要字节再转 object URL。 */
function RemoteLocalMedia(props: {
  path: string;
  media: MediaKind;
  alt: string;
  standalone: boolean;
  title?: string;
}) {
  const bytes = useQuery({
    queryKey: ["markdown-media-bytes", props.path],
    queryFn: () => readMediaFile(props.path),
    staleTime: 30_000,
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes.data) return;
    const next = URL.createObjectURL(new Blob([base64ToBytes(bytes.data.data)], { type: bytes.data.mime }));
    setObjectUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes.data]);
  return <MediaElement {...props} src={objectUrl} />;
}

export function MarkdownMediaUnavailable({ alt, detail }: { alt?: string; detail?: string }) {
  return (
    <span className="md-media-unavailable">
      <TriangleAlertIcon aria-hidden className="md-media-unavailable-icon" />
      {["媒体不可用", alt, detail].filter(Boolean).join(" · ")}
    </span>
  );
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function MarkdownAudio({ src, name }: { src: string | null; name: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) return <MarkdownMediaUnavailable alt={name} />;
  return (
    <span className="md-audio">
      <audio
        ref={ref}
        src={src ?? undefined}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="md-audio-play"
        aria-label={playing ? "暂停" : "播放"}
        onClick={() => {
          const audio = ref.current;
          if (!audio) return;
          if (audio.paused) {
            void audio.play().then(() => setPlaying(true)).catch(() => setFailed(true));
          } else {
            audio.pause();
            setPlaying(false);
          }
        }}
      >
        {playing ? <Pause aria-hidden className="md-audio-icon" /> : <Play aria-hidden className="md-audio-icon" />}
      </button>
      <span className="md-audio-name">{name}</span>
      {duration ? <span className="md-audio-duration">{formatDuration(duration)}</span> : null}
    </span>
  );
}

/** 作者在 title 里写的尺寸提示：`![x](a.png "=320x")`。 */
function sizeFromTitle(title: string | undefined) {
  const match = title ? /^=?\s*(\d+)\s*x\s*(\d+)?$/i.exec(title.trim()) : null;
  if (!match) return null;
  const width = Number(match[1]);
  const height = match[2] === undefined ? null : Number(match[2]);
  if (!width) return null;
  return height ? { width, height } : { width };
}

function MediaElement({
  media,
  src,
  alt,
  standalone,
  title,
  fallbackSrc,
}: {
  media: MediaKind;
  src: string | null;
  alt: string;
  standalone: boolean;
  title?: string;
  fallbackSrc?: string;
}) {
  const [failed, setFailed] = useState(false);
  const size = sizeFromTitle(title);
  const failedSrc = failed || src === null;

  if (media === "audio") {
    if (failedSrc) return <MarkdownMediaUnavailable alt={alt} />;
    return <MarkdownAudio src={src} name={alt || "audio"} />;
  }
  if (media === "video") {
    if (failedSrc) return <MarkdownMediaUnavailable alt={alt} />;
    return (
      <video
        className="md-media"
        src={src ?? undefined}
        controls
        preload="metadata"
        data-standalone={standalone ? "" : undefined}
        onError={() => setFailed(true)}
      />
    );
  }
  if (media === "pdf") {
    return (
      <a className="md-file-chip" href={src ?? fallbackSrc ?? "#"} target="_blank" rel="noreferrer">
        <span className="md-file-chip-label">{alt || src || "PDF"}</span>
      </a>
    );
  }

  if (failedSrc) return <MarkdownMediaUnavailable alt={alt} />;
  return (
    <img
      className="md-media"
      src={src ?? undefined}
      alt={alt}
      title={title}
      loading="lazy"
      decoding="async"
      data-standalone={standalone ? "" : undefined}
      style={size?.height ? { width: size.width, height: "auto" } : size ? { maxWidth: size.width } : undefined}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * asset 协议只在 Tauri 的 webview 里存在。在普通浏览器里打开同一份渲染
 * （开发页、测试）时 `convertFileSrc` 会抛错，一条消息不该因此整段消失，
 * 所以退化成原路径：图会加载失败，但排版和其余内容都还在。
 */
function assetSrc(path: string) {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/**
 * 本机文件。桌面直接把路径交给 asset 协议，同步就有地址，也不需要 query
 * 上下文；只有手机才走 `RemoteLocalMedia`（那里没有"这台机器的磁盘"）。
 */
function LocalMedia(props: {
  path: string;
  media: MediaKind;
  alt: string;
  standalone: boolean;
  title?: string;
}) {
  const remote = useWorkspace((state) => state.runtimeTarget === "mobile");
  if (remote) return <RemoteLocalMedia {...props} />;
  return <MediaElement {...props} src={assetSrc(props.path)} />;
}

export function MarkdownImage({
  src,
  alt,
  title,
  standalone,
}: {
  src?: string;
  alt?: string;
  title?: string;
  standalone?: boolean;
}) {
  const cwd = useWorkspace((state) => state.cwd);
  const resolved = src ? resolveMediaSource(src, cwd) : null;
  const label = alt ?? "";

  if (!resolved) return <MarkdownMediaUnavailable alt={label} />;
  if (resolved.kind === "blocked") return <MarkdownMediaUnavailable alt={label} detail={resolved.label} />;
  if (resolved.kind === "direct") {
    return (
      <MediaElement
        media={resolved.media}
        src={resolved.url}
        alt={label}
        standalone={standalone ?? false}
        title={title}
      />
    );
  }
  return (
    <LocalMedia
      path={resolved.path}
      media={resolved.media}
      alt={label}
      standalone={standalone ?? false}
      title={title}
    />
  );
}
