import { useSyncExternalStore, type ComponentType } from "react";

/**
 * `@lobehub/icons` is ~2.3 MB — the largest thing that used to sit in the boot
 * chunk, for 14px model marks. Like Orbit's Material icon pack, it loads
 * after first paint and a same-sized blank holds the slot until it lands.
 */
type ModelIconComponent = ComponentType<{ model: string; type?: "color" | "mono"; size?: number }>;

let icon: ModelIconComponent | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 首个 `ModelLogo` 挂在首屏 composer 上；直接 `import()` 会让这 1.6 MB 和首帧抢
 *  主线程。空闲时再取，槽位继续用占位尺寸顶着。 */
const whenIdle: (run: () => void) => void = typeof requestIdleCallback === "function"
  ? (run) => { requestIdleCallback(run, { timeout: 2000 }); }
  : (run) => { setTimeout(run, 300); };

function load() {
  if (icon || loading) return;
  loading = new Promise<void>((resolve) => {
    whenIdle(() => {
      void import("@lobehub/icons").then((mod) => {
        icon = mod.ModelIcon as unknown as ModelIconComponent;
        for (const listener of listeners) listener();
        resolve();
      }, (error) => {
        // 图标是装饰：加载失败就让槽位继续空着，不影响任何交互。
        console.warn("[icons] 模型图标加载失败", error);
        loading = null;
        resolve();
      });
    });
  });
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  load();
  return () => {
    listeners.delete(onChange);
  };
}

const snapshot = () => icon;

export function ModelLogo({ modelId, size = 18 }: { modelId: string; size?: number }) {
  const Icon = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <span className="model-logo inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden="true">
      {Icon ? <Icon model={modelId} type="color" size={size} /> : null}
    </span>
  );
}

export function ModelModalities({ values, className = "" }: { values?: string[]; className?: string }) {
  if (!values) return <span className={`model-modalities model-modalities-empty ${className}`}>接口未返回</span>;
  if (values.length === 0) return <span className={`model-modalities model-modalities-empty ${className}`}>接口返回空数组</span>;
  return (
    <span className={`model-modalities ${className}`}>
      {values.map((value) => (
        <span className="model-modality" key={value}>{value}</span>
      ))}
    </span>
  );
}
