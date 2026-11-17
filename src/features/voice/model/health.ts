/**
 * 语音服务端在不在。
 *
 * 一通电话有三段：本页 ↔ ElevenLabs ↔ 电脑上的 speech-engine。前两段 ElevenLabs 自己
 * 说话，第三段一旦断了，页面表现是"接通了，但对面永远不出声"。手机上看不见
 * 127.0.0.1:3001，所以问的是电脑上的那一份。
 */
import { invoke } from "@/lib/native";
import { mobileRuntime } from "@/lib/runtime";

const HEALTH_URL = "http://127.0.0.1:3001/health";

export type EngineStatus = { engineId: string; cwd: string; calls: number; inFlight: number; rssMb: number; uptimeSec: number; desk?: boolean };
export type EngineHealth = ({ running: true } & EngineStatus) | { running: false; reason: string };
type HealthBody = { ok?: boolean; running?: boolean; reason?: string } & Partial<EngineStatus>;

const DOWN =
  "语音服务没在运行（电脑上 127.0.0.1:3001 没人接）。在 tools/speech-engine 里跑一次 ./up.sh，它会把服务、隧道和 Engine 一次准备好。";

function fromBody(body: HealthBody): EngineHealth {
  if (body.running === false) return { running: false, reason: body.reason || DOWN };
  if ((body.ok !== true && body.running !== true) || typeof body.engineId !== "string") {
    return { running: false, reason: body.reason || "电脑上 3001 端口有东西在听，但不是 speech-engine。" };
  }
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
}

export async function probeSpeechEngine(timeoutMs = 1500): Promise<EngineHealth> {
  if (mobileRuntime()) {
    try {
      return fromBody(await invoke<HealthBody>("speech_engine_health"));
    } catch (error) {
      return { running: false, reason: error instanceof Error ? error.message : DOWN };
    }
  }
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!response.ok) return { running: false, reason: `语音服务回了 ${response.status}，不是它该有的应答。` };
    return fromBody((await response.json()) as HealthBody);
  } catch {
    return { running: false, reason: DOWN };
  }
}
