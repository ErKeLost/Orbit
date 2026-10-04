import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { RpcSessionState } from "../../lib/protocol";
import { mountEffortPixelField } from "./effort-pixel-field";
import {
  effortColorsForLevels,
  effortFieldMode,
  effortLabel,
  effortVisualSlot,
  magnetizeEffort,
} from "./effort-slider-model";
import "./effort-slider.css";

type EffortSliderProps = {
  levels: ThinkingLevel[];
  value?: ThinkingLevel;
  disabled?: boolean;
  onChange: (level: ThinkingLevel) => void;
};

type ThinkingLevel = NonNullable<RpcSessionState["thinkingLevel"]>;

type EffortStyle = CSSProperties & {
  "--ds-effort-progress": number;
  "--fill-x": string;
  "--ds-effort-level-color": string;
  "--ds-effort-level-soft": string;
  "--ds-effort-level-deep": string;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 每个思考档位之间再插 3 个小点，让刻度看起来更密。 */
const TICKS_PER_LEVEL = 3;

function moveLight(event: PointerEvent<HTMLElement>) {
  const track = event.currentTarget.querySelector<HTMLElement>(".effort-slider-track");
  if (!track) return;
  const rect = track.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  const y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
  const distance = Math.max(
    event.clientY < rect.top ? rect.top - event.clientY : Math.max(0, event.clientY - rect.bottom),
    event.clientX < rect.left ? rect.left - event.clientX : Math.max(0, event.clientX - rect.right),
  );
  event.currentTarget.style.setProperty("--light-x", `${(x * 100).toFixed(1)}%`);
  event.currentTarget.style.setProperty("--light-y", `${(y * 100).toFixed(1)}%`);
  event.currentTarget.style.setProperty("--light-strength", clamp(1 - distance / 70, 0, 1).toFixed(3));
}

function clearLight(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.setProperty("--light-strength", "0");
}

function valueFromPointer(root: HTMLElement | null, clientX: number, maxIndex: number) {
  if (!root || maxIndex <= 0) return 0;
  const track = root.querySelector<HTMLElement>(".effort-slider-track");
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  const thumbWidth = Number.parseFloat(getComputedStyle(root).getPropertyValue("--ds-effort-thumb-w")) || 24;
  const thumbInset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--ds-effort-thumb-inset")) || 2;
  const centerInset = thumbInset + thumbWidth * 0.5;
  const progress = clamp((clientX - rect.left - centerInset) / Math.max(1, rect.width - centerInset * 2), 0, 1);
  return progress * maxIndex;
}

export function EffortSlider({ levels, value, disabled, onChange }: EffortSliderProps) {
  const maxIndex = Math.max(0, levels.length - 1);
  const selectedIndex = Math.max(0, levels.indexOf(value ?? levels[0]));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const activeIndexRef = useRef(selectedIndex);
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const continuousValueRef = useRef(selectedIndex);
  const progressRef = useRef(maxIndex ? selectedIndex / maxIndex : 0.5);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartRef = useRef(0);
  const lastCommittedRef = useRef(value);
  const activeLevel = levels[activeIndex];
  const activeVisualSlot = effortVisualSlot(activeLevel);
  const fieldMode = effortFieldMode(activeLevel);
  const initialColors = effortColorsForLevels(levels, selectedIndex);
  const magnetTargets = levels.map((_, index) => index);
  const tickCount = maxIndex ? maxIndex * TICKS_PER_LEVEL + 1 : 1;
  const litProgress = maxIndex ? activeIndex / maxIndex : 0;
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const levelIndex = index / TICKS_PER_LEVEL;
    const aligned = Number.isInteger(levelIndex);
    return {
      progress: tickCount > 1 ? index / (tickCount - 1) : 0.5,
      aligned,
      level: aligned ? levels[Math.min(levelIndex, maxIndex)] : undefined,
    };
  });

  const applyVisual = useCallback((nextValue: number) => {
    const safeValue = clamp(Number.isFinite(nextValue) ? nextValue : 0, 0, maxIndex);
    const nextIndex = clamp(Math.round(safeValue), 0, maxIndex);
    const nextLevel = levels[nextIndex];
    const nextVisualSlot = effortVisualSlot(nextLevel);
    const nextMode = effortFieldMode(nextLevel);
    const progress = maxIndex ? safeValue / maxIndex : 0.5;
    const colors = effortColorsForLevels(levels, safeValue);
    continuousValueRef.current = safeValue;
    progressRef.current = progress;
    if (inputRef.current) {
      inputRef.current.value = String(safeValue);
      inputRef.current.setAttribute("aria-valuetext", effortLabel(nextLevel));
    }
    const root = rootRef.current;
    if (root) {
      root.style.setProperty("--ds-effort-progress", String(progress));
      root.style.setProperty("--fill-x", `${(progress * 100).toFixed(1)}%`);
      root.style.setProperty("--ds-effort-level-color", colors.base);
      root.style.setProperty("--ds-effort-level-soft", colors.soft);
      root.style.setProperty("--ds-effort-level-deep", colors.deep);
      root.dataset.level = String(nextVisualSlot);
      root.toggleAttribute("data-glow", nextVisualSlot >= 3);
      root.toggleAttribute("data-max", nextMode === "max");
      root.toggleAttribute("data-field", nextMode === "high" || nextMode === "extra");
      root.setAttribute("data-pixels-ready", "");
    }
    if (activeIndexRef.current !== nextIndex) {
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
    }
  }, [levels, maxIndex]);

  const commit = useCallback((target = Math.round(continuousValueRef.current)) => {
    const snapped = clamp(target, 0, maxIndex);
    applyVisual(snapped);
    const next = levels[snapped];
    if (next && next !== lastCommittedRef.current) {
      lastCommittedRef.current = next;
      onChange(next);
    }
  }, [applyVisual, levels, maxIndex, onChange]);

  useEffect(() => mountEffortPixelField({
    canvasRef,
    thumbRef,
    continuousValueRef: progressRef,
    mode: fieldMode,
    active: true,
    dragging: draggingRef,
  }), [fieldMode]);

  useEffect(() => {
    if (draggingRef.current) return;
    lastCommittedRef.current = value;
    applyVisual(Math.max(0, levels.indexOf(value ?? levels[0])));
  }, [applyVisual, levels, value]);

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? 1 : null;
    const target = event.key === "Home" ? 0 : event.key === "End" ? maxIndex : direction == null ? null : clamp(activeIndex + direction, 0, maxIndex);
    if (target == null) return;
    event.preventDefault();
    commit(target);
  };

  if (levels.length < 2) return null;
  const style: EffortStyle = {
    "--ds-effort-progress": maxIndex ? selectedIndex / maxIndex : 0.5,
    "--fill-x": `${((maxIndex ? selectedIndex / maxIndex : 0.5) * 100).toFixed(1)}%`,
    "--ds-effort-level-color": initialColors.base,
    "--ds-effort-level-soft": initialColors.soft,
    "--ds-effort-level-deep": initialColors.deep,
  };
  return (
    <section
      ref={rootRef}
      className="effort-slider"
      data-disabled={disabled || undefined}
      data-glow={activeVisualSlot >= 3 ? "" : undefined}
      data-level={activeVisualSlot}
      data-max={fieldMode === "max" ? "" : undefined}
      data-pixels-ready=""
      onPointerMove={moveLight}
      onPointerLeave={clearLight}
      style={style}
    >
      <div className="effort-slider-shell">
        <div className="effort-slider-track" aria-hidden>
          <div className="effort-slider-fill" />
          <div className="effort-slider-max-fallback" />
          <canvas ref={canvasRef} className="effort-slider-pixels" />
          <div className="effort-slider-ticks">
            {ticks.map((tick, index) => (
              <i
                className={tick.progress <= litProgress + 0.0001 ? "on" : ""}
                data-level-tick={tick.aligned || undefined}
                data-max-tick={tick.level && effortFieldMode(tick.level) === "max" ? "" : undefined}
                style={{ "--tick-progress": tick.progress } as CSSProperties}
                key={index}
              />
            ))}
          </div>
          <div className="effort-slider-light" />
          <div className="effort-slider-thumb-light" />
          <div ref={thumbRef} className="effort-slider-thumb" />
        </div>
        <div className="effort-slider-outline" aria-hidden />
        <input
          ref={inputRef}
          type="range"
          min={0}
          max={maxIndex}
          step={0.001}
          defaultValue={selectedIndex}
          disabled={disabled}
          aria-label="思考强度"
          aria-valuetext={effortLabel(activeLevel)}
          onPointerDown={event => {
            if (disabled) return;
            event.preventDefault();
            event.currentTarget.focus();
            pointerIdRef.current = event.pointerId;
            pointerStartRef.current = event.clientX;
            draggingRef.current = false;
            rootRef.current?.setAttribute("data-clicking", "");
            applyVisual(valueFromPointer(rootRef.current, event.clientX, maxIndex));
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
          }}
          onPointerMove={event => {
            if (pointerIdRef.current !== event.pointerId) return;
            if (!draggingRef.current && Math.abs(event.clientX - pointerStartRef.current) > 2) {
              draggingRef.current = true;
              rootRef.current?.removeAttribute("data-clicking");
              rootRef.current?.setAttribute("data-dragging", "");
            }
            if (!draggingRef.current) return;
            const raw = valueFromPointer(rootRef.current, event.clientX, maxIndex);
            applyVisual(magnetizeEffort(raw, magnetTargets));
          }}
          onPointerUp={event => {
            if (pointerIdRef.current !== event.pointerId) return;
            const raw = valueFromPointer(rootRef.current, event.clientX, maxIndex);
            pointerIdRef.current = null;
            draggingRef.current = false;
            rootRef.current?.removeAttribute("data-dragging");
            rootRef.current?.removeAttribute("data-clicking");
            commit(Math.round(raw));
          }}
          onPointerCancel={() => {
            pointerIdRef.current = null;
            draggingRef.current = false;
            rootRef.current?.removeAttribute("data-dragging");
            rootRef.current?.removeAttribute("data-clicking");
            commit();
          }}
          onInput={event => {
            if (pointerIdRef.current != null) return;
            const raw = Number(event.currentTarget.value);
            applyVisual(raw);
          }}
          onKeyDown={handleKey}
          onBlur={() => commit()}
        />
      </div>
    </section>
  );
}
