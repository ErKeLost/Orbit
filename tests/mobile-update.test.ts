import { describe, expect, test } from "bun:test";
import { checkMobileUpdate, isNewerVersion, mobileUpdateErrorMessage, parseMobileUpdate, shouldRetryMobileUpdate } from "../src/lib/mobile-update";

describe("Android release updates", () => {
  test("compares semantic versions without lexical ordering bugs", () => {
    expect(isNewerVersion("0.2.15", "v0.2.16")).toBe(true);
    expect(isNewerVersion("0.2.15", "v0.3.0")).toBe(true);
    expect(isNewerVersion("0.2.15", "v0.2.15")).toBe(false);
    expect(isNewerVersion("0.10.0", "v0.9.9")).toBe(false);
    expect(isNewerVersion("unknown", "v0.2.16")).toBe(false);
  });

  test("accepts only the signed release APK naming and GitHub path", () => {
    const update = parseMobileUpdate("0.2.15", {
      tag_name: "v0.2.16",
      body: "Fixes",
      assets: [{
        name: "orbit-android-arm64-v0.2.16.apk",
        browser_download_url: "https://github.com/ErKeLost/Orbit/releases/download/v0.2.16/orbit-android-arm64-v0.2.16.apk",
      }],
    });
    expect(update).toEqual({
      version: "0.2.16",
      body: "Fixes",
      downloadUrl: "https://github.com/ErKeLost/Orbit/releases/download/v0.2.16/orbit-android-arm64-v0.2.16.apk",
    });
    expect(parseMobileUpdate("0.2.15", {
      tag_name: "v0.2.16",
      assets: [{
        name: "orbit-android-arm64-v0.2.16.apk",
        browser_download_url: "https://example.com/orbit.apk",
      }],
    })).toBeNull();
  });

  test("retries network and server failures, not client errors", () => {
    expect(shouldRetryMobileUpdate(null)).toBe(true);
    expect(shouldRetryMobileUpdate(502)).toBe(true);
    expect(shouldRetryMobileUpdate(403)).toBe(false);
    expect(shouldRetryMobileUpdate(404)).toBe(false);
  });

  test("explains GitHub network failures in Chinese", () => {
    expect(mobileUpdateErrorMessage(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))).toContain("超时");
    expect(mobileUpdateErrorMessage(new TypeError("Failed to fetch"))).toContain("无法连接 GitHub");
  });

  test("retries a failed GitHub check then returns the latest APK", async () => {
    const payload = {
      tag_name: "v0.2.23",
      body: "Fixes",
      assets: [{
        name: "orbit-android-arm64-v0.2.23.apk",
        browser_download_url: "https://github.com/ErKeLost/Orbit/releases/download/v0.2.23/orbit-android-arm64-v0.2.23.apk",
      }],
    };
    let attempts = 0;
    const fetcher = (async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch;
    await expect(checkMobileUpdate("0.2.22", fetcher)).resolves.toEqual({
      version: "0.2.23",
      body: "Fixes",
      downloadUrl: "https://github.com/ErKeLost/Orbit/releases/download/v0.2.23/orbit-android-arm64-v0.2.23.apk",
    });
    expect(attempts).toBe(2);
  });
});
