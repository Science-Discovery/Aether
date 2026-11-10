import path from "node:path"
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync, existsSync, realpathSync, lstatSync, chmodSync } from "node:fs"
import { hostname } from "node:os"
import { Aether } from "./aether"
import { TaskPermissions } from "./permissions"
import { Store } from "./store"
import { Engine } from "./engine"
import { NativeCoordinator } from "./native"
import { controlHandler } from "./control"
import { git } from "./workspace"

const file = process.argv[2]
if (!file) throw new Error("Usage: bun src/main.ts /absolute/path/config.local.json")
const config = JSON.parse(readFileSync(file, "utf8"))
if (typeof config.repo !== "string" || typeof config.state !== "string" || !path.isAbsolute(config.state))
  throw new Error("Config requires repo and an absolute state directory.")
const repo = realpathSync(config.repo)
const state = path.resolve(config.state)
const backend = new URL(config.aether ?? "http://127.0.0.1:19527")
if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password || backend.search || backend.hash)
  throw new Error("Use an HTTP(S) Aether URL; pass credentials with AETHER_AUTHORIZATION.")
const workers = config.workers ?? 2
const port = config.port ?? 19700
if (!Number.isInteger(workers) || workers < 1 || workers > 16 || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("workers must be 1–16; port must be 1–65535.")
if (config.model && (typeof config.model.providerID !== "string" || typeof config.model.modelID !== "string"))
  throw new Error("model needs providerID and modelID.")
if (await git(repo, "rev-parse", "--show-toplevel") !== repo) throw new Error("repo must be a Git working-tree root.")
mkdirSync(state, { recursive: true, mode: 0o700 })
const lock = path.join(state, "owner.json")
let descriptor: number
try {
  descriptor = openSync(lock, "wx", 0o600)
} catch {
  throw new Error(`State is locked: ${lock}. If its recorded process has exited on that host, remove this lock before restarting.`)
}
writeFileSync(descriptor, JSON.stringify({ pid: process.pid, host: hostname() }))
closeSync(descriptor)
process.on("exit", () => { if (existsSync(lock)) unlinkSync(lock) })

const store = new Store(path.join(state, "superagent.db"))
const identity = JSON.stringify({ repo, backend: backend.href })
if (store.setting("identity") && store.setting("identity") !== identity) throw new Error("State belongs to another repository or Aether server.")
store.setting("identity", identity)
const base = store.setting("base") ?? await git(repo, "rev-parse", "--verify", `${config.base ?? "HEAD"}^{commit}`)
store.setting("base", base)
const tokenfile = path.join(state, "token")
if (!existsSync(tokenfile)) writeFileSync(tokenfile, crypto.randomUUID(), { mode: 0o600, flag: "wx" })
const token = readFileSync(tokenfile, "utf8").trim()
const engine = new Engine(store, new Aether(backend.href, process.env.AETHER_AUTHORIZATION), {
  repo, state, base, workers, model: config.model,
})
const native = new NativeCoordinator(engine)
const permissions = new TaskPermissions(engine)
const serve = controlHandler(engine, token, native, permissions)
const server = Bun.serve({ hostname: "127.0.0.1", port, maxRequestBodySize: 256_000, fetch(request) {
  const url = new URL(request.url)
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port || 80) !== port)
    return new Response("Invalid host", { status: 403 })
  return serve(request)
} })
// The native Aether bridge uses a private local socket, bypassing HTTP proxies.
const socket = path.join(state, "control.sock")
if (existsSync(socket)) {
  if (!lstatSync(socket).isSocket()) throw new Error(`Refusing to replace a non-socket file: ${socket}`)
  unlinkSync(socket) // Exclusive state lock already acquired above.
}
const local = Bun.serve({ unix: socket, maxRequestBodySize: 256_000, fetch: serve })
chmodSync(socket, 0o600)
const timer = setInterval(() => { engine.tick(); void native.tick().catch(() => undefined); void permissions.tick().catch(() => undefined) }, 500)
const progress = setInterval(() => { void engine.collectProgress().catch(() => undefined) }, 1000)
let reading = false
const recovery = setInterval(async () => {
  if (reading || engine.closed) return
  reading = true
  try {
    for (const ticket of store.tickets().filter((x) => x.state === "stopped" && store.setting(`stop:${x.id}`) === "pending"))
      await engine.stop(ticket.id).catch(() => undefined)
    for (const input of store.inputs().filter((x) => x.state === "uncertain"))
      await engine.reconcile(input.id).catch(() => undefined)
  } finally { reading = false }
}, 5000)
engine.tick()
console.log(`aether-superagent: ${server.url}\nRepository: ${repo}\nBase: ${base}\nToken file: ${tokenfile}`)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  engine.closed = true
  clearInterval(timer)
  clearInterval(progress)
  clearInterval(recovery)
  // The durable claims stay in SQLite. Aether may still be working; restart reads
  // back results instead of assuming either cancellation or safe replay.
  local.stop(true)
  server.stop(true)
  process.exit(0)
})
