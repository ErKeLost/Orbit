const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const storageKey = (cwd: string) => `orbit.piTerminalResume.v1:${cwd}`;

type ResumeRecord = { owner: string; args: string[] };

export function toHex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function decodeField(value: string) {
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (controls.test(decoded)) throw new Error("Invalid terminal resume field");
  return decoded;
}

function resumeArgs(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 63 || !value.every(arg => typeof arg === "string" && !controls.test(arg))) return false;
  let index = 0;
  for (const option of ["--agent-dir", "--session-dir"]) {
    if (value[index] !== option) continue;
    if (!value[index + 1] || value[index + 1].startsWith("-")) return false;
    index += 2;
  }
  return value[index] === "--session" && SESSION_ID.test(value[index + 1] ?? "");
}

/** Accept only authenticated Pi reports for the project that launched this tab. */
export async function readPiResumeReport(data: string, token: string, project: string): Promise<string[] | null | undefined> {
  if (data.length > 2048) return;
  const macStart = data.lastIndexOf(":mac=");
  if (macStart < 0) return;
  const body = data.slice(0, macStart);
  const mac = data.slice(macStart + 5);
  if (!HEX_DIGEST.test(mac)) return;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${body}:${token}`));
  if (toHex(digest) !== mac) return;
  if (/^pid=\d+:time=\d+:clear=1$/.test(body)) return null;
  const fields = /^pid=\d+:time=\d+:argv=([^:]+):cwd=([^:]+)$/.exec(body);
  if (!fields) return;
  try {
    const [program, ...args] = fields[1].split(",").map(decodeField);
    if (program === "pi" && decodeField(fields[2]) === project && resumeArgs(args)) return args;
  } catch { /* Malformed fields never become launch arguments. */ }
}

export function loadPiResume(cwd: string): ResumeRecord | undefined {
  try {
    const record = JSON.parse(localStorage.getItem(storageKey(cwd)) ?? "null");
    if (record && typeof record.owner === "string" && resumeArgs(record.args)) return record;
  } catch { /* Resume is optional when storage is unavailable. */ }
}

export function savePiResume(cwd: string, owner: string, args: string[] | null) {
  try {
    if (args) localStorage.setItem(storageKey(cwd), JSON.stringify({ owner, args }));
    else if (loadPiResume(cwd)?.owner === owner) localStorage.removeItem(storageKey(cwd));
  } catch { /* A failed checkpoint must not interrupt the terminal. */ }
}
