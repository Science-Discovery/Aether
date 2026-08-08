import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { createServer } from "net"
import path from "path"
import { Global } from "../../src/global"
import { ManagedMinerU } from "../../src/mineru/managed"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { MineruConvertTool, MineruStartTool, MineruStatusTool } from "../../src/tool/mineru"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: SessionID.make("ses_mineru_tool"),
  messageID: MessageID.make("msg_mineru_tool"),
  callID: "call_mineru_tool",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe.serial("managed MinerU skill setup", () => {
  afterEach(async () => {
    await ManagedMinerU.Test.reset()
    await Instance.disposeAll()
  })

  test("limits setup to the Windows x64 desktop sidecar", () => {
    expect(ManagedMinerU.Test.supported({ platform: "win32", arch: "x64", client: "desktop" })).toBe(true)
    expect(ManagedMinerU.Test.supported({ platform: "win32", arch: "arm64", client: "desktop" })).toBe(false)
    expect(ManagedMinerU.Test.supported({ platform: "linux", arch: "x64", client: "desktop" })).toBe(false)
    expect(ManagedMinerU.Test.supported({ platform: "win32", arch: "x64", client: "app" })).toBe(false)
  })

  test("blocks runtime management outside the desktop sidecar", async () => {
    if (ManagedMinerU.Test.supported()) return
    await expect(ManagedMinerU.start()).rejects.toThrow("Windows x64 desktop")
    await expect(ManagedMinerU.remove()).rejects.toThrow("Windows x64 desktop")
  })

  test("reports exact byte progress only when it is available", () => {
    expect(ManagedMinerU.Test.bytes("Downloading 12.5 MiB / 100 MiB")).toEqual({
      current: 12.5 * 1024 ** 2,
      total: 100 * 1024 ** 2,
      unit: "byte",
    })
    expect(ManagedMinerU.Test.bytes("Resolving packages...")).toBeUndefined()
  })

  test("redacts common credentials before logs enter tool context", () => {
    expect(ManagedMinerU.Test.clean("Authorization: Bearer-123\nAPI_KEY=secret\nprogress")).toEqual([
      "Authorization: [redacted]",
      "API_KEY=[redacted]",
      "progress",
    ])
  })

  test("isolates caches and outputs below the Aether data directory", () => {
    const env = ManagedMinerU.Test.env()
    const root = path.join(Global.Path.data, "mineru")
    for (const key of [
      "UV_PYTHON_INSTALL_DIR",
      "UV_CACHE_DIR",
      "MODELSCOPE_CACHE",
      "HF_HOME",
      "TORCH_HOME",
      "MINERU_TOOLS_CONFIG_JSON",
      "MINERU_API_OUTPUT_ROOT",
    ] as const) {
      expect(path.resolve(env[key]).startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true)
    }
    expect(env.MINERU_MODEL_SOURCE).toBe("modelscope")
  })

  test("does not redirect an adopted environment's model caches", () => {
    const env = ManagedMinerU.Test.env("adopted")
    expect(env.MINERU_API_OUTPUT_ROOT).toStartWith(path.join(Global.Path.data, "mineru"))
    expect("MODELSCOPE_CACHE" in env).toBe(false)
    expect("HF_HOME" in env).toBe(false)
    expect("MINERU_MODEL_SOURCE" in env).toBe(false)
  })

  test("inspects an existing environment without executing it", async () => {
    if (process.platform !== "win32") return
    const root = path.join(Global.Path.data, "candidate")
    const api = path.join(root, "Scripts", "mineru-api.exe")
    const dist = path.join(root, "Lib", "site-packages", "mineru-3.4.4.dist-info")
    await fs.mkdir(path.dirname(api), { recursive: true })
    await fs.mkdir(dist, { recursive: true })
    await Bun.write(api, "not executable")
    await Bun.write(path.join(dist, "METADATA"), "Name: mineru\nVersion: 3.4.4\n")
    expect(await ManagedMinerU.Test.candidate(api)).toMatchObject({ path: api, version: "3.4.4" })
  })

  test("discovers a user-level MinerU virtual environment outside PATH", async () => {
    const home = path.join(Global.Path.data, "home")
    const api = path.join(home, "mineru-env", "Scripts", "mineru-api.exe")
    await fs.mkdir(path.dirname(api), { recursive: true })
    await Bun.write(api, "not executable")
    expect(await ManagedMinerU.Test.discover(home)).toEqual([api])
  })

  test("turns an interrupted stage into resumable state", async () => {
    await ManagedMinerU.Test.write({
      install: "installing",
      stage: "models",
      completed: ["check", "uv", "python", "venv", "mineru"],
      port: 8000,
      message: "Downloading models",
      started_at: Date.now(),
      runtime: "managed",
    })
    ManagedMinerU.Test.reload()
    const status = await ManagedMinerU.status()
    expect(status.install).toBe("cancelled")
    expect(status.stage).toBe("models")
    expect((await ManagedMinerU.Test.read()).completed).toEqual(["check", "uv", "python", "venv", "mineru"])
  })

  test("reports the managed installation directory, components, and disk scope", async () => {
    const root = path.join(Global.Path.data, "mineru")
    const api = path.join(root, "env", "Scripts", "mineru-api.exe")
    await fs.mkdir(path.dirname(api), { recursive: true })
    await Bun.write(api, "managed")
    await ManagedMinerU.Test.write({
      install: "ready",
      stage: "verify",
      completed: [...ManagedMinerU.Test.stages],
      port: 8000,
      message: "Ready",
      runtime: "managed",
      version: "3.4.4",
    })
    ManagedMinerU.Test.reload()

    const status = await ManagedMinerU.status()
    expect(status).toMatchObject({
      install: "ready",
      runtime: "managed",
      directory: root,
      data_directory: root,
      executable: api,
      version: { uv: "0.12.1", python: "3.12.10", mineru: "3.4.4" },
      source: "modelscope",
      backend: "pipeline",
      device: "cpu",
      size_scope: "installation",
    })
  })

  test("reports detected versions and storage for an adopted environment", async () => {
    const root = path.join(Global.Path.data, "existing")
    const api = path.join(root, "Scripts", "mineru-api.exe")
    const model = path.join(Global.Path.home, ".cache", "huggingface", "hub", "model.bin")
    await fs.mkdir(path.dirname(api), { recursive: true })
    await fs.mkdir(path.dirname(model), { recursive: true })
    await Bun.write(api, "adopted")
    await Bun.write(model, "model")
    await ManagedMinerU.Test.write({
      install: "ready",
      stage: "verify",
      completed: [...ManagedMinerU.Test.stages],
      port: 8000,
      message: "Ready",
      runtime: "adopted",
      adopted_api: api,
      version: "3.4.4",
    })
    ManagedMinerU.Test.reload()

    const before = await ManagedMinerU.status()
    expect(before.storage).toBeUndefined()

    const status = await ManagedMinerU.Test.measure()
    expect(status.directory).toBe(root)
    expect(status.version).toEqual({ mineru: "3.4.4" })
    expect(status.source).toBe("huggingface")
    expect(status.backend).toBe("pipeline")
    expect(status.device).toBe("auto")
    expect(status.size_scope).toBe("detected")
    expect(status.storage?.environment).toBeGreaterThan(0)
    expect(status.storage?.models).toBe(5)
    expect(status.storage?.aether).toBeGreaterThan(0)
    expect(status.storage?.total).toBe(
      status.storage!.environment + status.storage!.models + status.storage!.aether,
    )

    const saved = status.scanned_at
    ManagedMinerU.Test.reload()
    expect((await ManagedMinerU.status()).scanned_at).toBe(saved)
  })

  test("plans and removes only an explicitly confirmed adopted MinerU environment", async () => {
    const env = path.join(Global.Path.home, "mineru-delete-test")
    const api = path.join(env, "Scripts", "mineru-api.exe")
    const dist = path.join(env, "Lib", "site-packages", "mineru-3.4.4.dist-info")
    const hf = path.join(
      Global.Path.home,
      ".cache",
      "huggingface",
      "hub",
      "models--opendatalab--PDF-Extract-Kit-1.0",
    )
    const ms = path.join(Global.Path.home, ".cache", "modelscope", "models", "OpenDataLab--PDF-Extract-Kit-1.0")
    const lock = path.join(
      Global.Path.home,
      ".cache",
      "huggingface",
      "hub",
      ".locks",
      "models--opendatalab--PDF-Extract-Kit-1.0",
    )
    const other = path.join(Global.Path.home, ".cache", "modelscope", "models", "unrelated-model")
    const config = path.join(Global.Path.home, "mineru.json")
    await Promise.all([
      fs.mkdir(path.dirname(api), { recursive: true }),
      fs.mkdir(dist, { recursive: true }),
      fs.mkdir(path.join(hf, "snapshots", "main"), { recursive: true }),
      fs.mkdir(path.join(ms, "snapshots", "master"), { recursive: true }),
      fs.mkdir(lock, { recursive: true }),
      fs.mkdir(other, { recursive: true }),
    ])
    await Promise.all([
      Bun.write(api, "adopted"),
      Bun.write(path.join(dist, "METADATA"), "Name: mineru\nVersion: 3.4.4\n"),
      Bun.write(path.join(hf, "snapshots", "main", "model.bin"), "hf"),
      Bun.write(path.join(ms, "snapshots", "master", "model.bin"), "modelscope"),
      Bun.write(path.join(lock, "download.lock"), "lock"),
      Bun.write(path.join(other, "model.bin"), "keep"),
      Bun.write(
        config,
        JSON.stringify({
          "model-source": "modelscope",
          "models-dir": { pipeline: path.join(ms, "snapshots", "master") },
        }),
      ),
    ])
    await ManagedMinerU.Test.write({
      install: "ready",
      stage: "verify",
      completed: [...ManagedMinerU.Test.stages],
      port: 8000,
      message: "Ready",
      runtime: "adopted",
      adopted_api: api,
      version: "3.4.4",
    })
    expect((await ManagedMinerU.Test.measure()).source).toBe("modelscope")
    const state = await ManagedMinerU.Test.read()
    const plan = await ManagedMinerU.Test.plan(state)

    expect(plan.runtime).toBe("adopted")
    expect(plan.environment?.path).toBe(env)
    expect(plan.models.map((item) => item.path).sort()).toEqual([hf, lock, ms].sort())
    expect(plan.models.map((item) => item.path)).not.toContain(path.dirname(other))
    expect(plan.config).toBe(config)
    expect(plan.removable).toBeGreaterThan(0)

    await ManagedMinerU.Test.erase(state, { adopted: false })
    expect(await fs.stat(api).then(() => true)).toBe(true)
    expect(await fs.stat(path.join(ms, "snapshots", "master", "model.bin")).then(() => true)).toBe(true)

    if (process.platform === "win32") {
      await ManagedMinerU.Test.erase(state, { adopted: true })
      expect(await fs.stat(env).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.stat(hf).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.stat(ms).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.stat(lock).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.stat(config).then(() => true).catch(() => false)).toBe(false)
    }
    expect(await fs.stat(other).then(() => true)).toBe(true)
    await Promise.all([env, hf, ms, lock, config, other].map((item) => fs.rm(item, { recursive: true, force: true })))
    expect(await fs.stat(path.dirname(other)).then((item) => item.isDirectory())).toBe(true)
  })

  test("skips a persisted port when it is occupied", async () => {
    const bind = async (port: number) => {
      const server = createServer()
      return new Promise<{ server: ReturnType<typeof createServer>; port: number } | undefined>((resolve) => {
        server.once("error", () => resolve(undefined))
        server.listen(port, "127.0.0.1", () => resolve({ server, port }))
      })
    }
    const item = await Array.from({ length: 100 }, (_, idx) => 8000 + idx).reduce(
      async (result, port) => (await result) ?? bind(port),
      Promise.resolve<{ server: ReturnType<typeof createServer>; port: number } | undefined>(undefined),
    )
    expect(item).toBeDefined()
    if (!item) return
    try {
      await ManagedMinerU.Test.write({
        install: "unconfigured",
        completed: [],
        port: item.port,
        message: "",
        runtime: "managed",
      })
      expect(await ManagedMinerU.Test.port()).not.toBe(item.port)
    } finally {
      await new Promise<void>((resolve) => item.server.close(() => resolve()))
    }
  })

  test("only removes output owned by the configured local service", async () => {
    const dir = path.join(Global.Path.data, "mineru", "work", "output", "job-1")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "result.md"), "result")
    await ManagedMinerU.Test.write({
      install: "ready",
      stage: "verify",
      completed: [...ManagedMinerU.Test.stages],
      port: 8099,
      message: "ready",
      runtime: "managed",
    })
    expect(await ManagedMinerU.Test.cleanup("../job-1", "http://127.0.0.1:8099")).toBe(false)
    expect(await ManagedMinerU.Test.cleanup("job-1", "http://127.0.0.1:8000")).toBe(false)
    expect(await ManagedMinerU.Test.cleanup("job-1", "http://127.0.0.1:8099")).toBe(true)
    expect(
      await fs
        .stat(dir)
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
  })

  test("reports status but blocks start and conversion before managed setup is ready", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            experimental: { attachment_text_extraction: { mineru: { mode: "managed" } } },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const status = await MineruStatusTool.init()
        const start = await MineruStartTool.init()
        const convert = await MineruConvertTool.init()
        const result = await status.execute({}, ctx)
        expect(JSON.parse(result.output)).toMatchObject({
          configured: false,
          mode: "managed",
          ai_conversion_available: false,
        })
        await expect(start.execute({}, ctx)).rejects.toThrow("has not been configured")
        await expect(convert.execute({ input: "paper.pdf" }, ctx)).rejects.toThrow("has not been configured")
      },
    })
  })

  test("detects a custom service without contacting it and refuses AI file transfer", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "paper.pdf"), "%PDF")
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            experimental: {
              attachment_text_extraction: {
                mineru: { mode: "external", base_url: "https://mineru.example.invalid" },
              },
            },
          }),
        )
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const status = await MineruStatusTool.init()
        const convert = await MineruConvertTool.init()
        expect(JSON.parse((await status.execute({}, ctx)).output)).toMatchObject({
          configured: true,
          mode: "external",
          ai_conversion_available: false,
        })
        await expect(convert.execute({ input: "paper.pdf" }, ctx)).rejects.toThrow("cannot send files")
      },
    })
  })
})
