import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import launch from "cross-spawn"
import { Global } from "@/global"
import type { LatexSchema } from "./schema"

export namespace LatexSetup {
  const version = "0.17.0"
  const base = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/"
  type Asset = { name: string; size: number; sha256: string; format: "zip" | "tar.gz" }
  // Official release metadata and asset digests, pinned independently of HTTP responses:
  // https://github.com/tectonic-typesetting/tectonic/releases/tag/tectonic%400.17.0
  const assets: Record<string, Asset> = {
    "win32-x64": {
      // The official MSVC build statically links both CRT and vcpkg libraries;
      // the GNU CI build relies on an MSYS2 environment rather than a standalone Windows runtime.
      // https://github.com/tectonic-typesetting/tectonic/blob/tectonic%400.17.0/dist/vcpkg-triplets/x64-windows-static-release.cmake
      name: "tectonic-0.17.0-x86_64-pc-windows-msvc.zip",
      size: 21060223,
      sha256: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
      format: "zip",
    },
    "darwin-arm64": {
      name: "tectonic-0.17.0-aarch64-apple-darwin.tar.gz",
      size: 21704674,
      sha256: "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667",
      format: "tar.gz",
    },
    "darwin-x64": {
      name: "tectonic-0.17.0-x86_64-apple-darwin.tar.gz",
      size: 21790177,
      sha256: "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80",
      format: "tar.gz",
    },
    "linux-arm64": {
      name: "tectonic-0.17.0-aarch64-unknown-linux-musl.tar.gz",
      size: 9926834,
      sha256: "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8",
      format: "tar.gz",
    },
    "linux-x64": {
      name: "tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz",
      size: 10151914,
      sha256: "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7",
      format: "tar.gz",
    },
  }

  function probe(file: string, signal: AbortSignal) {
    signal.throwIfAborted()
    return new Promise<string>((resolve, reject) => {
      const child = launch(file, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      const state = {
        text: "",
        bytes: 0,
        settled: false,
        error: undefined as Error | undefined,
        guard: undefined as ReturnType<typeof setTimeout> | undefined,
      }
      const stop = (error: Error) => {
        if (state.settled) return
        state.error ??= error
        child.kill("SIGKILL")
        state.guard ??= setTimeout(() => finish(state.error), 2000)
      }
      const finish = (error?: Error) => {
        if (state.settled) return
        state.settled = true
        clearTimeout(timer)
        clearTimeout(state.guard)
        signal.removeEventListener("abort", abort)
        if (error) return reject(error)
        resolve(state.text.trim())
      }
      const abort = () => stop(new Error("Tectonic installation was cancelled."))
      const timer = setTimeout(() => stop(new Error("Tectonic version verification timed out.")), 10_000)
      const consume = (chunk: Buffer) => {
        state.bytes += chunk.length
        if (state.bytes > 64 * 1024) return stop(new Error("Tectonic version output exceeded its limit."))
        state.text += chunk.toString("utf8")
      }
      child.stdout?.on("data", consume)
      child.stderr?.on("data", consume)
      child.once("error", (error) => finish(error))
      child.once("close", (code) =>
        finish(state.error ?? (code !== 0 ? new Error("Tectonic could not run on this computer.") : undefined)),
      )
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  /** Internal dependency seam for offline fixtures; HTTP routes must call the singleton without options. */
  export function create(opts: {
    root: string
    platform?: string
    arch?: string
    fetch?: (url: string, init?: RequestInit) => Promise<Response>
    probe?: typeof probe
    asset?: Asset
    timeout?: number
  }) {
    const platform = opts.platform ?? process.platform
    const arch = opts.arch ?? process.arch
    const asset = opts.asset ?? assets[`${platform}-${arch}`]
    const filename = platform === "win32" ? "tectonic.exe" : "tectonic"
    const root = path.resolve(opts.root)
    const active = path.join(root, "active.json")
    const state: { value: LatexSchema.Setup; job?: Promise<void>; controller?: AbortController } = {
      value: {
        state: "idle",
        supported: !!asset,
        version,
        downloaded: 0,
        ...(!asset ? { error: "Automatic Tectonic installation is unavailable for this platform." } : {}),
      },
    }

    async function manifest() {
      const parent = await fs.lstat(root).catch(() => undefined)
      if (!parent?.isDirectory() || parent.isSymbolicLink()) return
      const file = await fs.lstat(active).catch(() => undefined)
      if (!file?.isFile() || file.isSymbolicLink() || file.size > 4096) return
      const value: unknown = await Bun.file(active)
        .json()
        .catch(() => undefined)
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        !("version" in value) ||
        !("platform" in value) ||
        !("binary" in value) ||
        !("size" in value)
      )
        return
      if (
        typeof value.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)
      )
        return
      if (
        typeof value.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(value.version) ||
        value.platform !== `${platform}-${arch}`
      )
        return
      if (
        typeof value.binary !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.binary) ||
        typeof value.size !== "number" ||
        value.size <= 0 ||
        value.size > 256 * 1024 * 1024
      )
        return
      const dir = path.join(root, value.id)
      const directory = await fs.lstat(dir).catch(() => undefined)
      if (!directory?.isDirectory() || directory.isSymbolicLink()) return
      const target = path.join(dir, filename)
      const stat = await fs.lstat(target).catch(() => undefined)
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== value.size) return
      return { path: target, version: value.version, sha256: value.binary }
    }

    async function status(): Promise<LatexSchema.Setup> {
      const installed = await manifest()
      const value = { ...state.value }
      delete value.path
      if (!state.job && value.state === "ready" && !installed) value.state = "idle"
      if (!state.job && value.state === "idle" && installed) value.state = "ready"
      return { ...value, ...(installed ? { path: installed.path } : {}) }
    }

    async function install(signal: AbortSignal, asset: Asset) {
      const id = randomUUID()
      const staging = path.join(root, `.tmp-${id}`)
      const directory = path.join(root, id)
      const pointer = path.join(root, `.active-${id}.json`)
      const flags = { published: false }
      try {
        await fs.mkdir(root, { recursive: true, mode: 0o700 })
        const info = await fs.lstat(root)
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("The managed Tectonic directory must be a regular directory.")
        await fs.mkdir(staging, { mode: 0o700 })
        signal.throwIfAborted()
        const response = await (opts.fetch ?? globalThis.fetch)(`${base}${asset.name}`, { signal, redirect: "follow" })
        if (!response.ok || !response.body) throw new Error(`Tectonic download failed (HTTP ${response.status}).`)
        const expected = response.headers.get("content-length")
        if (expected !== null && Number(expected) !== asset.size) {
          await response.body.cancel()
          throw new Error("The Tectonic download size differs from the pinned release.")
        }
        state.value.total = asset.size
        const chunks: Uint8Array[] = []
        const reader = response.body.getReader()
        try {
          while (true) {
            signal.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            state.value.downloaded += chunk.value.byteLength
            if (state.value.downloaded > asset.size) throw new Error("The Tectonic download exceeded its pinned size.")
            chunks.push(chunk.value)
          }
        } finally {
          await reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        signal.throwIfAborted()
        state.value.state = "verifying"
        const bytes = Buffer.concat(chunks)
        if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
          throw new Error("Tectonic checksum verification failed. No executable was installed.")
        state.value.state = "extracting"
        const executable = path.join(staging, filename)
        const binary = await (await import("./archive")).unpack(bytes, asset.format, filename, signal)
        if (!binary.length) throw new Error("The Tectonic executable is empty.")
        await fs.writeFile(executable, binary, { flag: "wx", mode: 0o700 })
        state.value.state = "checking"
        signal.throwIfAborted()
        const output = await (opts.probe ?? probe)(executable, signal)
        if (!/^tectonic\s+0\.17\.0(?:\s|$)/im.test(output))
          throw new Error("The downloaded program did not report Tectonic 0.17.0.")
        signal.throwIfAborted()
        await fs.rename(staging, directory)
        await fs.writeFile(
          pointer,
          JSON.stringify({
            id,
            version,
            platform: `${platform}-${arch}`,
            sha256: asset.sha256,
            binary: createHash("sha256").update(binary).digest("hex"),
            size: binary.length,
          }),
          { flag: "wx", mode: 0o600 },
        )
        signal.throwIfAborted()
        // Only the tiny pointer is replaced. Existing binaries remain valid for
        // ongoing compilation, including on Windows where loaded executables lock.
        await fs.rename(pointer, active)
        flags.published = true
        state.value = {
          state: "ready",
          supported: true,
          version,
          downloaded: asset.size,
          total: asset.size,
          path: path.join(directory, filename),
        }
      } finally {
        await fs.rm(pointer, { force: true }).catch(() => undefined)
        await fs.rm(staging, { force: true, recursive: true }).catch(() => undefined)
        if (!flags.published) await fs.rm(directory, { force: true, recursive: true }).catch(() => undefined)
      }
    }

    async function start() {
      if (state.job || !asset) return status()
      const controller = new AbortController()
      state.controller = controller
      state.value = { state: "downloading", supported: true, version, downloaded: 0, total: asset.size }
      const timer = setTimeout(
        () => controller.abort(new Error("Tectonic installation exceeded its time limit.")),
        opts.timeout ?? 180_000,
      )
      state.job = (async () => {
        const installed = await manifest()
        if (installed?.version === version) {
          state.value.state = "checking"
          const digest = createHash("sha256")
            .update(await Bun.file(installed.path).bytes())
            .digest("hex")
          const valid =
            digest === installed.sha256 &&
            (await (opts.probe ?? probe)(installed.path, controller.signal)
              .then((output) => /^tectonic\s+0\.17\.0(?:\s|$)/im.test(output))
              .catch(() => false))
          controller.signal.throwIfAborted()
          if (valid) {
            state.value = { state: "ready", supported: true, version, downloaded: 0, path: installed.path }
            return
          }
        }
        state.value.state = "downloading"
        await install(controller.signal, asset)
      })()
        .catch((error: unknown) => {
          const reason: unknown = controller.signal.aborted ? controller.signal.reason : error
          state.value = {
            ...state.value,
            state: reason === "cancelled" ? "cancelled" : "failed",
            error: reason instanceof Error ? reason.message : "Tectonic installation was cancelled.",
          }
        })
        .finally(() => {
          clearTimeout(timer)
          state.job = undefined
          state.controller = undefined
        })
      return status()
    }

    return {
      status,
      start,
      async cancel() {
        state.controller?.abort("cancelled")
        await state.job
        return status()
      },
      async executable() {
        return (await manifest())?.path
      },
    }
  }

  const singleton = create({ root: path.join(Global.Path.data, "tools", "tectonic") })
  export const status = singleton.status
  export const start = singleton.start
  export const cancel = singleton.cancel
  export const executable = singleton.executable
}
