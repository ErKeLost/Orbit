import { invoke } from "@tauri-apps/api/core";
import { native } from "./rpc";

export const RELEASES_API = "https://api.github.com/repos/ErKeLost/Orbit/releases/latest";
export const CHECK_TIMEOUT_MS = 15_000;
export const CHECK_RETRIES = 2;

type GithubAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GithubRelease = {
  tag_name?: unknown;
  body?: unknown;
  assets?: unknown;
};

export type MobileUpdate = {
  version: string;
  body: string;
  downloadUrl: string;
};

function versionParts(value: string): number[] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(current: string, candidate: string): boolean {
  const left = versionParts(current);
  const right = versionParts(candidate);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (right[index] !== left[index]) return right[index] > left[index];
  }
  return false;
}

export function parseMobileUpdate(currentVersion: string, input: unknown): MobileUpdate | null {
  if (!input || typeof input !== "object") return null;
  const release = input as GithubRelease;
  if (typeof release.tag_name !== "string" || !isNewerVersion(currentVersion, release.tag_name)) return null;
  if (!Array.isArray(release.assets)) return null;

  const version = release.tag_name.replace(/^v/, "");
  const expectedName = `orbit-android-arm64-v${version}.apk`;
  const asset = (release.assets as GithubAsset[]).find(item => item?.name === expectedName);
  if (!asset || typeof asset.browser_download_url !== "string") return null;

  const url = new URL(asset.browser_download_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const expectedPath = `/ErKeLost/Orbit/releases/download/v${version}/${expectedName}`;
  if (url.pathname !== expectedPath) return null;

  return {
    version,
    body: typeof release.body === "string" ? release.body : "新版本已经可以安装。",
    downloadUrl: url.toString(),
  };
}

export function shouldRetryMobileUpdate(status: number | null): boolean {
  return status == null || status >= 500;
}

export function mobileUpdateErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || /aborted|timeout/i.test(text)) return "检查更新超时，网络不稳定，请稍后重试";
  if (/failed to fetch|networkerror|load failed|network/i.test(text)) return "无法连接 GitHub：若开启了 VPN，请切换到全局模式，或将本应用加入代理应用列表后重试";
  return text || "检查更新失败，请稍后重试";
}

async function fetchGithubRelease(fetcher: typeof fetch): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CHECK_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetcher(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) return await response.json();
      const error = new Error(response.status === 403 ? "GitHub 暂时无法访问，请稍后重试" : `检查更新失败（HTTP ${response.status}）`);
      if (!shouldRetryMobileUpdate(response.status) || attempt === CHECK_RETRIES) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === CHECK_RETRIES) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("检查更新失败，请稍后重试");
}

export async function checkMobileUpdate(currentVersion: string, fetcher: typeof fetch = fetch): Promise<MobileUpdate | null> {
  try {
    return parseMobileUpdate(currentVersion, await fetchGithubRelease(fetcher));
  } catch (error) {
    // api.github.com serves 60 anonymous requests/hour/IP; VPN exit IPs share
    // that budget. Fall back to the releases/latest redirect probe, which has
    // no quota. The asset URL is assembled locally, so it passes the whitelist.
    if (!native) throw error;
    const probeVersion = await invoke<string | null>("mobile_update_probe").catch(() => null);
    if (!probeVersion || !isNewerVersion(currentVersion, probeVersion)) throw error;
    return { version: probeVersion, body: "新版本已经可以安装。", downloadUrl: `https://github.com/ErKeLost/Orbit/releases/download/v${probeVersion}/orbit-android-arm64-v${probeVersion}.apk` };
  }
}
