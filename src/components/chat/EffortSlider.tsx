import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { RpcSessionState } from "../../lib/protocol";
import { createGalaxyField } from "./effort-galaxy-field";
import { effortColorsForLevels, effortIsGalaxy, effortIsRecommended, effortLabel, magnetizeEffort } from "./effort-slider-model";
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
  "--ds-effort-level-color": string;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Lucide 0.4 的大脑：两个闭合半球填充，九条路径描边，和 demo 用的一致。 */
const BRAIN_LEFT = "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z";
const BRAIN_RIGHT = "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z";
const BRAIN_PATHS = [
  BRAIN_LEFT,
  BRAIN_RIGHT,
  "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4",
  "M17.599 6.5a3 3 0 0 0 .399-1.375",
  "M6.003 5.125A3 3 0 0 0 6.401 6.5",
  "M3.477 10.896a4 4 0 0 1 .585-.396",
  "M19.938 10.5a4 4 0 0 1 .585.396",
  "M6 18a4 4 0 0 1-1.967-.516",
  "M19.967 17.484A4 4 0 0 1 18 18",
];

/** 光标高光：跟着指针在轨道上移动的一点柔光。 */
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
  const styles = getComputedStyle(root);
  const thumbWidth = Number.parseFloat(styles.getPropertyValue("--ds-effort-thumb-w")) || 24;
  const thumbInset = Number.parseFloat(styles.getPropertyValue("--ds-effort-thumb-inset")) || 2;
  const centerInset = thumbInset + thumbWidth * 0.5;
  const progress = clamp((clientX - rect.left - centerInset) / Math.max(1, rect.width - centerInset * 2), 0, 1);
  return progress * maxIndex;
}

export function EffortSlider({ levels, value, disabled, onChange }: EffortSliderProps) {
  const maxIndex = Math.max(0, levels.length - 1);
  const selectedIndex = Math.max(0, levels.indexOf(value ?? levels[0]));
  const [activeLevel, setActiveLevel] = useState(levels[selectedIndex]);
  const activeIndexRef = useRef(selectedIndex);
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const continuousValueRef = useRef(selectedIndex);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const pointerStartRef = useRef(0);
  const lastCommittedRef = useRef(value);
  const galaxyRef = useRef(false);
  const fieldRef = useRef<ReturnType<typeof createGalaxyField> | null>(null);
  const gradientId = useId();
  const initialColors = effortColorsForLevels(levels, selectedIndex);
  const magnetTargets = levels.map((_, index) => index);

  /** 顶级用的粒子爆炸由 galaxy field 的 canvas 负责，这里只翻开关。 */
  const applyVisual = useCallback((nextValue: number) => {
    const safeValue = clamp(Number.isFinite(nextValue) ? nextValue : 0, 0, maxIndex);
    const nextIndex = clamp(Math.round(safeValue), 0, maxIndex);
    const nextLevel = levels[nextIndex];
    const progress = maxIndex ? safeValue / maxIndex : 0.5;
    const colors = effortColorsForLevels(levels, safeValue);
    continuousValueRef.current = safeValue;
    if (inputRef.current) {
      inputRef.current.value = String(safeValue);
      inputRef.current.setAttribute("aria-valuetext", effortLabel(nextLevel));
    }
    const root = rootRef.current;
    if (root) {
      root.style.setProperty("--ds-effort-progress", String(progress));
      root.style.setProperty("--ds-effort-level-color", colors.base);
      root.dataset.level = String(nextIndex);
      root.toggleAttribute("data-off", nextIndex === 0);
    }
    // 最高档就是 Galaxy：像素轨道 + 光柱 + 蓝紫大脑。
    const galaxy = effortIsGalaxy(nextLevel, levels);
    if (galaxy !== galaxyRef.current) {
      galaxyRef.current = galaxy;
      if (galaxy) {
        fieldRef.current?.enter();
      } else {
        fieldRef.current?.leave();
      }
    }
    if (activeIndexRef.current !== nextIndex) {
      activeIndexRef.current = nextIndex;
      setActiveLevel(nextLevel);
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

  useEffect(() => {
    const field = createGalaxyField({ rootRef, canvasRef, trackRef });
    fieldRef.current = field;
    return () => {
      fieldRef.current = null;
      field.destroy();
    };
  }, []);

  useEffect(() => {
    if (draggingRef.current) return;
    lastCommittedRef.current = value;
    applyVisual(Math.max(0, levels.indexOf(value ?? levels[0])));
  }, [applyVisual, levels, value]);

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" || event.key === "PageDown" ? -1 : event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? 1 : null;
    const target = event.key === "Home" ? 0 : event.key === "End" ? maxIndex : direction == null ? null : clamp(activeIndexRef.current + direction, 0, maxIndex);
    if (target == null) return;
    event.preventDefault();
    commit(target);
  };

  if (levels.length < 2) return null;

  const style: EffortStyle = {
    "--ds-effort-progress": maxIndex ? selectedIndex / maxIndex : 0.5,
    "--ds-effort-level-color": initialColors.base,
  };

  return (
    <section
      ref={rootRef}
      className="effort-slider"
      data-disabled={disabled || undefined}
      data-off={selectedIndex === 0 ? "" : undefined}
      data-level={selectedIndex}
      aria-label={`Effort ${effortLabel(activeLevel)}`}
      onPointerMove={moveLight}
      onPointerLeave={clearLight}
      style={style}
    >
      <div className="effort-slider-head">
        <span className="effort-slider-head-label">Effort</span>
        <strong className="effort-slider-head-value">{effortLabel(activeLevel)}</strong>
      </div>
      <div className="effort-slider-shell">
        <div ref={trackRef} className="effort-slider-track" aria-hidden>
          <div className="effort-slider-fill" />
          <div className="effort-slider-ticks">
            {levels.map((level, index) => (
              <i
                data-recommended={effortIsRecommended(level) ? "" : undefined}
                style={{ "--tick-progress": maxIndex ? index / maxIndex : 0.5 } as CSSProperties}
                key={index}
              />
            ))}
          </div>
          <canvas ref={canvasRef} className="effort-slider-galaxy" />
          <div ref={thumbRef} className="effort-slider-thumb">
            <svg className="effort-slider-brain" viewBox="0 0 24 24" fill="none" aria-hidden>
              <g className="effort-slider-brain-pink">
                <path className="effort-slider-brain-fill" d={BRAIN_LEFT} />
                <path className="effort-slider-brain-fill" d={BRAIN_RIGHT} />
                <g className="effort-slider-brain-line" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  {BRAIN_PATHS.map((d) => <path d={d} key={d} />)}
                </g>
              </g>
              <g className="effort-slider-brain-galaxy">
                <path style={{ fill: `url(#${gradientId})` }} d={BRAIN_LEFT} />
                <path style={{ fill: `url(#${gradientId})` }} d={BRAIN_RIGHT} />
                <g className="effort-slider-brain-line-galaxy" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  {BRAIN_PATHS.map((d) => <path d={d} key={d} />)}
                </g>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="var(--ds-effort-galaxy-brain-from)" />
                    <stop offset="100%" stopColor="var(--ds-effort-galaxy-brain-to)" />
                  </linearGradient>
                </defs>
              </g>
            </svg>
          </div>
          <div className="effort-slider-light" />
        </div>
        <input
          ref={inputRef}
          type="range"
          min={0}
          max={maxIndex}
          step={0.001}
          defaultValue={selectedIndex}
          disabled={disabled}
          aria-label="Effort"
          aria-valuetext={effortLabel(levels[selectedIndex])}
          onPointerDown={event => {
            if (disabled) return;
            event.preventDefault();
            event.currentTarget.focus();
            pointerIdRef.current = event.pointerId;
            pointerStartRef.current = event.clientX;
            draggingRef.current = false;
            applyVisual(valueFromPointer(rootRef.current, event.clientX, maxIndex));
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already released */ }
          }}
          onPointerMove={event => {
            if (pointerIdRef.current !== event.pointerId) return;
            if (!draggingRef.current && Math.abs(event.clientX - pointerStartRef.current) > 2) {
              draggingRef.current = true;
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
            commit(Math.round(raw));
          }}
          onPointerCancel={() => {
            pointerIdRef.current = null;
            draggingRef.current = false;
            rootRef.current?.removeAttribute("data-dragging");
            commit();
          }}
          onInput={event => {
            if (pointerIdRef.current != null) return;
            applyVisual(Number(event.currentTarget.value));
          }}
          onKeyDown={handleKey}
          onBlur={() => commit()}
        />
      </div>
    </section>
  );
}
