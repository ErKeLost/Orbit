/**
 * 语音服务端在不在。
 *
 * 一通电话有三段：本页 ↔ ElevenLabs ↔ 本机 speech-engine。前两段 ElevenLabs 自己
 * 说话，第三段一旦断了，页面表现是"接通了，但对面永远不出声"——最难排查的那种失败。
 * 所以开麦前先问一句 `GET /health`，把"没人接"变成一句能看懂的话。
 */
const HEALTH_URL = "http://127.0.0.1:3001/health";

export type EngineStatus = { engineId: string; cwd: string; calls: number; inFlight: number; rssMb: number; uptimeSec: number; desk?: boolean };
export type EngineHealth = ({ running: true } & EngineStatus) | { running: false; reason: string };
type HealthBody = { ok?: boolean } & Partial<EngineStatus>;

const DOWN =
  "语音服务没在运行（127.0.0.1:3001 没人接）。在 tools/speech-engine 里跑一次 ./up.sh，它会把服务、隧道和 Engine 一次准备好。";

export async function probeSpeechEngine(timeoutMs = 1500): Promise<EngineHealth> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!response.ok) return { running: false, reason: `语音服务回了 ${response.status}，不是它该有的应答。` };
    const body = (await response.json()) as HealthBody;
    if (body.ok !== true || typeof body.engineId !== "string") return { running: false, reason: "127.0.0.1:3001 上有东西在听，但不是 speech-engine。" };
    return {
      running: true,
      engineId: body.engineId,
      cwd: String(body.cwd ?? ""),
      calls: Number(body.calls ?? 0),
      inFlight: Number(body.inFlight ?? 0),
      desk: body.desk === true,
      rssMb: Number(body.rssMb ?? 0),
      uptimeSec: Number(body.uptimeSec ?? 0),
    };
  } catch {
    return { running: false, reason: DOWN };
  }
}
