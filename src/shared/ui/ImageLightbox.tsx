import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";
import { X } from "./icons";

type Props = {
  src: string;
  alt: string;
  onClose: () => void;
};

const MIN_SCALE = 1;
const MAX_SCALE = 8;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 图片灯箱（monocode 的手势集）：
 * - 滚轮 / ⌘滚轮 / 触控板捏合（ctrl+wheel）以光标为中心缩放
 * - 放大后拖拽平移（自动限位）
 * - 双击在 1x / 2x 间切换；+/−/0 缩放与复位；Esc 关闭
 */
export function ImageLightbox({ src, alt, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const zoomAt = useCallback((clientX: number, clientY: number, nextScale: number) => {
    const stage = document.querySelector<HTMLElement>("[data-lightbox-stage]");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const current = scaleRef.current;
    const next = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    // 光标下的图像点保持不动：offset' = cursor - center - imagePoint * next
    const imageX = (clientX - center.x - offsetRef.current.x) / current;
    const imageY = (clientY - center.y - offsetRef.current.y) / current;
    setScale(next);
    if (next <= MIN_SCALE) {
      setOffset({ x: 0, y: 0 });
      return;
    }
    setOffset({
      x: clientX - center.x - imageX * next,
      y: clientY - center.y - imageY * next,
    });
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        reset();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomAt(window.innerWidth / 2, window.innerHeight / 2, scaleRef.current * 1.4);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        zoomAt(window.innerWidth / 2, window.innerHeight / 2, scaleRef.current / 1.4);
      }
    };

    // 滚轮与触控板捏合（ctrl+wheel）都走光标为中心的缩放。
    const onWheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-lightbox-stage]")) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      zoomAt(event.clientX, event.clientY, scaleRef.current * factor);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("wheel", onWheel);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [reset, zoomAt]);

  // 缩放变化后把平移限制在「图像仍有一点留在视野内」的范围内。
  useEffect(() => {
    if (scale <= MIN_SCALE) {
      setOffset({ x: 0, y: 0 });
      return;
    }
    const stage = document.querySelector<HTMLElement>("[data-lightbox-stage]");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const limitX = (rect.width * scale) / 2 + 80;
    const limitY = (rect.height * scale) / 2 + 80;
    setOffset((current) => ({
      x: clamp(current.x, -limitX, limitX),
      y: clamp(current.y, -limitY, limitY),
    }));
  }, [scale]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${alt}`}
      data-lightbox-stage
      className="fixed inset-0 flex items-center justify-center overflow-hidden bg-black/85 p-6 backdrop-blur-sm"
      style={{ zIndex: LAYER.dialog, cursor: scale > 1 ? (grabbing ? "grabbing" : "grab") : undefined }}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        // 放大时点背景先复位，避免误关。
        if (scale > 1) reset();
        else onClose();
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (scale <= 1 || event.button !== 0) return;
        dragging.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        setGrabbing(true);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        setOffset({ x: event.clientX - dragging.current.x, y: event.clientY - dragging.current.y });
      }}
      onPointerUp={(event) => {
        dragging.current = null;
        setGrabbing(false);
        if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) {
          (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
        }
      }}
      onDoubleClick={(event) => {
        if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.lightboxImage) return;
        if (scale > 1) reset();
        else zoomAt(event.clientX, event.clientY, 2);
      }}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        data-lightbox-image="true"
        className="max-h-full max-w-full select-none object-contain shadow-2xl"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: dragging.current ? "none" : "transform 0.12s ease-out",
        }}
      />
      <button
        ref={closeRef}
        type="button"
        aria-label="Close image preview"
        title="Close"
        onClick={onClose}
        className="absolute right-4 top-4 grid size-9 place-items-center rounded-full border border-white/15 bg-black/45 text-white/80 shadow-lg backdrop-blur-md hover:bg-black/65 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
      >
        <X className="size-4" strokeWidth={2} />
      </button>
      <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/55 px-3 py-1 text-[11px] leading-5 text-white/70 backdrop-blur-md">
        {Math.round(scale * 100)}%{scale > 1 ? " · 拖拽平移" : ""} · 滚轮缩放 · 双击放大 · 0 复位
      </div>
    </div>,
    document.body,
  );
}
