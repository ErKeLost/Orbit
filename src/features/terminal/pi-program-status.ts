export type PiProgramStatus = {
  state: "idle" | "working" | "blocked" | "done" | "error";
  kind?: "permission" | "question" | "auth";
  message?: string;
};

export const PI_STATUS_LABELS = {
  idle: "空闲", working: "运行中", blocked: "等待输入", done: "已完成", error: "出错",
};

const BLOCKED_LABELS = { permission: "等待授权", question: "等待回答", auth: "等待登录" };

export function piStatusLabel(status: PiProgramStatus) {
  return status.kind ? BLOCKED_LABELS[status.kind] : PI_STATUS_LABELS[status.state];
}

export function parsePiProgramStatus(data: string): PiProgramStatus | undefined {
  if (data.length > 3072) return;
  const fields = Object.fromEntries(data.split(":").map(field => {
    const split = field.indexOf("=");
    return [field.slice(0, split), field.slice(split + 1)];
  }));
  const { app, state, kind, msg } = fields;
  if (app !== "pi" || !(state === "idle" || state === "working" || state === "blocked" || state === "done" || state === "error")) return;
  const status: PiProgramStatus = { state };
  if (state === "blocked" && (kind === "permission" || kind === "question" || kind === "auth")) status.kind = kind;
  if (msg) {
    try {
      const bytes = Uint8Array.from(atob(msg), char => char.charCodeAt(0));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.length <= 2048 && !Array.from(text).some(char => {
        const code = char.charCodeAt(0);
        return code < 32 || (code >= 127 && code < 160);
      })) status.message = text;
    } catch { /* A malformed message does not invalidate the status. */ }
  }
  return status;
}
