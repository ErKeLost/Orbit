/**
 * 麦克风选择器 —— 取自 ElevenLabs UI 的 `mic-selector`（设备枚举、权限流程、静音），
 * 但**弹出层换成了 Orbit 自己的 Popover**。
 *
 * 原因：上游用的是 shadcn 的 `dropdown-menu`（Radix），它的配色走 `--popover` /
 * `--accent` 那一套 token，和 Orbit 的 `--color-*` 不是一回事——直接装进来会在深浅
 * 主题里出现第二个设计系统。逻辑照搬，UI 用本仓库的组件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "@/shared/ui/Popover";

export interface AudioDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  const toDevices = (list: MediaDeviceInfo[]): AudioDevice[] =>
    list
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({
        deviceId: device.deviceId,
        // 系统给的标签常带 "(Built-in)" 之类后缀，去掉更好排。
        label: (device.label || `Microphone ${device.deviceId.slice(0, 8)}`).replace(/\s*\([^)]*\)/g, "").trim(),
        groupId: device.groupId,
      }));

  const withoutPermission = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(toDevices(list));
      setHasPermission(list.some(device => device.kind === "audioinput" && !!device.label));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法枚举音频设备");
    } finally {
      setLoading(false);
    }
  }, []);

  const withPermission = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // 没有权限时 label 全是空的，先要一次流拿到名字，再立刻还回去。
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
      setDevices(toDevices(await navigator.mediaDevices.enumerateDevices()));
      setHasPermission(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法访问麦克风");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void withoutPermission();
  }, [withoutPermission]);

  useEffect(() => {
    const onChange = () => {
      // Enumerating changed devices never opens a second capture stream.
      void withoutPermission();
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [withoutPermission]);

  return { devices, loading, error, hasPermission, loadDevices: withPermission };
}

export type MicSelectorProps = {
  value?: string;
  onValueChange?: (deviceId: string) => void;
  muted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  disabled?: boolean;
  className?: string;
};

export function MicSelector({ value, onValueChange, muted, onMutedChange, disabled, className }: MicSelectorProps) {
  const { devices, loading, error, hasPermission, loadDevices } = useAudioDevices();
  const [internalSelected, setSelected] = useState("");
  const [internalMuted, setInternalMuted] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  const isMuted = muted ?? internalMuted;
  const selected = value ?? internalSelected;
  const current = devices.find((device) => device.deviceId === selected) ?? devices[0];

  // An empty value means the system default. Enumeration and remounting must
  // never submit a selection or restart the live call's capture stream.

  const toggleMute = () => {
    const next = !isMuted;
    if (muted === undefined) setInternalMuted(next);
    onMutedChange?.(next);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        disabled={disabled || loading}
        onClick={() => {
          setOpen((open) => !open);
          if (!open && !hasPermission) void loadDevices();
        }}
        title={current?.label ?? "选择麦克风"}
        className={cn(
          "flex h-7 max-w-56 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-content/60 hover:bg-content/10 hover:text-content disabled:opacity-40",
          className,
        )}
      >
        {isMuted ? <MicOff className="size-3.5 shrink-0" /> : <Mic className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-left">{current?.label ?? (loading ? "读取中…" : "没有麦克风")}</span>
        <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
      </button>

      {open ? (
        <Popover anchor={trigger} side="top" align="start" width={280} onDismiss={() => setOpen(false)} className="p-1">
          {error ? <p className="px-2 py-1.5 text-[12px] text-red-400">{error}</p> : null}
          {!error && devices.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-content/45">{loading ? "读取中…" : "没有找到输入设备"}</p>
          ) : null}
          {devices.map((device) => (
            <button
              key={device.deviceId}
              type="button"
              onClick={() => {
                setSelected(device.deviceId);
                onValueChange?.(device.deviceId);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content hover:bg-content/5"
            >
              <span className="min-w-0 flex-1 truncate">{device.label}</span>
              {selected === device.deviceId ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
            </button>
          ))}
          {devices.length > 0 ? (
            <>
              <div className="my-1 h-px bg-content/10" />
              <button
                type="button"
                onClick={toggleMute}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-content/70 hover:bg-content/5 hover:text-content"
              >
                {isMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                {isMuted ? "取消静音" : "静音"}
              </button>
            </>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}
