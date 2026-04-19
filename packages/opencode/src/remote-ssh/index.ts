import { Process } from "@/util/process"
import { Installation } from "@/installation"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import z from "zod"

const IDLE_MS = 60_000
const BOOT_MS = 120_000
const SSH_MS = 15_000
const MAX_LOG = 400
const INSTALLER = "https://aether.aiphys.cn/download/installer/aether_linux_installer.sh"
const REMOTE_VER = "0.5.1"
const REMOTE_BIN = ".local/share/applications/aether/aether_0.5.1/aether"

const status = z.enum(["validating", "installing", "starting", "tunneling", "ready", "failed", "cleaning_up"])

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

export const BootstrapInput = z.object({
  savedHostID: z.string().min(1),
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
  argv: string[]
  child?: Process.Child
  idle?: ReturnType<typeof setTimeout>
  pidfile: string
  status: z.infer<typeof status>
  logs: string[]
}

const runs = new Map<string, Runtime>()
const waits = new Map<string, Promise<z.infer<typeof BootstrapOutput>>>()
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]

function line(list: string[], value: string) {
  const text = value.trim()
  if (!text) return
  list.push(text)
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG)
}

function shell(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function port() {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") {
        srv.close()
        reject(new Error("Failed to allocate port"))
        return
      }
      const out = addr.port
      srv.close((err) => (err ? reject(err) : resolve(out)))
    })
    srv.once("error", reject)
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

function release(version: string) {
  return {
    chosen: Installation.isLocal() ? REMOTE_VER : version,
    source: "exact" as const,
  }
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

async function remoteKill(argv: string[], pidfile: string, logs: string[]) {
  line(logs, `stopping remote server via ${pidfile}`)
  await remoteShell(
    argv,
    [
      "set -eu",
      `pidfile=${shell(pidfile)}`,
      "if [ ! -f \"$pidfile\" ]; then",
      "  exit 0",
      "fi",
      "pid=$(cat \"$pidfile\" 2>/dev/null || true)",
      "rm -f \"$pidfile\"",
      "if [ -z \"$pid\" ]; then",
      "  exit 0",
      "fi",
      "kill \"$pid\" 2>/dev/null || true",
      "sleep 1",
      "kill -9 \"$pid\" 2>/dev/null || true",
    ].join("\n"),
    logs,
  ).catch((err) => {
    line(logs, err instanceof Error ? err.message : String(err))
  })
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

function attach(savedHostID: string, idle?: boolean) {
  const run = runs.get(savedHostID)
  if (!run) return
  if (run.status !== "ready") return
  if (idle && run.idle) {
    clearTimeout(run.idle)
    run.idle = undefined
  }
  return BootstrapOutput.parse({
    savedHostID: run.savedHostID,
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
    if (run.status === "cleaning_up") return
    run.status = "failed"
  })
}

async function cleanup(savedHostID: string) {
  const run = runs.get(savedHostID)
  if (!run) return
  run.status = "cleaning_up"
  run.idle = undefined
  await remoteKill(run.argv, run.pidfile, run.logs)
  if (run.child) await Process.stop(run.child).catch(() => undefined)
  runs.delete(savedHostID)
}

export async function disconnect(savedHostID: string) {
  const run = runs.get(savedHostID)
  if (!run) return false
  run.idle = setTimeout(() => {
    void cleanup(savedHostID)
  }, IDLE_MS)
  return true
}

async function boot(input: z.infer<typeof BootstrapInput>) {
  const logs: string[] = []
  line(logs, `bootstrap start for ${input.savedHostID}`)
  const argv = parse(input.command)
  const ver = release(Installation.VERSION)
  line(logs, `version: ${ver.chosen} (${ver.source})`)
  const meta = await probe(argv, logs)
  const local = await port()
  const dir = installDir(meta.home, input.installDir)
  const cmd = `${meta.home}/${REMOTE_BIN}`
  const runtimeID = randomUUID()
  const pidfile = `${dir}/aether-ssh-${runtimeID}.pid`
  line(logs, `requested install dir: ${dir}`)
  line(logs, `remote binary: ${cmd}`)
  line(logs, `remote pidfile: ${pidfile}`)
  line(logs, `remote port: ${meta.port}`)
  line(logs, `local port: ${local}`)
  const script = [
    "set -eu",
    `bin=${shell(cmd)}`,
    `pidfile=${shell(pidfile)}`,
    "if [ ! -x \"$bin\" ]; then",
    `  tmp=${shell(`${dir}/aether_linux_installer.sh`)}`,
    "  mkdir -p \"$(dirname \"$tmp\")\"",
    `  curl -fsSL ${shell(INSTALLER)} -o \"$tmp\"`,
    "  chmod +x \"$tmp\"",
    "  \"$tmp\"",
    "fi",
    "if [ ! -x \"$bin\" ]; then",
    "  echo \"aether install succeeded but binary is missing: $bin\" >&2",
    "  exit 1",
    "fi",
    `cd ${shell(meta.home)}`,
    "\"$bin\" --print-logs --log-level WARN serve --hostname 127.0.0.1 --port " + meta.port + " &",
    "pid=$!",
    "echo \"$pid\" > \"$pidfile\"",
    "wait \"$pid\"",
  ].join("\n")
  const url = `http://127.0.0.1:${local}`
  const run: Runtime = {
    savedHostID: input.savedHostID,
    runtimeID,
    argv,
    endpoint: { url },
    version: ver,
    landing: { rootDirectory: "", directory: "", sessionID: null, workspaceID: null },
    logs,
    pidfile,
    reused: false,
    status: "starting",
  }
  const child = Process.spawn(
    ["ssh", ...SSH_OPTS, ...argv, "-L", `${local}:127.0.0.1:${meta.port}`, "sh", "-lc", shell(script)],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  run.child = child
  runs.set(input.savedHostID, run)
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
  await cleanup(input.savedHostID)
  throw new Error(`Timed out waiting for remote server after ${BOOT_MS / 1000}s`)
}

export async function bootstrap(input: z.infer<typeof BootstrapInput>) {
  const hit = attach(input.savedHostID, true)
  if (hit) return hit
  const wait = waits.get(input.savedHostID)
  if (wait) return wait
  const promise = boot(input)
    .then((out) => out)
    .catch(async (err) => {
      const run = runs.get(input.savedHostID)
      const logs = run?.logs ?? []
      const msg = err instanceof Error ? err.message : String(err)
      line(logs, msg)
      await cleanup(input.savedHostID)
      throw new Error([msg, ...logs].join("\n"))
    })
    .finally(() => {
      waits.delete(input.savedHostID)
    })
  waits.set(input.savedHostID, promise)
  return promise
}
