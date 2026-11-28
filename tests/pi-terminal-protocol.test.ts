import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readPiResumeReport } from "../src/features/terminal/pi-program-resume";
import { parsePiProgramStatus, piStatusLabel } from "../src/features/terminal/pi-program-status";

const project = "/tmp/Orbit 项目";
const token = "1".repeat(64);
const session = "db37d62a-e5da-4628-bb59-afc5c0655f6c";
const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
const signed = (body: string, key = token) => `${body}:mac=${createHash("sha256").update(`${body}:${key}`).digest("hex")}`;
const report = (args: string[], cwd = project, program = "pi") =>
  signed(`pid=42:time=1700000000:argv=${[program, ...args].map(encode).join(",")}:cwd=${encode(cwd)}`);

const args = ["--agent-dir", "/tmp/工作 profile", "--session-dir", "/tmp/sessions", "--session", session, "-t", "read,grep", "--no-extensions"];

describe("Pi program resume", () => {
  test("retains the original profile and tool restrictions as literal arguments", async () => {
    expect(await readPiResumeReport(report(args), token, project)).toEqual(args);
  });

  test("rejects reports from another terminal, another project or another program", async () => {
    expect(await readPiResumeReport(report(args), "2".repeat(64), project)).toBeUndefined();
    expect(await readPiResumeReport(report(args, "/tmp/another"), token, project)).toBeUndefined();
    expect(await readPiResumeReport(report(args, project, "sh"), token, project)).toBeUndefined();
  });

  test("accepts an authenticated clear and ignores invalid session arguments", async () => {
    expect(await readPiResumeReport(signed("pid=42:time=1700000000:clear=1"), token, project)).toBeNull();
    expect(await readPiResumeReport(report(["--session", "../../bad"]), token, project)).toBeUndefined();
  });
});

describe("Pi program status", () => {
  test("uses the actual dialog kind and decodes the title", () => {
    const status = parsePiProgramStatus(`state=blocked:app=pi:kind=auth:msg=${encode("登录 Radius")}`);
    expect(status).toEqual({ state: "blocked", kind: "auth", message: "登录 Radius" });
    expect(piStatusLabel(status!)).toBe("等待登录");
  });

  test("ignores other programs and rejects terminal escapes in a message", () => {
    expect(parsePiProgramStatus("state=done:app=other")).toBeUndefined();
    expect(parsePiProgramStatus(`state=working:app=pi:msg=${encode("\x1b[31minvalid")}`)).toEqual({ state: "working" });
  });
});
