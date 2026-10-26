import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { LatexSetup } from "../../src/latex/setup"
import { unpack } from "../../src/latex/archive"
import { tmpdir } from "../fixture/fixture"

const content = Buffer.from("offline fixture binary")
const filename = "tectonic.exe"
const signal = () => new AbortController().signal
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
type Download = NonNullable<Parameters<typeof LatexSetup.create>[0]["fetch"]>

async function zip(entries = [{ name: filename, mode: 0x81c00000, data: content }]) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  for (const entry of entries)
    await writer.add(entry.name, new Uint8ArrayReader(entry.data), {
      externalFileAttributes: entry.mode,
      useWebWorkers: false,
      useCompressionStream: false,
    })
  return writer.close()
}

function tar(entries: { name: string; kind?: string; data?: Buffer }[]) {
  return gzipSync(
    Buffer.concat([
      ...entries.flatMap((entry) => {
        const data = entry.data ?? content
        const header = Buffer.alloc(512)
        header.write(entry.name, 0, 100)
        header.write("0000700\0", 100)
        header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124)
        header.fill(32, 148, 156)
        header.write(entry.kind ?? "0", 156)
        header.write("ustar\0", 257)
        const sum = header.reduce((total, byte) => total + byte, 0)
        header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148)
        return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]
      }),
      Buffer.alloc(1024),
    ]),
  )
}

function options(root: string, bytes: Uint8Array) {
  return {
    root,
    platform: "win32",
    arch: "x64",
    asset: {
      name: "tectonic-0.17.0-x86_64-pc-windows-msvc.zip",
      size: bytes.length,
      sha256: digest(bytes),
      format: "zip" as const,
    },
    fetch: (async () => new Response(Buffer.from(bytes))) as Download,
    probe: async (file: string) => {
      expect(Buffer.from(await Bun.file(file).bytes())).toEqual(content)
      return "tectonic 0.17.0"
    },
  }
}

async function terminal(setup: ReturnType<typeof LatexSetup.create>) {
  for (let count = 0; count < 200; count++) {
    const value = await setup.status()
    if (["ready", "failed", "cancelled", "idle"].includes(value.state)) return value
    await Bun.sleep(10)
  }
  throw new Error("The offline setup fixture did not finish.")
}

describe("managed Tectonic setup", () => {
  test("does not download on status or unsupported platforms", async () => {
    await using dir = await tmpdir()
    const calls: string[] = []
    const setup = LatexSetup.create({
      root: dir.path,
      platform: "unsupported",
      arch: "x64",
      fetch: (async (url) => {
        calls.push(String(url))
        throw new Error("Unexpected download")
      }) as Download,
    })
    expect(await setup.status()).toMatchObject({ supported: false, state: "idle" })
    expect(await setup.start()).toMatchObject({ supported: false, state: "idle" })
    expect(await setup.executable()).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test("deduplicates concurrent starts, verifies before publication, and discovers after recreation", async () => {
    await using dir = await tmpdir()
    const bytes = await zip()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const setup = LatexSetup.create({
      ...options(dir.path, bytes),
      fetch: (async (url) => {
        calls.push(String(url))
        return new Response(Buffer.from(bytes))
      }) as Download,
      probe: async (file) => {
        expect(Buffer.from(await Bun.file(file).bytes())).toEqual(content)
        entered.resolve()
        await release.promise
        return "tectonic 0.17.0"
      },
    })
    await Promise.all([setup.start(), setup.start(), setup.start()])
    await Promise.race([
      entered.promise,
      terminal(setup).then((value) => {
        throw new Error(value.error ?? "Probe was not reached")
      }),
    ])
    expect(await setup.executable()).toBeUndefined()
    release.resolve()
    expect(await terminal(setup)).toMatchObject({ state: "ready", downloaded: bytes.length })
    expect(calls).toEqual([
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip",
    ])
    const recreated = LatexSetup.create(options(dir.path, bytes))
    expect(await recreated.executable()).toBe(await setup.executable())
    expect(await recreated.status()).toMatchObject({ state: "ready" })
    expect(
      (await fs.readdir(dir.path)).filter((name) => name.startsWith(".tmp-") || name.startsWith(".active-")),
    ).toEqual([])
  })

  test("checksum failure neither probes untrusted bytes nor replaces a previous installation", async () => {
    await using dir = await tmpdir()
    const bytes = await zip()
    const setup = LatexSetup.create(options(dir.path, bytes))
    await setup.start()
    expect((await terminal(setup)).state).toBe("ready")
    const previous = await setup.executable()
    const pointer = await Bun.file(path.join(dir.path, "active.json")).json()
    await Bun.write(path.join(dir.path, "active.json"), JSON.stringify({ ...pointer, version: "0.16.0" }))
    const opts = options(dir.path, bytes)
    const broken = LatexSetup.create({
      ...opts,
      asset: { ...opts.asset, sha256: "0".repeat(64) },
      probe: async () => {
        throw new Error("Unverified executable was invoked")
      },
    })
    await broken.start()
    expect(await terminal(broken)).toMatchObject({ state: "failed", error: expect.stringContaining("checksum") })
    expect(await broken.executable()).toBe(previous)
    expect(Buffer.from(await Bun.file(previous!).bytes())).toEqual(content)
    expect((await fs.readdir(dir.path)).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("cancels an in-flight body and can retry without publishing partial output", async () => {
    await using dir = await tmpdir()
    const bytes = await zip()
    const entered = Promise.withResolvers<void>()
    const calls = { count: 0 }
    const setup = LatexSetup.create({
      ...options(dir.path, bytes),
      fetch: (async (_url, init) => {
        if (++calls.count > 1) return new Response(Buffer.from(bytes))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 8))
              init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true })
              entered.resolve()
            },
          }),
        )
      }) as Download,
    })
    await setup.start()
    await entered.promise
    expect((await setup.cancel()).state).toBe("cancelled")
    expect(await setup.executable()).toBeUndefined()
    expect(await fs.readdir(dir.path)).toEqual([])
    await setup.start()
    expect((await terminal(setup)).state).toBe("ready")
    expect(calls.count).toBe(2)
  })

  test("enforces download size and a wall-clock timeout", async () => {
    await using dir = await tmpdir()
    const bytes = await zip()
    const oversized = LatexSetup.create({
      ...options(path.join(dir.path, "size"), bytes),
      fetch: (async () => new Response(Buffer.concat([bytes, Buffer.from("extra")]))) as Download,
    })
    await oversized.start()
    expect(await terminal(oversized)).toMatchObject({ state: "failed", error: expect.stringContaining("size") })
    const timed = LatexSetup.create({
      ...options(path.join(dir.path, "time"), bytes),
      timeout: 20,
      fetch: (async (_url, init) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })
          if (init?.signal?.aborted) reject(init.signal.reason)
        })
      }) as Download,
    })
    await timed.start()
    expect(await terminal(timed)).toMatchObject({ state: "failed", error: expect.stringContaining("time limit") })
  })

  test("failed version checks do not publish and a missing or corrupted installation can be repaired", async () => {
    await using dir = await tmpdir()
    const bytes = await zip()
    const broken = LatexSetup.create({ ...options(dir.path, bytes), probe: async () => "unrelated program" })
    await broken.start()
    expect(await terminal(broken)).toMatchObject({ state: "failed", error: expect.stringContaining("0.17.0") })
    expect(await broken.executable()).toBeUndefined()
    const setup = LatexSetup.create(options(dir.path, bytes))
    await setup.start()
    expect((await terminal(setup)).state).toBe("ready")
    const original = await setup.executable()
    await Bun.write(original!, "bad".padEnd(content.length, "!"))
    await setup.start()
    expect((await terminal(setup)).state).toBe("ready")
    expect(await setup.executable()).not.toBe(original)
    await fs.rm((await setup.executable())!)
    expect((await setup.status()).state).toBe("idle")
    expect((await setup.status()).path).toBeUndefined()
    await setup.start()
    expect((await terminal(setup)).state).toBe("ready")
  })

  test("does not follow a path-traversing active manifest", async () => {
    await using dir = await tmpdir()
    await Bun.write(
      path.join(dir.path, "active.json"),
      JSON.stringify({ id: "../outside", version: "0.17.0", platform: "win32-x64" }),
    )
    const setup = LatexSetup.create(options(dir.path, await zip()))
    expect(await setup.executable()).toBeUndefined()
  })
})

describe("bounded Tectonic extraction", () => {
  test("returns only the unique executable from ZIP and tar.gz", async () => {
    expect(
      await unpack(
        await zip([
          { name: "docs/readme.txt", mode: 0, data: Buffer.from("readme") },
          { name: filename, mode: 0x81c00000, data: content },
        ]),
        "zip",
        filename,
        signal(),
      ),
    ).toEqual(content)
    expect(await unpack(tar([{ name: "tectonic" }]), "tar.gz", "tectonic", signal())).toEqual(content)
  })

  test("rejects traversal, links, and duplicate executable entries", async () => {
    for (const name of ["../tectonic.exe", "/tectonic.exe", "C:/tectonic.exe", "folder/../../tectonic.exe"])
      await expect(unpack(await zip([{ name, mode: 0, data: content }]), "zip", filename, signal())).rejects.toThrow()
    await expect(
      unpack(await zip([{ name: filename, mode: 0xa1ff0000, data: content }]), "zip", filename, signal()),
    ).rejects.toThrow("link")
    await expect(
      unpack(
        await zip([
          { name: filename, mode: 0, data: content },
          { name: `nested/${filename}`, mode: 0, data: content },
        ]),
        "zip",
        filename,
        signal(),
      ),
    ).rejects.toThrow("exactly one")
    for (const kind of ["1", "2", "x", "L"])
      await expect(unpack(tar([{ name: "tectonic", kind }]), "tar.gz", "tectonic", signal())).rejects.toThrow(
        "unsupported",
      )
    await expect(unpack(tar([{ name: "../tectonic" }]), "tar.gz", "tectonic", signal())).rejects.toThrow("unsafe")
    await expect(
      unpack(tar([{ name: "tectonic" }, { name: "other/tectonic" }]), "tar.gz", "tectonic", signal()),
    ).rejects.toThrow("more than one")
  })

  test("rejects corrupt tar metadata and pre-cancelled extraction", async () => {
    const invalid = Buffer.alloc(2048, 1)
    await expect(unpack(gzipSync(invalid), "tar.gz", "tectonic", signal())).rejects.toThrow()
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(unpack(await zip(), "zip", filename, controller.signal)).rejects.toThrow("cancelled")
  })
})
