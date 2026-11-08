import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Global } from "@/global"
import type { LatexSchema } from "../schema"
import { extract } from "./archive"

export namespace LatexRtex {
  const version = "0.0.6"
  const base = "https://github.com/HenryXiaoYang/realtime-tex/releases/download/v0.0.6/"
  type Asset = { name: string; size: number; sha256: string; format: "zip" | "tar.gz" }
  const assets: Record<string, Asset> = {
    "linux-x64": {
      name: "rtex-x86_64-unknown-linux-gnu.tar.gz",
      size: 5173934,
      sha256: "c96803e6e6c2b6dc1bfda779220f7cb253c61b31a161fd1072349f1435b2dad6",
      format: "tar.gz",
    },
    "linux-arm64": {
      name: "rtex-aarch64-unknown-linux-gnu.tar.gz",
      size: 4703777,
      sha256: "a7ba336e0085541b3416b827325fe1b5e82014544fa3bfcb3e3728bb073e3f6f",
      format: "tar.gz",
    },
    "darwin-arm64": {
      name: "rtex-aarch64-apple-darwin.tar.gz",
      size: 4530912,
      sha256: "99f56b8cde472de0c4c3b4814f7453e97f789ace9e3114a9d7e9f9df2cb68864",
      format: "tar.gz",
    },
    "darwin-x64": {
      name: "rtex-x86_64-apple-darwin.tar.gz",
      size: 4890256,
      sha256: "d28bf8efcaf479161e3b0049142afca67a004dd547ed699a714e8d51b14afad1",
      format: "tar.gz",
    },
    "win32-x64": {
      name: "rtex-x86_64-pc-windows-msvc.zip",
      size: 4821555,
      sha256: "f7df89e265b843a824c880b806f1671bc3e6d5e8acdfd0a29aff713e42b32e4d",
      format: "zip",
    },
  }

  function probe(file: string, signal: AbortSignal) {
    signal.throwIfAborted()
    return new Promise<string>((resolve, reject) => {
      const child = Bun.spawn([file, "--version"], { stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error("rtex version verification timed out."))
      }, 10_000)
      const abort = () => {
        child.kill()
        reject(new Error("rtex installation was cancelled."))
      }
      signal.addEventListener("abort", abort, { once: true })
      void child.exited.then(async (code) => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
        if (signal.aborted) return reject(new Error("rtex installation was cancelled."))
        if (code !== 0) return reject(new Error("rtex could not run on this computer."))
        resolve(output)
      })
    })
  }

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
    const filename = platform === "win32" ? "rtex.exe" : "rtex"
    const root = path.resolve(opts.root)
    const active = path.join(root, "active.json")
    const state: { value: LatexSchema.Setup; job?: Promise<void>; controller?: AbortController } = {
      value: {
        state: "idle",
        supported: !!asset,
        version,
        downloaded: 0,
        ...(!asset ? { error: "Automatic rtex installation is unavailable for this platform." } : {}),
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
      if (!value || typeof value !== "object") return
      const data = value as Record<string, unknown>
      if (
        typeof data.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.id) ||
        data.version !== version ||
        data.platform !== `${platform}-${arch}` ||
        typeof data.folder !== "string" ||
        !/^[A-Za-z0-9._-]+$/.test(data.folder) ||
        typeof data.binary !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.binary) ||
        typeof data.size !== "number"
      )
        return
      const dir = path.join(root, data.id)
      const directory = await fs.lstat(dir).catch(() => undefined)
      if (!directory?.isDirectory() || directory.isSymbolicLink()) return
      const bin = path.join(dir, data.folder, "bin", filename)
      const stat = await fs.lstat(bin).catch(() => undefined)
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== data.size) return
      const texdir = path.join(dir, data.folder, "share", "rtex", "tex")
      const tex = await fs.lstat(texdir).catch(() => undefined)
      if (!tex?.isDirectory() || tex.isSymbolicLink()) return
      return { path: bin, texdir, version, folder: data.folder, binary: data.binary, size: data.size }
    }

    async function status(): Promise<LatexSchema.RealtimeStatus> {
      const installed = await manifest()
      const value = { ...state.value }
      delete value.path
      if (!state.job && value.state === "ready" && !installed) value.state = "idle"
      if (!state.job && value.state === "idle" && installed) value.state = "ready"
      return {
        installed: !!installed,
        ...(installed ? { path: installed.path, version: installed.version } : {}),
        setup: { ...value, ...(installed ? { path: installed.path } : {}) },
      }
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
          throw new Error("The managed rtex directory must be a regular directory.")
        await fs.mkdir(staging, { mode: 0o700 })
        signal.throwIfAborted()
        const response = await (opts.fetch ?? globalThis.fetch)(`${base}${asset.name}`, { signal, redirect: "follow" })
        if (!response.ok || !response.body) throw new Error(`rtex download failed (HTTP ${response.status}).`)
        const expected = response.headers.get("content-length")
        if (expected !== null && Number(expected) !== asset.size) {
          await response.body.cancel()
          throw new Error("The rtex download size differs from the pinned release.")
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
            if (state.value.downloaded > asset.size) throw new Error("The rtex download exceeded its pinned size.")
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
          throw new Error("rtex checksum verification failed. No executable was installed.")
        state.value.state = "extracting"
        await extract(bytes, asset.format, staging, signal)
        const folder = await (async () => {
          for (const entry of await fs.readdir(staging, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            const bin = path.join(staging, entry.name, "bin", filename)
            if (
              await fs
                .lstat(bin)
                .then((stat) => stat.isFile())
                .catch(() => false)
            )
              return entry.name
          }
        })()
        if (!folder) throw new Error("The rtex archive does not contain an executable folder.")
        const executable = path.join(staging, folder, "bin", filename)
        const texdir = path.join(staging, folder, "share", "rtex", "tex")
        const stat = await fs.lstat(executable).catch(() => undefined)
        if (!stat?.isFile() || stat.isSymbolicLink())
          throw new Error("The rtex archive does not contain its executable.")
        const tex = await fs.lstat(texdir).catch(() => undefined)
        if (!tex?.isDirectory()) throw new Error("The rtex archive does not contain its TeX support files.")
        await fs.chmod(executable, 0o700)
        state.value.state = "checking"
        signal.throwIfAborted()
        const output = await (opts.probe ?? probe)(executable, signal)
        if (!new RegExp(`^rtex\\s+${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(output))
          throw new Error(`The downloaded program did not report rtex ${version}.`)
        signal.throwIfAborted()
        const binary = createHash("sha256")
          .update(await Bun.file(executable).bytes())
          .digest("hex")
        await fs.rename(staging, directory)
        await fs.writeFile(
          pointer,
          JSON.stringify({
            id,
            version,
            platform: `${platform}-${arch}`,
            folder,
            binary,
            size: stat.size,
          }),
          { flag: "wx", mode: 0o600 },
        )
        signal.throwIfAborted()
        await fs.rename(pointer, active)
        flags.published = true
        state.value = {
          state: "ready",
          supported: true,
          version,
          downloaded: asset.size,
          total: asset.size,
          path: path.join(directory, folder, "bin", filename),
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
        () => controller.abort(new Error("rtex installation exceeded its time limit.")),
        opts.timeout ?? 180_000,
      )
      state.job = (async () => {
        const installed = await manifest()
        if (installed) {
          state.value.state = "checking"
          const digest = createHash("sha256")
            .update(await Bun.file(installed.path).bytes())
            .digest("hex")
          const valid =
            digest === installed.binary &&
            (await (opts.probe ?? probe)(installed.path, controller.signal)
              .then((output) => new RegExp(`^rtex\\s+${version.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(output))
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
            error: reason instanceof Error ? reason.message : "rtex installation was cancelled.",
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
        const installed = await manifest()
        return installed ? { path: installed.path, texdir: installed.texdir } : undefined
      },
    }
  }

  const singleton = create({ root: path.join(Global.Path.data, "tools", "rtex") })
  export const status = singleton.status
  export const start = singleton.start
  export const cancel = singleton.cancel
  export const executable = singleton.executable
}
