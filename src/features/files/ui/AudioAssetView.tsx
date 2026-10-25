import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, Play } from "../../../shared/ui/icons";
import { formatBytes, type MediaKind } from "../../../lib/media";
import { useMediaSrc } from "./media-source";

/**
 * 音频资源的查看器。
 *
 * monocode 的 `BinaryFileView` 只处理图片和视频，音频没有参照，所以这里按它
 * 那套**解剖结构**来设计：内容区放一张卡（封面 + 播放），底部一条 `h-8` 的
 * 事实栏，和 `ImageAssetView` 的页脚一模一样——图片报 `宽 × 高 · 体积 · 格式`，
 * 音频报 `时长 · 体积 · 格式`。事实只说一遍，卡里不再重复一遍 `MPEG · 2.7 MB`。
 *
 * 进度条不是原生 `input[type=range]`：WKWebView 会把它画成一颗亮的胶囊，
 * 和这身灰调对不上。自己画一条 1px 的轨道，悬停才浮出把手，拖动按指针算位置。
 */
export function AudioAssetView({
  src,
  name,
  bytes,
  format,
}: {
  src: string | null;
  name: string;
  bytes?: number;
  /** `audio/mpeg` 或 `mpeg`；页脚统一大写。 */
  format?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
  }, [src]);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setPlaying(true);
      } catch {
        setError("无法播放：请检查文件的格式或编码");
      }
    } else {
      audio.pause();
      setPlaying(false);
    }
  }, []);

  const seek = useCallback(
    (next: number) => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(next)) return;
      audio.currentTime = Math.max(0, Math.min(duration || 0, next));
      setTime(audio.currentTime);
    },
    [duration],
  );

  /** 指针落在轨道上就算进度：按下即定位，按住拖动跟着走。 */
  const seekFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const apply = (clientX: number) => {
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        seek(ratio * duration);
      };
      apply(event.clientX);
      const onMove = (move: PointerEvent) => apply(move.clientX);
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [duration, seek],
  );

  const ratio = duration > 0 ? Math.min(1, time / duration) : 0;
  const label = format?.replace(/^audio\//, "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <audio
        ref={audioRef}
        src={src ?? undefined}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setTime(0);
        }}
        onError={() => setError("无法加载：请检查文件的格式或文件是否完整")}
        className="hidden"
      />

      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-content/2 p-6">
        <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-content/10 bg-content/[0.045] px-5 py-4">
          <div className="flex items-center gap-3.5">
            {/* 封面：文件名决定色相，同一首歌每次都是同一块颜色。 */}
            <div
              className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg text-content"
              style={{ background: coverGradient(name) }}
            >
              <span className="absolute inset-0 opacity-25 [background-image:radial-gradient(circle_at_30%_18%,white_0,transparent_58%)]" />
              <span className="relative text-xl leading-none">♪</span>
            </div>
            {/* 名字单独占满一行，长的歌名不会再被播放键挤成省略号。 */}
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-content" title={name}>
              {name}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void toggle()}
              aria-label={playing ? "暂停" : "播放"}
              aria-pressed={playing}
              disabled={src == null}
              className="grid size-9 shrink-0 place-items-center rounded-full bg-content text-background-base transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
            >
              {playing ? <Pause className="size-3.5" strokeWidth={2.25} /> : <Play className="size-3.5 translate-x-px" strokeWidth={2.25} />}
            </button>
            <span className="w-9 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-content/45">
              {formatAudioTime(time)}
            </span>
            <div
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="音频进度"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(time)}
              aria-valuetext={`${formatAudioTime(time)} / ${formatAudioTime(duration)}`}
              onPointerDown={seekFromPointer}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  seek(time + (event.key === "ArrowRight" ? 5 : -5));
                } else if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  void toggle();
                }
              }}
              className="group relative h-4 min-w-0 flex-1 cursor-pointer touch-none"
            >
              <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-content/12" />
              <span
                className="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-content/70 group-hover:bg-content"
                style={{ width: `${ratio * 100}%` }}
              />
              <span
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-content opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                style={{ left: `${ratio * 100}%` }}
              />
            </div>
            <span className="w-9 shrink-0 font-mono text-[10.5px] tabular-nums text-content/45">
              {formatAudioTime(duration)}
            </span>
          </div>

          {error ? <p role="alert" className="text-[11px] text-red-300">{error}</p> : null}
        </div>
      </div>

      {/* 事实栏：和图片查看器的页脚同一套尺寸与分隔线。 */}
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-stroke px-3 text-[11px] text-content/50">
        <span className="tabular-nums">{formatAudioTime(duration)}</span>
        {bytes != null ? <span className="tabular-nums">{formatBytes(bytes)}</span> : null}
        {label ? <span className="uppercase">{label}</span> : null}
      </footer>
    </div>
  );
}

/** 按磁盘路径取字节再交给查看器：文件预览和音频 diff 共用这一个入口。 */
export function AudioAssetPreview({
  path,
  name,
  remote,
}: {
  path: string;
  name?: string;
  remote: boolean;
}) {
  const { src, meta, notice } = useMediaSrc(path, "audio" as MediaKind, remote);
  return (
    <AudioAssetView
      src={notice ? null : src}
      name={name ?? path.split(/[\\/]/).at(-1) ?? path}
      bytes={meta?.size}
      format={notice ? undefined : meta?.mime}
    />
  );
}

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** 文件名 → 一组稳定的深色渐变，让每首歌有自己的封面色。 */
function coverGradient(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue} 55% 42%) 0%, hsl(${(hue + 38) % 360} 45% 26%) 55%, hsl(${(hue + 70) % 360} 30% 16%) 100%)`;
}
