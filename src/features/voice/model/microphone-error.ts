export function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限未开启，请在系统设置里允许 Orbit 使用麦克风。";
  if (name === "NotFoundError") return "没有找到麦克风，请检查输入设备。";
  if (name === "NotReadableError" || name === "AbortError") return "无法读取麦克风，请检查它是否被其他应用占用。";
  return error instanceof Error ? error.message : String(error);
}
