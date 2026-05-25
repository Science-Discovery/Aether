import { Process } from "@/util/process"
import { Installation } from "@/installation"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import semver from "semver"
import z from "zod"

const BOOT_MS = 120_000
const SSH_MS = 15_000
const PING_MS = 10_000
const LOCAL_PORT = 14_096
const MAX_LOG = 400
const INSTALLER = "https://aether.aiphys.cn/download/installer/aether_linux_installer.sh"
const REMOTE_ROOT = ".local/share/applications/aether"
const REGISTRY = "aether-ssh-runtime.tsv"

const status = z.enum(["validating", "installing", "starting", "tunneling", "ready", "failed", "stopping"])

const endpoint = z.object({
  url: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
})

const version = z.object({
  chosen: z.string(),
  source: z.enum(["exact", "fallback"]),
})

const landing = z.object({
  rootDirectory: z.string(),
  directory: z.string(),
  sessionID: z.string().nullable(),
  workspaceID: z.string().nullable(),
})

const registry = z.object({
  runtimeID: z.string().min(1),
  pid: z.coerce.number().int().positive(),
  port: z.coerce.number().int().positive(),
  version: z.string().min(1),
})

export const BootstrapInput = z.object({
  savedHostID: z.string().min(1),
  consumerID: z.string().min(1),
  host: z.string().min(1),
  command: z.string().min(1),
  installDir: z.string().min(1),
})

export const BootstrapOutput = z.object({
  savedHostID: z.string(),
  runtimeID: z.string(),
  endpoint,
  version,
  landing,
  logs: z.array(z.string()),
  reused: z.boolean(),
})

type Runtime = z.infer<typeof BootstrapOutput> & {
  key: string
  argv: string[]
  child?: Process.Child
  ping?: ReturnType<typeof setInterval>
  consumers: Set<string>
  pidfile: string
  registry: string
  remotePort: number
  status: z.infer<typeof status>
  logs: string[]
}

const runs = new Map<string, Runtime>()
const waits = new Map<string, Promise<z.infer<typeof BootstrapOutput>>>()
const aliases = new Map<string, string>()
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]
const EXITS = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
} as const

let hooked = false
let exiting = false

function line(list: string[], value: string) {
  const text = value.trim()
  if (!text) return
  list.push(text)
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG)
}

function toast(logs: string[], message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  void Bus.publish(TuiEvent.ToastShow, {
    title: "Remote SSH",
    message,
    variant,
    duration: 8000,
  }).catch((err) => {
    line(logs, `failed to show toast: ${err instanceof Error ? err.message : String(err)}`)
  })
}

function shell(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function port() {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.listen(LOCAL_PORT, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") {
        srv.close()
        reject(new Error(`Failed to reserve local SSH port ${LOCAL_PORT}`))
        return
      }
      const out = addr.port
      srv.close((err) => (err ? reject(err) : resolve(out)))
    })
    srv.once("error", (err) => {
      reject(new Error(`Local SSH port ${LOCAL_PORT} is unavailable: ${err instanceof Error ? err.message : String(err)}`))
    })
  })
}

export function split(input: string) {
  const out: string[] = []
  let cur = ""
  let quote: "'" | '"' | "" = ""
  let esc = false
  for (const ch of input) {
    if (esc) {
      cur += ch
      esc = false
      continue
    }
    if (ch === "\\") {
      esc = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = ""
        continue
      }
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (!cur) continue
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  if (quote) throw new Error("Unclosed quote in SSH command")
  if (esc) cur += "\\"
  if (cur) out.push(cur)
  return out
}

function parse(input: string) {
  const argv = split(input)
  if (argv[0] !== "ssh") throw new Error("SSH command must start with ssh")
  const pos: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const item = argv[i]
    if (!item) continue
    if (item === "-i" || item === "-p" || item === "-o" || item === "-F" || item === "-J" || item === "-b" || item === "-l") {
      i += 1
      continue
    }
    if (item.startsWith("-")) continue
    pos.push(item)
  }
  if (pos.length !== 1) throw new Error("SSH command must contain exactly one destination and no remote command")
  return argv.slice(1)
}

function compare(a: string, b: string) {
  const x = semver.coerce(a)
  const y = semver.coerce(b)
  if (x && y) return semver.compare(x, y)
  if (x) return 1
  if (y) return -1
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

export function bins(input: string) {
  return [...new Set(input.split(/\r?\n/).flatMap((x) => {
    const text = x.trim()
    if (!text) return []
    if (text.startsWith("aether_")) return [text.slice("aether_".length)]
    return [text]
  }))].sort((a, b) => compare(b, a))
}

export function pick(want: string, list: string[]) {
  if (!list.length) {
    return {
      chosen: want,
      source: want ? ("exact" as const) : ("fallback" as const),
      install: true,
    }
  }
  if (want && list.includes(want)) {
    return {
      chosen: want,
      source: "exact" as const,
      install: false,
    }
  }
  if (want) {
    return {
      chosen: want,
      source: "exact" as const,
      install: true,
    }
  }
  return {
    chosen: list[0],
    source: "fallback" as const,
    install: false,
  }
}

function root(home: string) {
  return `${home}/${REMOTE_ROOT}`
}

function runkey(command: string, dir: string) {
  return `${command.trim()}\n${dir.trim()}`
}

function bin(home: string, ver: string) {
  return `${root(home)}/aether_${ver}/aether`
}

function registryPath(dir: string) {
  return `${dir}/${REGISTRY}`
}

export function launch(bin: string, pidfile: string, registry: string, port: number, home: string, runtimeID: string, ver: string) {
  return [
    "set -eu",
    `bin=${shell(bin)}`,
    `pidfile=${shell(pidfile)}`,
    `registry=${shell(registry)}`,
    "if [ ! -x \"$bin\" ]; then",
    "  echo \"aether install succeeded but binary is missing: $bin\" >&2",
    "  exit 1",
    "fi",
    `cd ${shell(home)}`,
    "mkdir -p \"$(dirname \"$pidfile\")\"",
    "mkdir -p \"$(dirname \"$registry\")\"",
    `nohup "$bin" --print-logs --log-level WARN serve --hostname 127.0.0.1 --port ${port} --enable-lease >/dev/null 2>&1 < /dev/null &`,
    "pid=$!",
    "echo \"$pid\" > \"$pidfile\"",
    `printf '%s\\t%s\\t%s\\t%s\\n' ${shell(runtimeID)} \"$pid\" ${port} ${shell(ver)} > \"$registry\"`,
  ].join("\n")
}

export function halt(child?: Pick<Process.Child, "exitCode" | "signalCode" | "kill">) {
  if (!child) return false
  if (child.exitCode !== null || child.signalCode !== null) return false
  child.kill("SIGTERM")
  return true
}

function tunnel(argv: string[], local: number, remote: number) {
  return Process.spawn(["ssh", ...SSH_OPTS, ...argv, "-N", "-L", `${local}:127.0.0.1:${remote}`], {
    stdout: "pipe",
    stderr: "pipe",
  })
}

function drain() {
  for (const run of runs.values()) {
    if (run.ping) clearInterval(run.ping)
    run.ping = undefined
    if (!halt(run.child)) continue
    line(run.logs, "stopping local ssh tunnel on process exit")
  }
}

function quit(sig?: keyof typeof EXITS) {
  if (exiting) return
  exiting = true
  drain()
  if (!sig) return
  process.exit(EXITS[sig])
}

function hook() {
  if (hooked) return
  hooked = true
  process.once("exit", () => quit())
  process.once("SIGHUP", () => quit("SIGHUP"))
  process.once("SIGINT", () => quit("SIGINT"))
  process.once("SIGTERM", () => quit("SIGTERM"))
}

async function remote(argv: string[], args: string[], logs: string[]) {
  const out = await Process.run(["ssh", ...SSH_OPTS, ...argv, ...args], { nothrow: true, timeout: SSH_MS })
  const text = `${out.stdout.toString()}${out.stderr.toString()}`
  line(logs, text)
  if (out.code !== 0) throw new Error(text.trim() || "SSH command failed")
  return out.stdout.toString().trim()
}

async function remoteShell(argv: string[], cmd: string, logs: string[]) {
  return remote(argv, ["sh", "-lc", shell(cmd)], logs)
}

async function touch(url: string, id: string, alive: boolean, logs: string[]) {
  const res = await fetch(new URL("/global/ping", url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id, alive }),
  }).catch((err) => {
    throw new Error(err instanceof Error ? err.message : String(err))
  })
  if (!res.ok) throw new Error(`Remote lease update failed: ${res.status}`)
}

function stopPing(run: Runtime) {
  if (run.ping) clearInterval(run.ping)
  run.ping = undefined
  line(run.logs, "remote lease loop paused")
}

function startPing(run: Runtime) {
  if (run.ping) return
  line(run.logs, "remote lease loop started")
  const beat = () =>
    touch(run.endpoint.url, run.runtimeID, true, run.logs).catch((err) => {
      line(run.logs, err instanceof Error ? err.message : String(err))
    })
  void beat()
  run.ping = setInterval(() => {
    void beat()
  }, PING_MS)
}

async function probe(argv: string[], logs: string[]) {
  line(logs, "probing remote host")
  const code =
    "import json,os,socket;s=socket.socket();s.bind(('127.0.0.1',0));p=s.getsockname()[1];s.close();print(json.dumps({'port':p,'home':os.path.expanduser('~')}))"
  const out = await remoteShell(argv, `python3 -c ${shell(code)}`, logs)
  const json = z.object({ port: z.number(), home: z.string() }).parse(JSON.parse(out))
  return json
}

export function installDir(home: string, input: string) {
  if (input === "~") return home
  if (input.startsWith("~/")) return `${home}/${input.slice(2)}`
  return input
}

async function ensure(argv: string[], dir: string, logs: string[]) {
  await remoteShell(argv, [`set -eu`, `dir=${shell(dir)}`, "mkdir -p \"$dir\""].join("\n"), logs)
}

async function vers(argv: string[], home: string, logs: string[]) {
  const out = await remoteShell(
    argv,
    [
      "set -eu",
      `root=${shell(root(home))}`,
      "if [ ! -d \"$root\" ]; then",
      "  exit 0",
      "fi",
      "for dir in \"$root\"/aether_*; do",
      "  [ -d \"$dir\" ] || continue",
      "  [ -x \"$dir/aether\" ] || continue",
      "  basename \"$dir\"",
      "done",
    ].join("\n"),
    logs,
  )
  return bins(out)
}

function parseRegistry(input: string) {
  const text = input.trim()
  if (!text) return
  const [runtimeID = "", pid = "", port = "", version = ""] = text.split("\t")
  if (!runtimeID || !pid || !port || !version) return
  return registry.parse({ runtimeID, pid, port, version })
}

async function attached(argv: string[], file: string, logs: string[]) {
  const out = await remoteShell(
    argv,
    [
      "set -eu",
      `file=${shell(file)}`,
      "if [ ! -f \"$file\" ]; then",
      "  exit 0",
      "fi",
      "IFS=$(printf '\\t') read -r runtime pid port ver < \"$file\" || true",
      "if [ -z \"${runtime:-}\" ] || [ -z \"${pid:-}\" ] || [ -z \"${port:-}\" ] || [ -z \"${ver:-}\" ]; then",
      "  rm -f \"$file\"",
      "  exit 0",
      "fi",
      "if ! kill -0 \"$pid\" 2>/dev/null; then",
      "  rm -f \"$file\"",
      "  exit 0",
      "fi",
      "printf '%s\\t%s\\t%s\\t%s\\n' \"$runtime\" \"$pid\" \"$port\" \"$ver\"",
    ].join("\n"),
    logs,
  )
  return parseRegistry(out)
}

async function installer(argv: string[], dir: string, logs: string[]) {
  line(logs, "downloading remote installer")
  await remoteShell(
    argv,
    [
      "set -eu",
      `tmp=${shell(`${dir}/aether_linux_installer.sh`)}`,
      "mkdir -p \"$(dirname \"$tmp\")\"",
      `curl -fsSL ${shell(INSTALLER)} -o \"$tmp\"`,
      "chmod +x \"$tmp\"",
    ].join("\n"),
    logs,
  )
  return `${dir}/aether_linux_installer.sh`
}

async function install(argv: string[], tmp: string, ver: string, logs: string[]) {
  line(logs, ver ? `installing remote backend ${ver}` : "installing latest remote backend")
  await remoteShell(
    argv,
    [
      "set -eu",
      `tmp=${shell(tmp)}`,
      ver ? `VERSION=${shell(ver)} "$tmp"` : "\"$tmp\"",
    ].join("\n"),
    logs,
  )
}

async function info(url: string, logs: string[]) {
  line(logs, `checking remote health via ${url}`)
  const health = await fetch(new URL("/global/health", url))
    .then((x) => x.json())
    .catch((err) => ({ healthy: false, version: "", error: String(err) }))
  if (!(health as any).healthy) throw new Error((health as any).error || "Remote health check failed")
  const path = await fetch(new URL("/path", url)).then((x) => x.json())
  const dir = typeof path?.directory === "string" ? path.directory : ""
  if (!dir) throw new Error("Remote path response missing directory")
  line(logs, `remote directory: ${dir}`)
  return {
    rootDirectory: dir,
    directory: dir,
    sessionID: null,
    workspaceID: null,
  }
}

function attach(key: string, savedHostID: string, consumerID: string) {
  const run = runs.get(key)
  if (!run) return
  if (run.status !== "ready") return
  run.consumers.add(consumerID)
  startPing(run)
  return BootstrapOutput.parse({
    savedHostID,
    runtimeID: run.runtimeID,
    endpoint: run.endpoint,
    version: run.version,
    landing: run.landing,
    logs: run.logs,
    reused: true,
  })
}

function watch(run: Runtime) {
  const stdout = run.child?.stdout
  const stderr = run.child?.stderr
  stdout?.on("data", (buf) => line(run.logs, Buffer.from(buf).toString()))
  stderr?.on("data", (buf) => line(run.logs, Buffer.from(buf).toString()))
  run.child?.once("exit", () => {
    stopPing(run)
    if (run.status === "stopping") return
    run.status = "failed"
  })
}

async function cleanup(key: string) {
  const run = runs.get(key)
  if (!run) return
  run.status = "stopping"
  stopPing(run)
  if (run.child) await Process.stop(run.child).catch(() => undefined)
  runs.delete(key)
  for (const [alias, value] of aliases.entries()) {
    if (value !== key) continue
    aliases.delete(alias)
  }
}

export async function disconnect(input: { savedHostID: string; consumerID: string }) {
  const key = aliases.get(input.savedHostID)
  if (!key) return false
  const run = runs.get(key)
  if (!run) return false
  run.consumers.delete(input.consumerID)
  if (run.consumers.size > 0) return true
  await cleanup(key)
  return true
}

async function boot(input: z.infer<typeof BootstrapInput>) {
  const logs: string[] = []
  line(logs, `bootstrap start for ${input.savedHostID}`)
  toast(logs, `Connecting to ${input.host}`)
  const argv = parse(input.command)
  const want = Installation.isLocal() ? "" : Installation.VERSION
  const meta = await probe(argv, logs)
  toast(logs, "SSH connection established")
  const local = await port()
  const dir = installDir(meta.home, input.installDir)
  const key = runkey(input.command, dir)
  aliases.set(input.savedHostID, key)
  const hit = attach(key, input.savedHostID, input.consumerID)
  if (hit) return hit
  const pidfile = `${dir}/aether-ssh-runtime.pid`
  const file = registryPath(dir)
  let list = await vers(argv, meta.home, logs)
  line(logs, `installed remote versions: ${list.length ? list.join(", ") : "none"}`)
  const tmp = `${dir}/aether_linux_installer.sh`
  await ensure(argv, dir, logs)
  const live = await attached(argv, file, logs)
  if (live && want && live.version !== want) {
    throw new Error(`Remote runtime ${live.version} is already active; expected ${want}`)
  }
  if (live) {
    line(logs, `reusing remote runtime ${live.runtimeID} on port ${live.port}`)
    const url = `http://127.0.0.1:${local}`
    const run: Runtime = {
      key,
      savedHostID: input.savedHostID,
      runtimeID: live.runtimeID,
      argv,
      endpoint: { url },
      version: { chosen: live.version, source: want && live.version === want ? "exact" : "fallback" },
      landing: { rootDirectory: "", directory: "", sessionID: null, workspaceID: null },
      logs,
      pidfile,
      registry: file,
      remotePort: live.port,
      reused: true,
      consumers: new Set([input.consumerID]),
      status: "starting",
    }
    run.child = tunnel(argv, local, live.port)
    hook()
    runs.set(key, run)
    watch(run)
    const stop = Date.now() + BOOT_MS
    while (Date.now() < stop) {
      await sleep(500)
      if (run.status === "failed") throw new Error(run.logs.at(-1) || "SSH runtime failed")
      const ok = await fetch(new URL("/global/health", url))
        .then((x) => x.ok)
        .catch(() => false)
      if (!ok) continue
      run.status = "ready"
      run.landing = await info(url, logs)
      startPing(run)
      return BootstrapOutput.parse({
        savedHostID: input.savedHostID,
        runtimeID: run.runtimeID,
        endpoint: run.endpoint,
        version: run.version,
        landing: run.landing,
        logs: run.logs,
        reused: true,
      })
    }
    await cleanup(key)
    throw new Error(`Timed out waiting for remote server after ${BOOT_MS / 1000}s`)
  }
  const runtimeID = randomUUID()
  let ver = pick(want, list)
  if (ver.install) {
    const down = !list.length
      ? want
        ? `No remote backend found; downloading ${want}`
        : "No remote backend found; downloading installer"
      : `Remote backend ${list[0]} is incompatible; downloading ${want}`
    const run = !list.length
      ? want
        ? `Installing remote backend ${want}`
        : "Installing latest remote backend"
      : `Updating remote backend to ${want}`
    const reason = !list.length
      ? want
        ? `no remote backend found, installing ${want}`
        : "no remote backend found, installing latest backend"
      : `remote backend ${list[0]} does not match local ${want}; installing ${want}`
    line(logs, reason)
    toast(logs, down)
    await installer(argv, dir, logs)
    toast(logs, run)
    await install(argv, tmp, want, logs)
    list = await vers(argv, meta.home, logs)
    line(logs, `installed remote versions after install: ${list.length ? list.join(", ") : "none"}`)
    toast(logs, "Remote backend installation finished", "success")
    ver = pick(want, list)
  }
  if (!ver.chosen) throw new Error("Remote backend is missing after install")
  if (want && ver.chosen !== want) {
    throw new Error(`Remote backend ${want} is required but unavailable after install`)
  }
  const cmd = bin(meta.home, ver.chosen)
  line(logs, `version: ${ver.chosen} (${ver.source})`)
  line(logs, `requested install dir: ${dir}`)
  line(logs, `remote binary: ${cmd}`)
  line(logs, `remote pidfile: ${pidfile}`)
  line(logs, `remote registry: ${file}`)
  line(logs, `remote port: ${meta.port}`)
  line(logs, `local port: ${local}`)
  const script = launch(cmd, pidfile, file, meta.port, meta.home, runtimeID, ver.chosen)
  const url = `http://127.0.0.1:${local}`
  const run: Runtime = {
    key,
    savedHostID: input.savedHostID,
    runtimeID,
    argv,
    endpoint: { url },
    version: ver,
    landing: { rootDirectory: "", directory: "", sessionID: null, workspaceID: null },
    logs,
    pidfile,
    registry: file,
    remotePort: meta.port,
    reused: false,
    consumers: new Set([input.consumerID]),
    status: "starting",
  }
  await remoteShell(argv, script, logs)
  run.child = tunnel(argv, local, meta.port)
  hook()
  runs.set(key, run)
  watch(run)
  toast(logs, "Remote backend starting")
  const stop = Date.now() + BOOT_MS
  while (Date.now() < stop) {
    await sleep(500)
    if (run.status === "failed") throw new Error(run.logs.at(-1) || "SSH runtime failed")
    const ok = await fetch(new URL("/global/health", url))
      .then((x) => x.ok)
      .catch(() => false)
    if (!ok) continue
    run.status = "ready"
    run.landing = await info(url, logs)
    startPing(run)
    toast(logs, "Remote backend is ready", "success")
    return BootstrapOutput.parse({
      savedHostID: input.savedHostID,
      runtimeID,
      endpoint: run.endpoint,
      version: run.version,
      landing: run.landing,
      logs: run.logs,
      reused: false,
    })
  }
  await cleanup(key)
  throw new Error(`Timed out waiting for remote server after ${BOOT_MS / 1000}s`)
}

export async function bootstrap(input: z.infer<typeof BootstrapInput>) {
  const key = runkey(input.command, input.installDir)
  const hit = attach(aliases.get(input.savedHostID) ?? key, input.savedHostID, input.consumerID)
  if (hit) return hit
  const wait = waits.get(key)
  if (wait) return wait
  const promise = boot(input)
    .then((out) => out)
    .catch(async (err) => {
      const key = aliases.get(input.savedHostID) ?? runkey(input.command, input.installDir)
      const run = runs.get(key)
      const logs = run?.logs ?? []
      const msg = err instanceof Error ? err.message : String(err)
      const text = msg.split(/\r?\n/)[0]?.slice(0, 180) || "unknown error"
      line(logs, msg)
      toast(logs, `Remote SSH setup failed: ${text}`, "error")
      await cleanup(key)
      throw new Error([msg, ...logs].join("\n"))
    })
    .finally(() => {
      waits.delete(key)
    })
  waits.set(key, promise)
  return promise
}
