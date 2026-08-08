import fs from "fs/promises"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { createServer } from "net"
import z from "zod"
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Process } from "@/util/process"

export namespace ManagedMinerU {
  export const UV_VERSION = "0.12.1"
  export const UV_SHA256 = "8fcb0cb46e1229065e344758980924e569bef5882ef45f46fada8fb24e06b74a"
  export const UV_EXE_SHA256 = "f537cc65c1791d9d1a022132302b21ecd48cdf0a605a7b345809fbe8af4e807d"
  export const UV_URL = `https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
  export const PYTHON_VERSION = "3.12.10"
  export const MINERU_VERSION = "3.4.4"
  export const SOURCE = "modelscope"

  const stages = ["check", "uv", "python", "venv", "mineru", "models", "verify"] as const
  export const Stage = z.enum(stages)
  export const Install = z.enum(["unconfigured", "installing", "ready", "failed", "cancelled"])
  export const Run = z.enum(["stopped", "starting", "running"])
  export const Progress = z.object({
    current: z.number().nonnegative(),
    total: z.number().positive(),
    unit: z.literal("byte"),
    speed: z.number().nonnegative().optional(),
    eta: z.number().nonnegative().optional(),
  })
  export const Storage = z.object({
    total: z.number().int().nonnegative(),
    environment: z.number().int().nonnegative(),
    models: z.number().int().nonnegative(),
    aether: z.number().int().nonnegative(),
    model_directories: z.string().array(),
  })
  const Detail = z.object({
    version: z.object({ uv: z.string().optional(), python: z.string().optional(), mineru: z.string() }),
    source: z.enum(["modelscope", "huggingface", "local"]),
    backend: z.literal("pipeline"),
    device: z.string(),
    storage: Storage,
    scanned_at: z.number().int(),
  })
  export const Status = z.object({
    supported: z.boolean(),
    strategy: z.literal("skill"),
    runtime: z.enum(["managed", "adopted"]),
    install: Install,
    run: Run,
    stage: Stage.optional(),
    step: z.object({ current: z.number().int().nonnegative(), total: z.number().int().positive() }),
    progress: Progress.optional(),
    message: z.string(),
    error: z.string().optional(),
    warning: z.string().optional(),
    version: z.object({ uv: z.string().optional(), python: z.string().optional(), mineru: z.string() }),
    source: z.enum(["modelscope", "huggingface", "local"]).optional(),
    backend: z.literal("pipeline").optional(),
    device: z.string().optional(),
    directory: z.string(),
    data_directory: z.string(),
    executable: z.string().optional(),
    base_url: z.string().optional(),
    started_at: z.number().int().optional(),
    elapsed: z.number().int().nonnegative().optional(),
    size: z.number().int().nonnegative().optional(),
    size_scope: z.enum(["installation", "aether_data", "detected"]),
    storage: Storage.optional(),
    scanned_at: z.number().int().optional(),
    session: z.object({ id: z.string(), directory: z.string() }).optional(),
    logs: z.string().array(),
  })

  export const Candidate = z.object({
    id: z.string(),
    path: z.string(),
    version: z.string(),
  })
  const Item = z.object({ path: z.string(), size: z.number().int().nonnegative().optional() })
  export const Uninstall = z.object({
    runtime: z.enum(["managed", "adopted"]),
    owned: Item,
    environment: Item.optional(),
    models: Item.array(),
    config: z.string().optional(),
    removable: z.number().int().nonnegative(),
  })

  export const Inspection = z.object({
    supported: z.boolean(),
    platform: z.string(),
    arch: z.string(),
    application: z.object({
      executable: z.string(),
      working_directory: z.string(),
    }),
    memory: z.number().nonnegative(),
    disk: z.object({ free: z.number().nonnegative(), total: z.number().nonnegative() }),
    gpu: z.string().optional(),
    directory: z.string(),
    plan: z.object({
      uv: z.string(),
      python: z.string(),
      mineru: z.string(),
      source: z.literal("modelscope"),
      backend: z.literal("pipeline"),
      device: z.literal("cpu"),
      download: z.string(),
    }),
    managed: z.boolean(),
    candidates: Candidate.array(),
  })

  const Disk = z.object({ free: z.number(), total: z.number() })
  const ModelConfig = z.object({
    "model-source": z.string().optional(),
    "models-dir": z.record(z.string(), z.string()).optional(),
  })
  const Stored = z.object({
    install: Install.default("unconfigured"),
    stage: Stage.optional(),
    completed: Stage.array().default([]),
    port: z.number().int().min(8000).max(8099).optional(),
    message: z.string().default(""),
    error: z.string().optional(),
    warning: z.string().optional(),
    started_at: z.number().int().optional(),
    runtime: z.enum(["managed", "adopted"]).default("managed"),
    adopted_api: z.string().optional(),
    version: z.string().optional(),
    detail: Detail.optional(),
    session: z.object({ id: z.string(), directory: z.string() }).optional(),
  })
  type Stored = z.infer<typeof Stored>

  const root = () => path.join(Global.Path.data, "mineru")
  const file = () => path.join(root(), "state.json")
  const uv = () => path.join(root(), "bin", "uv.exe")
  const zip = () => path.join(root(), "cache", "uv", `uv-${UV_VERSION}.zip`)
  const python = () => path.join(root(), "env", "Scripts", "python.exe")
  const api = () => path.join(root(), "env", "Scripts", "mineru-api.exe")
  const models = () => path.join(root(), "env", "Scripts", "mineru-models-download.exe")
  const work = () => path.join(root(), "work")
  const log = () => path.join(root(), "install.log")
  const pid = () => path.join(root(), "service.pid")
  const cfg = () => path.join(root(), "mineru.json")

  let task: Promise<void> | undefined
  let abort: AbortController | undefined
  let child: Process.Child | undefined
  let service: Process.Child | undefined
  let launching: Promise<string> | undefined
  let runtime: z.infer<typeof Run> = "stopped"
  let recent: string[] = []
  let progress: z.infer<typeof Progress> | undefined
  let report: Promise<void> | undefined
  let init: Promise<void> | undefined
  const candidates = new Map<string, z.infer<typeof Candidate>>()

  export function supported(input = { platform: process.platform, arch: process.arch, client: Flag.OPENCODE_CLIENT }) {
    return input.platform === "win32" && input.arch === "x64" && input.client === "desktop"
  }

  function assert() {
    if (!supported()) throw new Error("Managed MinerU is only available in Aether Windows x64 desktop")
  }

  async function read(): Promise<Stored> {
    return Bun.file(file())
      .json()
      .then(Stored.parse)
      .catch(() => Stored.parse({}))
  }

  async function write(state: Stored) {
    await fs.mkdir(root(), { recursive: true })
    const tmp = `${file()}.tmp`
    await Bun.write(tmp, JSON.stringify(state, null, 2))
    await fs.rename(tmp, file())
  }

  function clean(input: string) {
    return input
      .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
      .replace(/(authorization\s*[:=]\s*)(\S+)/gi, "$1[redacted]")
      .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(\S+)/gi, "$1[redacted]")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async function record(input: string) {
    const lines = clean(input)
    if (!lines.length) return
    recent = [...recent, ...lines].slice(-200)
    await fs.mkdir(root(), { recursive: true })
    await fs.appendFile(log(), `${lines.join("\n")}\n`).catch(() => undefined)
  }

  function bytes(input: string) {
    const match = input.match(/([\d.]+)\s*(KiB|MiB|GiB)\s*\/\s*([\d.]+)\s*(KiB|MiB|GiB)/i)
    if (!match) return
    const unit = (value: string) => ({ kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 })[value.toLowerCase()] ?? 1
    const current = Number(match[1]) * unit(match[2])
    const total = Number(match[3]) * unit(match[4])
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return
    return { current, total, unit: "byte" as const }
  }

  function env(kind: "managed" | "adopted" = "managed"): Record<string, string> {
    const task = {
      MINERU_API_OUTPUT_ROOT: path.join(work(), "output"),
      MINERU_API_TASK_RETENTION_SECONDS: "60",
      MINERU_API_TASK_CLEANUP_INTERVAL_SECONDS: "30",
    }
    if (kind === "adopted") return task
    return {
      UV_PYTHON_INSTALL_DIR: path.join(root(), "python"),
      UV_CACHE_DIR: path.join(root(), "cache", "uv"),
      MODELSCOPE_CACHE: path.join(root(), "cache", "modelscope"),
      HF_HOME: path.join(root(), "cache", "huggingface"),
      TORCH_HOME: path.join(root(), "cache", "torch"),
      MINERU_TOOLS_CONFIG_JSON: cfg(),
      MINERU_MODEL_SOURCE: SOURCE,
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      ...task,
    }
  }

  async function run(cmd: string[], signal: AbortSignal) {
    await fs.mkdir(work(), { recursive: true })
    await record(`> ${cmd.map((item) => (item.includes(" ") ? JSON.stringify(item) : item)).join(" ")}`)
    child = Process.spawn(cmd, {
      cwd: work(),
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
      abort: signal,
    })
    const output = (data: Buffer) => {
      const value = data.toString()
      progress = bytes(value) ?? progress
      void record(value)
    }
    child.stdout?.on("data", output)
    child.stderr?.on("data", output)
    const code = await child.exited
    child = undefined
    if (signal.aborted) throw signal.reason ?? new Error("MinerU configuration cancelled")
    if (code !== 0) throw new Error(`Command exited with code ${code}. See the detailed log for more information.`)
  }

  async function disk(): Promise<z.infer<typeof Disk>> {
    const value = await fs.statfs(Global.Path.data)
    return Disk.parse({ free: value.bavail * value.bsize, total: value.blocks * value.bsize })
  }

  async function port() {
    const state = await read()
    const list = state.port
      ? [state.port, ...Array.from({ length: 100 }, (_, idx) => 8000 + idx)]
      : Array.from({ length: 100 }, (_, idx) => 8000 + idx)
    for (const value of [...new Set(list)]) {
      const free = await new Promise<boolean>((resolve) => {
        const server = createServer()
        server.once("error", () => resolve(false))
        server.listen(value, "127.0.0.1", () => server.close(() => resolve(true)))
      })
      if (free) return value
    }
    throw new Error("No free MinerU port is available between 8000 and 8099")
  }

  async function hash(input: string) {
    const sum = createHash("sha256")
    const data = await Bun.file(input).arrayBuffer()
    sum.update(new Uint8Array(data))
    return sum.digest("hex")
  }

  async function download(url: string, target: string, signal: AbortSignal) {
    const res = await fetch(url, { signal })
    if (!res.ok || !res.body) throw new Error(`Failed to download uv: HTTP ${res.status}`)
    const total = Number(res.headers.get("content-length"))
    const handle = await fs.open(target, "w")
    const reader = res.body.getReader()
    const started = Date.now()
    let current = 0
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        await handle.write(item.value)
        current += item.value.byteLength
        if (Number.isFinite(total) && total > 0) {
          const elapsed = Math.max((Date.now() - started) / 1000, 0.001)
          const speed = current / elapsed
          progress = {
            current,
            total,
            unit: "byte",
            speed,
            eta: speed > 0 ? Math.max(0, (total - current) / speed) : undefined,
          }
        }
      }
    } finally {
      await handle.close()
    }
  }

  async function size(dir: string): Promise<number> {
    const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const values = await Promise.all(
      rows.map((row) => {
        const item = path.join(dir, row.name)
        if (row.isDirectory()) return size(item)
        if (row.isSymbolicLink())
          return fs
            .lstat(item)
            .then((info) => info.size)
            .catch(() => 0)
        return fs
          .stat(item)
          .then((info) => info.size)
          .catch(() => 0)
      }),
    )
    return values.reduce((sum, value) => sum + value, 0)
  }

  function inside(item: string, parent: string) {
    const value = path.resolve(item).toLowerCase()
    const root = path.resolve(parent).toLowerCase()
    return value === root || value.startsWith(`${root}${path.sep}`)
  }

  function canonical(input: string) {
    const value = input.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
    return path.resolve(value)
  }

  async function real(input: string) {
    return fs
      .realpath(input)
      .then(canonical)
      .catch(() => canonical(input))
  }

  async function folders(input: Array<string | undefined>) {
    const values = await Promise.all(
      input.filter((item): item is string => !!item).map(async (item) => {
        const value = item.startsWith(`~${path.sep}`) ? path.join(Global.Path.home, item.slice(2)) : item
        const info = await fs.stat(value).catch(() => undefined)
        if (!info?.isDirectory()) return
        return real(value)
      }),
    )
    return values
      .filter((item): item is string => !!item)
      .sort((a, b) => a.length - b.length)
      .filter((item, index, rows) => !rows.slice(0, index).some((parent) => inside(item, parent)))
  }

  function modelfile(state?: Stored) {
    if (state?.runtime === "managed") return cfg()
    const name = process.env.MINERU_TOOLS_CONFIG_JSON || "mineru.json"
    return path.isAbsolute(name) ? name : path.join(Global.Path.home, name)
  }

  async function modelconfig(state?: Stored) {
    const file = modelfile(state)
    const config = await Bun.file(file)
      .json()
      .then(ModelConfig.parse)
      .catch(() => undefined)
    return { file, config }
  }

  async function caches(state?: Stored) {
    const config = await modelconfig(state)
    return folders([
      process.env.MODELSCOPE_CACHE ?? path.join(Global.Path.home, ".cache", "modelscope"),
      process.env.HF_HOME ?? path.join(Global.Path.home, ".cache", "huggingface"),
      process.env.HF_HUB_CACHE,
      process.env.TORCH_HOME ?? path.join(Global.Path.home, ".cache", "torch"),
      ...Object.values(config.config?.["models-dir"] ?? {}),
    ])
  }

  const marker = /mineru|pdf[-_ ]?extract[-_ ]?kit|layoutreader/i

  function repository(input: string) {
    const value = path.resolve(input)
    const parts = value.split(path.sep)
    const index = parts.findIndex((item) => item.toLowerCase() === "snapshots")
    if (index < 1) return value
    const parent = parts.slice(0, index).join(path.sep)
    return marker.test(parent) ? parent : value
  }

  async function safe(input: string) {
    const [value, home, owned] = await Promise.all([real(input), real(Global.Path.home), real(root())])
    if (!inside(value, home) && !inside(value, owned)) return false
    const blocked = [
      path.parse(value).root,
      home,
      path.join(home, ".cache"),
      path.join(home, ".cache", "huggingface"),
      path.join(home, ".cache", "huggingface", "hub"),
      path.join(home, ".cache", "modelscope"),
      path.join(home, ".cache", "modelscope", "models"),
      path.join(home, ".cache", "torch"),
    ].map((item) => path.resolve(item).toLowerCase())
    return !blocked.includes(value.toLowerCase())
  }

  async function repositories(state: Stored) {
    const config = await modelconfig(state)
    const roots = [
      path.join(Global.Path.home, ".cache", "huggingface", "hub"),
      path.join(Global.Path.home, ".cache", "huggingface", "hub", ".locks"),
      path.join(Global.Path.home, ".cache", "modelscope", "models"),
      path.join(Global.Path.home, ".cache", "modelscope", "models", ".locks"),
      path.join(Global.Path.home, ".cache", "modelscope", "hub", "models"),
      path.join(Global.Path.home, ".cache", "modelscope", "hub", ".locks"),
    ]
    const detected = await Promise.all(
      roots.map(async (dir) =>
        fs
          .readdir(dir, { withFileTypes: true })
          .then((rows) => rows.filter((item) => item.isDirectory() && marker.test(item.name)).map((item) => path.join(dir, item.name)))
          .catch(() => []),
      ),
    )
    const configured = Object.values(config.config?.["models-dir"] ?? {}).map(repository)
    const rows = await folders([...configured, ...detected.flat()])
    const values = await Promise.all(
      rows.map(async (item) => ((await safe(item)) && marker.test(item) ? item : undefined)),
    )
    return values.filter((item): item is string => !!item)
  }

  async function plan(state: Stored) {
    const data = state.detail?.storage
    if (state.runtime === "managed") {
      const value = data?.total ?? (await size(root()))
      return Uninstall.parse({
        runtime: state.runtime,
        owned: { path: root(), size: value },
        models: [],
        removable: value,
      })
    }

    const dir = state.adopted_api ? path.dirname(path.dirname(state.adopted_api)) : undefined
    const models = await repositories(state)
    const config = await modelconfig(state)
    const configfile =
      path.resolve(config.file).toLowerCase() === path.resolve(Global.Path.home, "mineru.json").toLowerCase() &&
      (await fs.stat(config.file).catch(() => undefined))?.isFile()
        ? config.file
        : undefined
    const values = data ? undefined : await Promise.all([size(root()), dir ? size(dir) : Promise.resolve(0)])
    const modelsize = await Promise.all(models.map(size))
    const owned = data?.aether ?? values?.[0]
    const environment = data?.environment ?? values?.[1]
    const cached = modelsize.reduce((sum, value) => sum + value, 0)
    const extra = configfile
      ? await fs
          .stat(configfile)
          .then((item) => item.size)
          .catch(() => 0)
      : 0
    return Uninstall.parse({
      runtime: state.runtime,
      owned: { path: root(), size: owned },
      environment: dir ? { path: dir, size: environment } : undefined,
      models: models.map((item, index) => ({
        path: item,
        size: modelsize[index],
      })),
      config: configfile,
      removable: (owned ?? 0) + (environment ?? 0) + (cached ?? 0) + extra,
    })
  }

  async function erase(state: Stored, input: { adopted?: boolean }) {
    if (state.runtime === "managed") {
      await fs.rm(root(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    }
    if (!input.adopted) {
      await fs.rm(root(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    }
    if (!state.adopted_api) throw new Error("The adopted MinerU executable is missing")
    const checked = await candidate(state.adopted_api)
    if (!checked || checked.path.toLowerCase() !== (await real(state.adopted_api)).toLowerCase())
      throw new Error("The adopted MinerU environment could not be verified and was not removed")
    const value = await plan(state)
    const targets = [value.environment?.path, ...value.models.map((item) => item.path)].filter(
      (item): item is string => !!item,
    )
    if ((await Promise.all(targets.map(safe))).some((item) => !item))
      throw new Error("A MinerU removal target failed the path safety check")
    await Promise.all(
      targets.map((item) => fs.rm(item, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
    )
    if (value.config) await fs.rm(value.config, { force: true })
    await fs.rm(root(), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  async function detect(cmd: string[], pattern: RegExp) {
    const result = await Process.text(cmd, { nothrow: true }).catch(() => undefined)
    if (!result || result.code !== 0) return
    return result.text.trim().match(pattern)?.[1]
  }

  async function profile(state: Stored) {
    const dir = state.runtime === "adopted" && state.adopted_api ? path.dirname(path.dirname(state.adopted_api)) : root()
    if (state.runtime === "managed") {
      const models = await folders([
        path.join(root(), "cache", "modelscope"),
        path.join(root(), "cache", "huggingface"),
        path.join(root(), "cache", "torch"),
      ])
      const values = await Promise.all([size(root()), size(path.join(root(), "env")), ...models.map(size)])
      const cached = values.slice(2).reduce((sum, value) => sum + value, 0)
      return Detail.parse({
        version: { uv: UV_VERSION, python: PYTHON_VERSION, mineru: state.version ?? MINERU_VERSION },
        source: SOURCE,
        backend: "pipeline",
        device: "cpu",
        storage: Storage.parse({
          total: values[0],
          environment: values[1],
          models: cached,
          aether: Math.max(0, values[0] - values[1] - cached),
          model_directories: models,
        }),
        scanned_at: Date.now(),
      })
    }

    const config = await modelconfig(state)
    const models = (await caches(state)).filter((item) => !inside(item, dir) && !inside(item, root()))
    const python = path.join(dir, "Scripts", "python.exe")
    const uv = path.join(dir, "Scripts", "uv.exe")
    const values = await Promise.all([size(dir), size(root()), ...models.map(size)])
    const versions = await Promise.all([
      detect([python, "--version"], /^Python\s+([^\s]+)/i),
      detect([uv, "--version"], /^uv\s+([^\s]+)/i),
    ])
    const cached = values.slice(2).reduce((sum, value) => sum + value, 0)
    const source = (process.env.MINERU_MODEL_SOURCE ?? config.config?.["model-source"])?.toLowerCase()
    const origin = source === "modelscope" || source === "local" ? source : ("huggingface" as const)
    return Detail.parse({
      version: { python: versions[0], uv: versions[1], mineru: state.version ?? MINERU_VERSION },
      source: origin,
      backend: "pipeline",
      device: process.env.MINERU_DEVICE_MODE?.trim() || "auto",
      storage: Storage.parse({
        total: values[0] + values[1] + cached,
        environment: values[0],
        models: cached,
        aether: values[1],
        model_directories: models,
      }),
      scanned_at: Date.now(),
    })
  }

  function executable(state: Stored) {
    return state.runtime === "adopted" && state.adopted_api ? state.adopted_api : api()
  }

  async function candidate(input: string) {
    const value = await real(input)
    if (!/^[a-zA-Z]:\\/.test(value) || path.basename(value).toLowerCase() !== "mineru-api.exe") return
    const info = await fs.stat(value).catch(() => undefined)
    if (!info?.isFile()) return
    const site = path.join(path.dirname(path.dirname(value)), "Lib", "site-packages")
    const dist = await fs
      .readdir(site, { withFileTypes: true })
      .then((rows) => rows.find((row) => row.isDirectory() && /^mineru-.+\.dist-info$/i.test(row.name)))
      .catch(() => undefined)
    if (!dist) return
    const version = await Bun.file(path.join(site, dist.name, "METADATA"))
      .text()
      .then((text) => text.match(/^Version:\s*(\d+\.\d+\.\d+[^\s]*)/m)?.[1])
      .catch(() => undefined)
    if (!version) return
    const id = createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 16)
    return Candidate.parse({ id, path: value, version })
  }

  async function discover(dir = os.homedir()) {
    return fs
      .readdir(dir, { withFileTypes: true })
      .then((rows) =>
        rows
          .filter((row) => row.isDirectory() && row.name.toLowerCase().includes("mineru"))
          .map((row) => path.join(dir, row.name, "Scripts", "mineru-api.exe")),
      )
      .catch(() => [])
  }

  export async function inspect() {
    const space = await disk().catch(() => ({ free: 0, total: 0 }))
    const paths = supported()
      ? await Promise.all([
          Process.text(["where.exe", "mineru-api.exe"], { nothrow: true }).then((item) => clean(item.text)),
          discover(),
        ]).then((items) => items.flat())
      : []
    const list = await Promise.all([...new Set([api(), ...paths])].map(candidate))
    candidates.clear()
    list.filter((item) => item !== undefined).forEach((item) => candidates.set(item.id, item))
    const gpu = supported()
      ? await Process.text(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object Name -Match 'NVIDIA' | Select-Object -ExpandProperty Name",
          ],
          { nothrow: true },
        ).then((item) => clean(item.text).join(", ") || undefined)
      : undefined
    return Inspection.parse({
      supported: supported(),
      platform: process.platform,
      arch: process.arch,
      application: {
        executable: process.execPath,
        working_directory: process.cwd(),
      },
      memory: os.totalmem(),
      disk: space,
      gpu,
      directory: root(),
      plan: {
        uv: UV_VERSION,
        python: PYTHON_VERSION,
        mineru: MINERU_VERSION,
        source: SOURCE,
        backend: "pipeline",
        device: "cpu",
        download: "Several gigabytes; the exact amount depends on resolved dependencies and model artifacts.",
      },
      managed: await fs
        .stat(api())
        .then((item) => item.isFile())
        .catch(() => false),
      candidates: [...candidates.values()],
    })
  }

  async function enable(url: string) {
    const current = await Config.getGlobal()
    await Config.updateGlobal({
      experimental: {
        ...current.experimental,
        attachment_text_extraction: {
          ...current.experimental?.attachment_text_extraction,
          enabled: true,
          strategy: "local",
          mineru: {
            ...current.experimental?.attachment_text_extraction?.mineru,
            mode: "managed",
            scope: "selective",
            base_url: url,
          },
        },
      },
    })
  }

  async function stale() {
    const value = await Bun.file(pid())
      .text()
      .catch(() => "")
    if (!/^\d+$/.test(value.trim())) return
    if (process.platform !== "win32") {
      await fs.rm(pid(), { force: true }).catch(() => undefined)
      return
    }
    const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${value.trim()}" -ErrorAction SilentlyContinue; if ($p) { $p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress }`
    const found = await Process.text(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
      nothrow: true,
    })
    const info = (() => {
      try {
        return JSON.parse(found.text) as { ExecutablePath?: string; CommandLine?: string }
      } catch {
        return undefined
      }
    })()
    const target = executable(await read()).toLowerCase()
    const executablePath = info?.ExecutablePath ? path.resolve(info.ExecutablePath).toLowerCase() : ""
    const command = info?.CommandLine?.toLowerCase() ?? ""
    if (executablePath !== target && !command.includes(target)) {
      await fs.rm(pid(), { force: true }).catch(() => undefined)
      return
    }
    await Process.run(["taskkill", "/pid", value.trim(), "/T", "/F"], { nothrow: true })
    await fs.rm(pid(), { force: true }).catch(() => undefined)
  }

  async function initialize() {
    if (init) return init
    init = (async () => {
      await stale()
      await fs.rm(path.join(work(), "output"), { recursive: true, force: true }).catch(() => undefined)
      const state = await read()
      if (state.install !== "installing") return
      await write({ ...state, install: "cancelled", message: "Configuration was interrupted. You can continue it." })
    })()
    return init
  }

  async function boot(value: number, target: string) {
    runtime = "starting"
    const state = await read()
    await fs.mkdir(work(), { recursive: true })
    await fs.rm(path.join(work(), "output"), { recursive: true, force: true }).catch(() => undefined)
    service = Process.spawn([target, "--host", "127.0.0.1", "--port", String(value)], {
      cwd: work(),
      env: env(state.runtime),
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = (data: Buffer) => void record(data.toString())
    service.stdout?.on("data", output)
    service.stderr?.on("data", output)
    if (service.pid) await Bun.write(pid(), String(service.pid))
    service.exited
      .then(() => {
        service = undefined
        runtime = "stopped"
        return fs.rm(pid(), { force: true })
      })
      .catch(() => undefined)

    const url = `http://127.0.0.1:${value}`
    const started = Date.now()
    while (Date.now() - started < 120_000) {
      if (!service) throw new Error("MinerU stopped before it became ready. See the detailed log for more information.")
      const healthy = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
        .then((res) => res.ok)
        .catch(() => false)
      if (healthy) {
        runtime = "running"
        return url
      }
      await Bun.sleep(750)
    }
    await stop()
    throw new Error("MinerU did not become ready within 120 seconds")
  }

  async function launch(value: number, target?: string) {
    if (service && runtime === "running") return `http://127.0.0.1:${value}`
    if (launching) return launching
    launching = boot(value, target ?? executable(await read()))
      .catch((err: unknown) => {
        runtime = "stopped"
        throw err
      })
      .finally(() => {
        launching = undefined
      })
    return launching
  }

  async function configure(version: string) {
    const signal = abort!.signal
    const state = await read()
    const completed = new Set(state.completed)
    const value = await port()
    const steps: Record<(typeof stages)[number], { message: string; run: () => Promise<void> }> = {
      check: {
        message: "Checking disk space and memory",
        run: async () => {
          assert()
          const space = await disk()
          if (space.free < 8 * 1024 ** 3) throw new Error("At least 8 GB of free disk space is required")
          const warning = [
            space.free < 20 * 1024 ** 3 ? "MinerU recommends reserving about 20 GB of disk space." : "",
            os.totalmem() < 16 * 1024 ** 3 ? "Less than 16 GB of memory is available; extraction may be slow." : "",
          ]
            .filter(Boolean)
            .join(" ")
          if (warning) await write({ ...(await read()), warning })
        },
      },
      uv: {
        message: `Downloading and verifying uv ${UV_VERSION}`,
        run: async () => {
          await fs.mkdir(path.dirname(uv()), { recursive: true })
          await fs.mkdir(path.dirname(zip()), { recursive: true })
          const cached = await hash(zip())
            .then((value) => value === UV_SHA256)
            .catch(() => false)
          if (!cached) {
            await fs.rm(zip(), { force: true })
            await download(UV_URL, zip(), signal)
          }
          if ((await hash(zip())) !== UV_SHA256) throw new Error("Downloaded uv checksum verification failed")
          await run(["tar.exe", "-xf", zip(), "-C", path.dirname(uv())], signal)
          if ((await hash(uv())) !== UV_EXE_SHA256) throw new Error("Extracted uv checksum verification failed")
        },
      },
      python: {
        message: `Installing Python ${PYTHON_VERSION}`,
        run: () => run([uv(), "python", "install", PYTHON_VERSION], signal),
      },
      venv: {
        message: "Creating an isolated Python environment",
        run: () => run([uv(), "venv", path.join(root(), "env"), "--python", PYTHON_VERSION, "--clear"], signal),
      },
      mineru: {
        message: `Installing MinerU ${version}`,
        run: () => run([uv(), "pip", "install", "--python", python(), `mineru[all]==${version}`], signal),
      },
      models: {
        message: "Downloading MinerU pipeline models from ModelScope",
        run: () => run([models(), "--source", SOURCE, "--model_type", "pipeline"], signal),
      },
      verify: {
        message: "Starting MinerU and running a health check",
        run: async () => {
          await launch(value, api())
          await stop()
        },
      },
    }

    for (const stage of stages) {
      if (completed.has(stage)) continue
      progress = undefined
      await write({
        ...(await read()),
        install: "installing",
        stage,
        port: value,
        message: steps[stage].message,
        error: undefined,
      })
      await steps[stage].run()
      completed.add(stage)
      await write({ ...(await read()), install: "installing", completed: [...completed], port: value })
    }

    await enable(`http://127.0.0.1:${value}`)
    await write({
      ...(await read()),
      install: "ready",
      stage: "verify",
      runtime: "managed",
      adopted_api: undefined,
      version,
      message: "MinerU is configured and ready",
      error: undefined,
    })
    await snapshot(await read())
  }

  export async function status() {
    await initialize()
    const state = await read()
    const current = state.stage ? stages.indexOf(state.stage) + 1 : state.completed.length
    const ready =
      state.install === "ready" &&
      (await fs
        .stat(executable(state))
        .then((item) => item.isFile())
        .catch(() => false))
    const install = state.install === "ready" && !ready ? "unconfigured" : state.install
    const available = supported()
    const detail = install === "ready" ? state.detail : undefined
    const config = state.runtime === "adopted" ? await modelconfig(state) : undefined
    const source = (process.env.MINERU_MODEL_SOURCE ?? config?.config?.["model-source"])?.toLowerCase()
    const origin = source === "modelscope" || source === "huggingface" || source === "local" ? source : undefined
    return Status.parse({
      supported: available,
      strategy: "skill",
      runtime: state.runtime,
      install,
      run: runtime,
      stage: state.stage,
      step: { current: Math.min(current, stages.length), total: stages.length },
      progress,
      message: !available
        ? "Managed MinerU is unavailable on this platform"
        : install === "unconfigured"
          ? "MinerU is not configured"
          : state.message || "MinerU is not configured",
      error: state.error,
      warning: state.warning,
      version:
        detail?.version ??
        (state.runtime === "managed"
          ? { uv: UV_VERSION, python: PYTHON_VERSION, mineru: state.version ?? MINERU_VERSION }
          : { mineru: state.version ?? MINERU_VERSION }),
      source: state.runtime === "adopted" ? (origin ?? detail?.source) : (detail?.source ?? SOURCE),
      backend: "pipeline",
      device: detail?.device ?? (state.runtime === "managed" ? "cpu" : undefined),
      directory:
        state.runtime === "adopted" && state.adopted_api
          ? path.dirname(path.dirname(state.adopted_api))
          : root(),
      data_directory: root(),
      executable: ready ? executable(state) : undefined,
      base_url: state.port ? `http://127.0.0.1:${state.port}` : undefined,
      started_at: state.started_at,
      elapsed: state.started_at ? Date.now() - state.started_at : undefined,
      size: detail?.storage.total,
      size_scope: state.runtime === "managed" ? "installation" : "detected",
      storage: detail?.storage,
      scanned_at: detail?.scanned_at,
      session: state.session,
      logs: recent.length
        ? recent
        : clean(
            await Bun.file(log())
              .text()
              .catch(() => ""),
          ).slice(-200),
    })
  }

  async function snapshot(state: Stored) {
    const detail = await profile(state)
    await write({ ...(await read()), detail })
  }

  export async function measure() {
    await initialize()
    assert()
    const state = await read()
    if (state.install !== "ready") throw new Error("MinerU has not been configured")
    if (!report)
      report = snapshot(state).finally(() => {
        report = undefined
      })
    await report
    return status()
  }

  async function resolve(channel: "validated" | "latest") {
    if (channel === "validated") return MINERU_VERSION
    const body = await fetch("https://pypi.org/pypi/mineru/json").then((res) => {
      if (!res.ok) throw new Error(`Failed to resolve MinerU from PyPI: HTTP ${res.status}`)
      return res.json() as Promise<unknown>
    })
    const version = z.object({ info: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+/) }) }).parse(body)
      .info.version
    return version
  }

  export async function install(input?: { reset?: boolean; channel?: "validated" | "latest" }) {
    await initialize()
    assert()
    if (task) return status()
    const current = await read()
    if (current.install === "ready" && !input?.reset) return status()
    if (input?.reset) {
      await stop()
      report = undefined
      await fs.rm(path.join(root(), "env"), { recursive: true, force: true })
      await fs.rm(cfg(), { force: true })
      const state = await read()
      await write({
        ...state,
        install: "unconfigured",
        detail: undefined,
        completed:
          state.runtime === "managed"
            ? state.completed.filter((stage) => ["check", "uv", "python"].includes(stage))
            : [],
      })
    }
    abort = new AbortController()
    const state = await read()
    const version =
      ["cancelled", "failed"].includes(state.install) && state.version
        ? state.version
        : await resolve(input?.channel ?? "validated")
    await write({
      ...state,
      install: "installing",
      runtime: "managed",
      adopted_api: undefined,
      version,
      detail: undefined,
      started_at: Date.now(),
      error: undefined,
      message: "Starting MinerU configuration",
    })
    task = configure(version)
      .catch(async (err: unknown) => {
        const cancelled = abort?.signal.aborted === true
        await write({
          ...(await read()),
          install: cancelled ? "cancelled" : "failed",
          message: cancelled ? "Configuration cancelled. Cached downloads were kept." : "MinerU configuration failed",
          error: cancelled ? undefined : err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        task = undefined
        abort = undefined
        child = undefined
        progress = undefined
      })
    return status()
  }

  export async function wait() {
    await task?.catch(() => undefined)
    return status()
  }

  export async function cancel() {
    const current = task
    abort?.abort(new Error("MinerU configuration cancelled"))
    if (child) await Process.stop(child)
    await current?.catch(() => undefined)
    return status()
  }

  export async function adopt(id: string) {
    await initialize()
    assert()
    const item = candidates.get(id)
    if (!item) throw new Error("MinerU candidate expired. Inspect the environment again before adopting it.")
    const checked = await candidate(item.path)
    if (!checked || checked.id !== item.id) throw new Error("The selected MinerU installation could not be verified")
    await stop()
    report = undefined
    const value = await port()
    const state: Stored = {
      ...(await read()),
      install: "installing",
      runtime: "adopted",
      adopted_api: checked.path,
      version: checked.version,
      detail: undefined,
      completed: [...stages],
      stage: "verify",
      port: value,
      message: "Existing MinerU environment adopted",
      error: undefined,
    }
    await write(state)
    await launch(value, checked.path).catch(async (err: unknown) => {
      await write({
        ...state,
        install: "failed",
        message: "The existing MinerU environment could not be started",
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    })
    await stop()
    await enable(`http://127.0.0.1:${value}`)
    await write({ ...state, install: "ready" })
    await snapshot(await read())
    return status()
  }

  export async function verify() {
    assert()
    const state = await read()
    if (state.install !== "ready" || !state.port) throw new Error("MinerU has not been configured")
    await launch(state.port, executable(state))
    await stop()
    return status()
  }

  export async function link(input: { id: string; directory: string }) {
    assert()
    const state = await read()
    await write({ ...state, session: input })
    return status()
  }

  export async function start() {
    await initialize()
    assert()
    const state = await read()
    if (state.install !== "ready" || !state.port) throw new Error("MinerU has not been configured")
    await launch(state.port, executable(state))
    return status()
  }

  async function halt() {
    const current = service
    service = undefined
    runtime = "stopped"
    if (current) await Process.stop(current)
    await fs.rm(pid(), { force: true }).catch(() => undefined)
  }

  export async function stop() {
    await halt()
    return status()
  }

  export async function dispose() {
    if (!abort && !child && !service && !launching && !task) return
    abort?.abort(new Error("Aether is shutting down"))
    if (child) await Process.stop(child)
    await halt()
    await task?.catch(() => undefined)
  }

  export async function uninstall() {
    assert()
    return plan(await read())
  }

  export async function remove(input: { adopted?: boolean } = {}) {
    assert()
    const state = await read()
    await cancel()
    await stop()
    await erase(state, input)
    init = undefined
    recent = []
    report = undefined
    const current = await Config.getGlobal()
    await Config.updateGlobal({
      experimental: {
        ...current.experimental,
        attachment_text_extraction: {
          ...current.experimental?.attachment_text_extraction,
          enabled: false,
        },
      },
    })
    return status()
  }

  export async function cleanup(id: string, url: string) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return false
    const state = await read()
    if (!state.port || url.replace(/\/+$/, "") !== `http://127.0.0.1:${state.port}`) return false
    const base = path.resolve(work(), "output")
    const target = path.resolve(base, id)
    if (path.dirname(target) !== base) return false
    await fs.rm(target, { recursive: true, force: true })
    report = undefined
    return true
  }

  export async function logs() {
    return Bun.file(log())
      .text()
      .catch(() => "")
  }

  async function reset() {
    await dispose()
    await fs.rm(root(), { recursive: true, force: true })
    init = undefined
    recent = []
    progress = undefined
    report = undefined
    runtime = "stopped"
  }

  export const Test = {
    stages,
    bytes,
    clean,
    supported,
    env,
    port,
    candidate,
    discover,
    cleanup,
    safe,
    plan,
    erase,
    async measure() {
      await snapshot(await read())
      return status()
    },
    read,
    write,
    reset,
    reload() {
      init = undefined
    },
  }
}
