import { expect, test } from "bun:test"
import path from "node:path"

const dynamicKeys = ["PLAYWRIGHT_PORT", "PLAYWRIGHT_BASE_URL", "PLAYWRIGHT_SERVER_HOST", "PLAYWRIGHT_SERVER_PORT"]

type Server = { command: string; url: string; env?: Record<string, string> }
type Probe = { servers: Server[]; baseURL?: string; serverPort?: string }

const probe = async (extra: Record<string, string>) => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !dynamicKeys.includes(key)) env[key] = value
  }
  Object.assign(env, extra)
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "config-probe.ts")], { env, stdout: "pipe" })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return JSON.parse(out) as Probe
}

test("webServer commands carry the dynamically allocated ports", async () => {
  const res = await probe({})
  expect(res.servers).toHaveLength(2)
  const backend = res.servers.find((server) => server.command.startsWith("bun script/e2e-backend.ts"))
  const frontend = res.servers.find((server) => server.env?.VITE_OPENCODE_SERVER_PORT)

  const serverPort = backend?.command.split(" ").at(-1)
  expect(serverPort).toMatch(/^\d+$/)
  expect(backend?.url).toBe(`http://127.0.0.1:${serverPort}/global/health`)
  expect(frontend?.env?.VITE_OPENCODE_SERVER_PORT).toBe(serverPort)
  expect(res.serverPort).toBe(serverPort)

  const webPort = new URL(res.baseURL ?? "").port
  expect(webPort).toMatch(/^\d+$/)
  expect(frontend?.command).toContain(`--port ${webPort}`)
}, 30_000)

test("external server env keeps the throwaway backend out of webServer", async () => {
  const res = await probe({ PLAYWRIGHT_SERVER_PORT: "4096" })
  expect(res.servers).toHaveLength(1)
  expect(res.servers[0]?.command).toContain("--port")
  expect(res.servers[0]?.env?.VITE_OPENCODE_SERVER_PORT).toBe("4096")
}, 30_000)
