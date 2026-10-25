import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, ImagePlus, Minus, Plus } from "../../../shared/ui/icons";
import { formatBytes, type MediaKind } from "../../../lib/media";
import { useMediaSrc } from "./media-source";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.5;

type Zoom = number | "fit";
/** 缩放后必须留在同一个客户端坐标下的图像点。 */
type ZoomAnchor = { imageX: number; imageY: number; clientX: number; clientY: number };

/**
 * 图片资源的查看器（monocod `BinaryFileView` 的 `ImageView`）。
 *
 * 样式和交互都是照搬的：
 * - 底纹是 16px 的棋盘格，透明 PNG 才读得出「透明」，而不是读成主题背景；
 * - 页脚 h-8、11px、`内容/50`，从左到右是 `宽 × 高`、体积、格式，右边是缩放组；
 * - 点图片在「适应窗口」和 100% 之间切换；
 * - ⌘/Ctrl + 滚轮以指针为锚点缩放，缩放后指针下的那个点不动；
 * - 悬停时 ⌘+ / ⌘- / ⌘0 生效，并且不会漏到应用层去。
 */
export function ImageAssetView({
  src,
  name,
  bytes,
  format,
  remoteUnavailable,
}: {
  src: string | null;
  name: string;
  bytes?: number;
  /** `image/png` 或 `png`；页脚统一显示大写。 */
  format?: string;
  remoteUnavailable?: string | null;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoomState] = useState<Zoom>("fit");
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef<Zoom>(zoom);
  const anchorRef = useRef<ZoomAnchor | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const setZoom = useCallback((next: Zoom) => {
    anchorRef.current = null;
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  /** 实际渲染比例，把「适应窗口」也算成当前的那个倍数。 */
  const currentScale = useCallback(() => {
    const value = zoomRef.current;
    if (value !== "fit") return value;
    const image = imageRef.current;
    if (!image?.naturalWidth) return 1;
    return image.getBoundingClientRect().width / image.naturalWidth;
  }, []);

  // 缩放到让 (clientX, clientY) 下面的那个图像点留在原地。
  const zoomAt = useCallback(
    (next: number, clientX: number, clientY: number) => {
      const image = imageRef.current;
      if (!image) return;
      const scale = currentScale();
      const rect = image.getBoundingClientRect();
      setZoom(clampZoom(next));
      anchorRef.current = {
        imageX: (clientX - rect.left) / scale,
        imageY: (clientY - rect.top) / scale,
        clientX,
        clientY,
      };
    },
    [currentScale, setZoom],
  );

  const zoomAtCenter = useCallback(
    (next: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      zoomAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    [zoomAt],
  );

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const image = imageRef.current;
    const scroller = scrollerRef.current;
    anchorRef.current = null;
    if (!anchor || !image || !scroller || zoom === "fit") return;
    const rect = image.getBoundingClientRect();
    scroller.scrollLeft += rect.left + anchor.imageX * zoom - anchor.clientX;
    scroller.scrollTop += rect.top + anchor.imageY * zoom - anchor.clientY;
  }, [zoom]);

  // ⌘/Ctrl + 滚轮缩放；普通滚轮仍然平移。
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const factor = Math.exp(-event.deltaY * unit * 0.01);
      zoomAt(currentScale() * factor, event.clientX, event.clientY);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [currentScale, zoomAt]);

  // 指针在预览里时，缩放键归图片，不归应用。
  useEffect(() => {
    if (!hovered) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key;
      if (key !== "+" && key !== "=" && key !== "-" && key !== "0") return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "0") {
        setZoom("fit");
        return;
      }
      // 指针在图上时以它为中心，和滚轮缩放同一个锚点。
      const next = currentScale() * (key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP);
      const pointer = pointerRef.current;
      if (pointer) zoomAt(next, pointer.x, pointer.y);
      else zoomAtCenter(next);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [hovered, currentScale, setZoom, zoomAt, zoomAtCenter]);

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyPath = useCallback(() => {
    void navigator.clipboard?.writeText(name).then(
      () => {
        setCopied(true);
        if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, [name]);

  if (remoteUnavailable) return <AssetNotice message={remoteUnavailable} path={name} />;

  const label = format?.replace(/^image\//, "");

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-image-zoom={hovered ? "" : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        pointerRef.current = null;
      }}
      onPointerMove={(event) => {
        pointerRef.current = { x: event.clientX, y: event.clientY };
      }}
    >
      <div
        ref={scrollerRef}
        className="grid min-h-0 flex-1 place-items-center overflow-auto overscroll-contain p-4"
        style={{
          // 棋盘格：让透明 PNG 读成透明，而不是读成主题背景。
          backgroundImage:
            "linear-gradient(45deg, rgba(128,128,128,0.10) 25%, transparent 25%, transparent 75%, rgba(128,128,128,0.10) 75%), linear-gradient(45deg, rgba(128,128,128,0.10) 25%, transparent 25%, transparent 75%, rgba(128,128,128,0.10) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 8px 8px",
        }}
      >
        {src == null ? (
          <span className="text-[12px] text-content/45">打开 {name}…</span>
        ) : (
          <img
            ref={imageRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(event) =>
              setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })
            }
            onClick={(event) => {
              if (zoomRef.current === "fit") zoomAt(1, event.clientX, event.clientY);
              else setZoom("fit");
            }}
            className={
              zoom === "fit"
                ? "max-h-full max-w-full cursor-zoom-in object-contain"
                : "max-w-none cursor-zoom-out object-contain"
            }
            style={
              zoom === "fit" || !natural
                ? undefined
                : { width: natural.w * zoom, height: natural.h * zoom }
            }
          />
        )}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-stroke px-3 text-[11px] text-content/50">
        <span className="tabular-nums">{natural ? `${natural.w} × ${natural.h}` : "—"}</span>
        {bytes != null ? <span className="tabular-nums">{formatBytes(bytes)}</span> : null}
        {label ? <span className="uppercase">{label}</span> : null}
        <span className="flex-1" />
        <ZoomButton label={copied ? "已复制文件名" : "复制文件名"} onClick={copyPath}>
          {copied ? <Check className="size-3" strokeWidth={2} /> : <Copy className="size-3" strokeWidth={1.75} />}
        </ZoomButton>
        <ZoomButton label="缩小" onClick={() => zoomAtCenter(currentScale() / ZOOM_STEP)}>
          <Minus className="size-3" strokeWidth={1.75} />
        </ZoomButton>
        <button
          type="button"
          title="适应窗口"
          onClick={() => setZoom("fit")}
          className="w-11 rounded text-center tabular-nums hover:text-content"
        >
          {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
        </button>
        <ZoomButton label="放大" onClick={() => zoomAtCenter(currentScale() * ZOOM_STEP)}>
          <Plus className="size-3" strokeWidth={1.75} />
        </ZoomButton>
      </footer>
    </div>
  );
}

/** 按磁盘路径取字节再交给查看器：文件预览和图片 diff 共用这一个入口。 */
export function ImageAssetPreview({
  path,
  name,
  remote,
}: {
  path: string;
  /** 显示用的名字；默认取路径末段。 */
  name?: string;
  remote: boolean;
}) {
  const { src, meta, notice, fetching } = useMediaSrc(path, "image" as MediaKind, remote);
  return (
    <ImageAssetView
      src={notice ? null : src}
      name={name ?? path.split(/[\\/]/).at(-1) ?? path}
      bytes={meta?.size}
      format={meta?.mime}
      remoteUnavailable={notice ?? (src == null && !fetching ? `无法读取 ${path}` : null)}
    />
  );
}

/** 读不到这张图时的一块说明，形状和文件预览里的那块一致。 */
function AssetNotice({ message, path }: { message: string; path: string }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-content/10 bg-content/4 px-6 py-8 text-center">
        <ImagePlus className="size-8 text-content/25" strokeWidth={1.5} />
        <p className="text-[13px] leading-5 text-content/70">{message}</p>
        <p className="break-all font-mono text-[11px] leading-4 text-content/40">{path}</p>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-5 place-items-center rounded hover:bg-content/10 hover:text-content"
    >
      {children}
    </button>
  );
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}
