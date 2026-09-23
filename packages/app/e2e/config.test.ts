import { expect, test } from "bun:test"
import path from "node:path"

const dynamicKeys = [
  "PLAYWRIGHT_PORT",
  "PLAYWRIGHT_PORT_RESOLVED",
  "PLAYWRIGHT_BASE_URL",
  "PLAYWRIGHT_SERVER_HOST",
  "PLAYWRIGHT_SERVER_PORT",
  "PLAYWRIGHT_SERVER_PORT_RESOLVED",
]

type Server = { command: string; url: string; env?: Record<string, string>; reuse?: boolean }
type Probe = { servers: Server[]; baseURL?: string; serverPort?: string }

const baseEnv = () => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !dynamicKeys.includes(key)) env[key] = value
  }
  return env
}

const probe = async (extra: Record<string, string>) => {
  const env = baseEnv()
  Object.assign(env, extra)
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "config-probe.ts")], { env, stdout: "pipe" })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`config probe exited ${code}: ${out}`)
  return JSON.parse(out) as Probe
}

test("webServer commands carry the dynamically allocated ports", async () => {
  const res = await probe({})
  expect(res.servers).toHaveLength(2)
  const backend = res.servers.find((server) => server.command.startsWith("bun script/e2e-backend.ts"))
  const frontend = res.servers.find((server) => server.env?.VITE_OPENCODE_SERVER_PORT)

  const args = backend?.command.split(" ") ?? []
  const serverPort = args[2]
  const run = args[3]
  expect(serverPort).toMatch(/^\d+$/)
  expect(run).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(backend?.url).toBe(`http://127.0.0.1:${serverPort}/global/health?run=${run}`)
  expect(frontend?.env?.VITE_OPENCODE_SERVER_PORT).toBe(serverPort)
  expect(res.serverPort).toBe(serverPort)

  const webPort = new URL(res.baseURL ?? "").port
  expect(webPort).toMatch(/^\d+$/)
  expect(frontend?.command).toContain(`--port ${webPort}`)
  expect(frontend?.reuse).toBe(false)
}, 30_000)

test("external server env keeps the throwaway backend out of webServer", async () => {
  const res = await probe({ PLAYWRIGHT_SERVER_PORT: "4096" })
  expect(res.servers).toHaveLength(1)
  expect(res.serverPort).toBe("4096")
  expect(res.servers[0]?.command).toContain("--port")
  expect(res.servers[0]?.env?.VITE_OPENCODE_SERVER_PORT).toBe("4096")
  expect(res.servers[0]?.reuse).toBe(false)
}, 30_000)

test("explicit PLAYWRIGHT_PORT opts the vite server into reuse off CI", async () => {
  const res = await probe({ PLAYWRIGHT_PORT: "4443" })
  expect(res.servers[0]?.reuse).toBe(!process.env.CI)
}, 30_000)

test("pre-resolved ports pin both servers without enabling reuse", async () => {
  const res = await probe({ PLAYWRIGHT_PORT_RESOLVED: "4566", PLAYWRIGHT_SERVER_PORT_RESOLVED: "4567" })
  expect(res.servers).toHaveLength(2)
  expect(new URL(res.baseURL ?? "").port).toBe("4566")
  const backend = res.servers.find((server) => server.command.startsWith("bun script/e2e-backend.ts"))
  const frontend = res.servers.find((server) => server.env?.VITE_OPENCODE_SERVER_PORT)
  expect(backend?.command).toContain(" 4567 ")
  expect(backend?.url).toContain("127.0.0.1:4567/")
  expect(frontend?.env?.VITE_OPENCODE_SERVER_PORT).toBe("4567")
  expect(res.servers[0]?.reuse).toBe(false)
  expect(res.serverPort).toBe("4567")
}, 30_000)

test("PLAYWRIGHT_SERVER_HOST without PLAYWRIGHT_SERVER_PORT fails fast", async () => {
  const env = baseEnv()
  env.PLAYWRIGHT_SERVER_HOST = "127.0.0.1"
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, "config-probe.ts")], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code).not.toBe(0)
  expect(err).toContain("PLAYWRIGHT_SERVER_PORT")
}, 30_000)
