import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { LatexRtex } from "../../src/latex/rtex/setup"
import { tmpdir } from "../fixture/fixture"

const archive = process.env.RTEX_ARCHIVE

test.skipIf(!archive)("installs the real rtex release archive", async () => {
  await using dir = await tmpdir()
  const bytes = new Uint8Array(await fs.readFile(archive!))
  const setup = LatexRtex.create({
    root: dir.path,
    platform: "linux",
    arch: "x64",
    asset: {
      name: path.basename(archive!),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: "tar.gz",
    },
    fetch: async () =>
      new Response(bytes.buffer as ArrayBuffer, { headers: { "content-length": String(bytes.length) } }),
    probe: async () => "rtex 0.0.6",
  })
  await setup.start()
  let status = await setup.status()
  for (
    let index = 0;
    index < 300 && ["downloading", "verifying", "extracting", "checking"].includes(status.setup.state);
    index++
  ) {
    await Bun.sleep(20)
    status = await setup.status()
  }
  expect(status.installed).toBe(true)
  expect(status.setup.state).toBe("ready")
  const installed = await setup.executable()
  expect(await fs.stat(installed!.path).then((stat) => stat.isFile())).toBe(true)
  expect(await fs.stat(path.join(installed!.texdir, "rtex-dl.lua")).then((stat) => stat.isFile())).toBe(true)
})
