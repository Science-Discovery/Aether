import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { WebUpdateTest } from "../../src/server/routes/global"
import { tmpdir } from "../fixture/fixture"

function meta(ver: string, sha: string, size: number): Parameters<typeof WebUpdateTest.verifyDownload>[1] {
  return {
    ok: true,
    url: `https://example.com/${ver}/linux-x64.yml`,
    version: ver,
    package_url: `https://example.com/${ver}/aether-linux-x64-${ver}.zip`,
    package_sha512: sha,
    package_size: size,
    installer_url: `https://example.com/${ver}/update_linux.sh`,
    notes_url: `https://example.com/${ver}/notes.md`,
  }
}

async function sha(file: string) {
  return createHash("sha512")
    .update(Buffer.from(await Bun.file(file).arrayBuffer()))
    .digest("base64")
}

describe("web update helpers", () => {
  test("parseManifest reads package metadata from files list", () => {
    const data = WebUpdateTest.parseManifest(`version: 1.2.3
files:
  - url: aether-linux-x64-1.2.3.zip
    sha512: abc123
    size: 42
installer:
  url: update_linux.sh
notes_url: notes.md
`)

    expect(data).toEqual({
      ver: "1.2.3",
      pkg: "aether-linux-x64-1.2.3.zip",
      sha: "abc123",
      size: 42,
      ins: "update_linux.sh",
      note: "notes.md",
    })
  })

  test("verifyDownload rejects partial package files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const dl = path.join(dir, "downloads")
        await fs.mkdir(dl, { recursive: true })
        await Bun.write(path.join(dl, WebUpdateTest.versioned("update_linux.sh", "1.2.3")), "#!/usr/bin/env bash\n")
        await Bun.write(path.join(dl, "aether-linux-x64-1.2.3.zip"), "short")
      },
    })

    const file = path.join(tmp.path, "downloads", "aether-linux-x64-1.2.3.zip")
    const hit = await WebUpdateTest.verifyDownload("linux", meta("1.2.3", await sha(file), 999), tmp.path)

    expect(hit.ok).toBe(false)
    if (hit.ok) return
    expect(hit.error).toContain("size mismatch")
  })

  test("resetUpdate only deletes current version artifacts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const dl = path.join(dir, "downloads")
        await fs.mkdir(dl, { recursive: true })
        await Bun.write(path.join(dl, "aether-linux-x64-1.2.2.zip"), "keep")
        await Bun.write(path.join(dl, "aether-linux-x64-1.2.3.zip"), "drop")
        await Bun.write(path.join(dl, "update_linux-1.2.2.sh"), "keep")
        await Bun.write(path.join(dl, "update_linux-1.2.3.sh"), "drop")
        await Bun.write(path.join(dl, "last-result.yml"), "drop")
        await WebUpdateTest.writeUpdateState(
          dir,
          WebUpdateTest.updateState("1.2.3", "failed", "bad", {
            package_path: path.join(dl, "aether-linux-x64-1.2.3.zip"),
            script_path: path.join(dl, "update_linux-1.2.3.sh"),
          }),
        )
      },
    })

    await WebUpdateTest.resetUpdate("linux", "1.2.3", tmp.path)

    expect(await Bun.file(path.join(tmp.path, "downloads", "aether-linux-x64-1.2.2.zip")).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "downloads", "update_linux-1.2.2.sh")).exists()).toBe(true)
    expect(await Bun.file(path.join(tmp.path, "downloads", "aether-linux-x64-1.2.3.zip")).exists()).toBe(false)
    expect(await Bun.file(path.join(tmp.path, "downloads", "update_linux-1.2.3.sh")).exists()).toBe(false)
  })

  test("resolveUpdateStatus promotes finished install to installed", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const dl = path.join(dir, "downloads")
        await fs.mkdir(dl, { recursive: true })
        await WebUpdateTest.writeUpdateState(dir, WebUpdateTest.updateState("1.2.3", "installing"))
      },
    })

    const state = await WebUpdateTest.resolveUpdateStatus("linux", "1.2.3", meta("1.2.3", "abc", 10), tmp.path)

    expect(state.status).toBe("installed")
  })

  test("getWorkDir uses fixed hidden share directory", () => {
    const home = process.env.HOME
    process.env.HOME = "/tmp/aether-home"

    expect(WebUpdateTest.getWorkDir("darwin")).toBe("/tmp/aether-home/.local/share/aether/update")
    expect(WebUpdateTest.getWorkDir("linux")).toBe("/tmp/aether-home/.local/share/aether/update")
    expect(WebUpdateTest.getWorkDir("windows")).toBe("/tmp/aether-home/.local/share/aether/update")

    process.env.HOME = home
  })
})
