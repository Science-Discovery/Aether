import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { LatexRtex } from "../../src/latex/rtex/setup"
import { tmpdir } from "../fixture/fixture"

async function settle(setup: ReturnType<typeof LatexRtex.create>) {
  for (let index = 0; index < 300; index++) {
    const value = await setup.status()
    if (!["downloading", "verifying", "extracting", "checking"].includes(value.setup.state)) return value
    await Bun.sleep(10)
  }
  throw new Error("rtex setup did not finish")
}

async function archive(folder: string) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add(`${folder}/bin/rtex`, new Uint8ArrayReader(new Uint8Array([1, 2, 3])))
  await writer.add(`${folder}/share/rtex/tex/rtex-dl.lua`, new Uint8ArrayReader(new Uint8Array([4, 5])))
  return writer.close()
}

describe("managed rtex setup", () => {
  test("downloads, verifies and publishes the release layout", async () => {
    await using dir = await tmpdir()
    const folder = "fake"
    const bytes = await archive(folder)
    const asset = {
      name: `${folder}.zip`,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "zip" as const,
    }
    const setup = LatexRtex.create({
      root: dir.path,
      platform: "linux",
      arch: "x64",
      asset,
      fetch: async () =>
        new Response(bytes.buffer as ArrayBuffer, { headers: { "content-length": String(bytes.length) } }),
      probe: async () => "rtex 0.0.6",
    })
    await setup.start()
    const result = await settle(setup)
    expect(result.installed).toBe(true)
    expect(result.setup.state).toBe("ready")
    const executable = await setup.executable()
    expect(executable?.path.endsWith(path.join(folder, "bin", "rtex"))).toBe(true)
    expect(await fs.stat(executable!.texdir).then((stat) => stat.isDirectory())).toBe(true)
    expect(await fs.readFile(path.join(executable!.texdir, "rtex-dl.lua"))).toEqual(Buffer.from([4, 5]))
  })

  test("rejects a checksum mismatch without publishing", async () => {
    await using dir = await tmpdir()
    const bytes = await archive("fake")
    const setup = LatexRtex.create({
      root: dir.path,
      platform: "linux",
      arch: "x64",
      asset: { name: "fake.zip", size: bytes.length, sha256: "0".repeat(64), format: "zip" },
      fetch: async () =>
        new Response(bytes.buffer as ArrayBuffer, { headers: { "content-length": String(bytes.length) } }),
      probe: async () => "rtex 0.0.6",
    })
    await setup.start()
    const result = await settle(setup)
    expect(result.installed).toBe(false)
    expect(result.setup.state).toBe("failed")
    expect(await setup.executable()).toBeUndefined()
    expect(await Bun.file(path.join(dir.path, "active.json")).exists()).toBe(false)
  })
})
