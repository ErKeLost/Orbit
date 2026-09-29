import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createXa11yClient } from "../src-tauri/resources/computer-use/xa11y-client"

const originalSocket = process.env.ORBIT_AX_SOCKET
const originalToken = process.env.ORBIT_AX_TOKEN
const originalRequired = process.env.ORBIT_AX_REQUIRED
afterEach(() => {
  for (const [key, value] of [["ORBIT_AX_SOCKET", originalSocket], ["ORBIT_AX_TOKEN", originalToken], ["ORBIT_AX_REQUIRED", originalRequired]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("production client authenticates to the host broker and sends desktop commands", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orbit-ax-client-"))
  const path = join(directory, "rpc")
  const received: unknown[] = []
  const server = createServer(socket => {
    let buffer = ""
    socket.on("data", chunk => {
      buffer += String(chunk)
      for (;;) {
        const index = buffer.indexOf("\n")
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const value = JSON.parse(line) as { id?: number; token?: string; command?: string }
        received.push(value)
        if (value.token) socket.write('{"ready":true}\n')
        else socket.write(`${JSON.stringify({ version: "orbit.ax.v1", id: value.id, ok: true, command: value.command, data: { app: "Calculator", pid: 42 } })}\n`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  process.env.ORBIT_AX_SOCKET = path
  process.env.ORBIT_AX_TOKEN = "test-secret"
  process.env.ORBIT_AX_REQUIRED = "1"
  try {
    const client = await createXa11yClient()
    try {
      const result = await client.run<{ app: string; pid: number }>(["launch", "Calculator"], { timeoutMs: 2_000 })
      expect(result.data?.pid).toBe(42)
      expect(received).toEqual([{ token: "test-secret" }, { id: 1, command: "launch", app: "Calculator" }])
    } finally { await client.dispose() }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

test("packaged client fails closed when the host broker is missing", async () => {
  delete process.env.ORBIT_AX_SOCKET
  delete process.env.ORBIT_AX_TOKEN
  process.env.ORBIT_AX_REQUIRED = "1"
  await expect(createXa11yClient()).rejects.toThrow("broker is unavailable")
})

test("production client reports a broker that rejects the session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orbit-ax-client-"))
  const path = join(directory, "rpc")
  const server = createServer(socket => { socket.once("data", () => socket.end()) })
  await new Promise<void>(resolve => server.listen(path, resolve))
  process.env.ORBIT_AX_SOCKET = path
  process.env.ORBIT_AX_TOKEN = "wrong"
  process.env.ORBIT_AX_REQUIRED = "1"
  try {
    await expect(createXa11yClient()).rejects.toThrow("rejected the session")
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})
