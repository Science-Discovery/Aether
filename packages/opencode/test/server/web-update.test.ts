import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { WebUpdateTest } from "../../src/server/web-update"
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

async function result(dir: string, status: "installed" | "failed", version: string, action = "", error = "") {
  const file = path.join(dir, "downloads", "web-update-result.env")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `status=${status}\nversion=${version}\naction=${action}\nerror=${error}\nat=1\n`)
}

describe("web update helpers", () => {
  test("linux arm64 uses arm64 manifests and packages", async () => {
    const desc = Object.getOwnPropertyDescriptor(process, "arch")
    Object.defineProperty(process, "arch", { value: "arm64" })
    try {
      expect((await WebUpdateTest.manifestUrl("linux")).endsWith("/latest/linux-arm64.yml")).toBe(true)
      expect((await WebUpdateTest.manifestUrl("linux", "1.2.3")).endsWith("/1.2.3/linux-arm64.yml")).toBe(true)
      expect(WebUpdateTest.packageMatch("linux", "1.2.3", "aether-linux-arm64-1.2.3.zip")).toBe(true)
      expect(WebUpdateTest.packageMatch("linux", "1.2.3", "aether-linux-x64-1.2.3.zip")).toBe(false)
    } finally {
      if (desc) Object.defineProperty(process, "arch", desc)
    }
  })

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
    const desc = Object.getOwnPropertyDescriptor(process, "arch")
    Object.defineProperty(process, "arch", { value: "x64" })
    try {
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
    } finally {
      if (desc) Object.defineProperty(process, "arch", desc)
    }
  })

  test("resetUpdate only deletes current version artifacts", async () => {
    const desc = Object.getOwnPropertyDescriptor(process, "arch")
    Object.defineProperty(process, "arch", { value: "x64" })
    try {
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
    } finally {
      if (desc) Object.defineProperty(process, "arch", desc)
    }
  })

  test("resolveUpdateStatus promotes finished install to installed", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const dl = path.join(dir, "downloads")
        await fs.mkdir(dl, { recursive: true })
        await WebUpdateTest.writeUpdateState(dir, WebUpdateTest.updateState("1.2.3", "installing"))
        await fs.mkdir(path.join(dir, "aether_1.2.3"), { recursive: true })
        await Bun.write(path.join(dir, "aether_1.2.3", ".aether_web_version"), "1.2.3\n")
      },
    })

    const state = await WebUpdateTest.resolveUpdateStatus("linux", "1.2.3", meta("1.2.3", "abc", 10), tmp.path)

    expect(state.status).toBe("installed")
  })

  test("resolveUpdateStatus reports mirror retry failures from result file", async () => {
    const desc = Object.getOwnPropertyDescriptor(process, "arch")
    Object.defineProperty(process, "arch", { value: "x64" })
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const dl = path.join(dir, "downloads")
          await fs.mkdir(dl, { recursive: true })
          await Bun.write(path.join(dl, WebUpdateTest.versioned("update_linux.sh", "1.2.3")), "#!/usr/bin/env bash\n")
          await Bun.write(path.join(dl, "aether-linux-x64-1.2.3.zip"), "payload")
          await WebUpdateTest.writeUpdateState(dir, WebUpdateTest.updateState("1.2.3", "installing"))
          await result(dir, "failed", "1.2.3", "mirror", "mirror failed")
        },
      })

      const file = path.join(tmp.path, "downloads", "aether-linux-x64-1.2.3.zip")
      const state = await WebUpdateTest.resolveUpdateStatus(
        "linux",
        "1.2.2",
        meta("1.2.3", await sha(file), 7),
        tmp.path,
      )

      expect(state.status).toBe("failed")
      if (state.status !== "failed") return
      expect(state.action).toBe("mirror")
      expect(state.error).toContain("mirror failed")
    } finally {
      if (desc) Object.defineProperty(process, "arch", desc)
    }
  })

  test("resolveUpdateStatus rejects installs with missing version directory", async () => {
    const desc = Object.getOwnPropertyDescriptor(process, "arch")
    Object.defineProperty(process, "arch", { value: "x64" })
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const dl = path.join(dir, "downloads")
          await fs.mkdir(dl, { recursive: true })
          await Bun.write(path.join(dl, WebUpdateTest.versioned("update_linux.sh", "1.2.3")), "#!/usr/bin/env bash\n")
          await Bun.write(path.join(dl, "aether-linux-x64-1.2.3.zip"), "payload")
          await WebUpdateTest.writeUpdateState(dir, WebUpdateTest.updateState("1.2.3", "installing"))
        },
      })

      const file = path.join(tmp.path, "downloads", "aether-linux-x64-1.2.3.zip")
      const state = await WebUpdateTest.resolveUpdateStatus(
        "linux",
        "1.2.3",
        meta("1.2.3", await sha(file), 7),
        tmp.path,
      )

      expect(state.status).toBe("failed")
      if (state.status !== "failed") return
      expect(state.action).toBe("recover")
      expect(state.error).toContain("incomplete")
    } finally {
      if (desc) Object.defineProperty(process, "arch", desc)
    }
  })

  test("getWorkDir returns update/aether with basename=aether", () => {
    const home = process.env.HOME
    process.env.HOME = "/tmp/aether-home"

    expect(WebUpdateTest.getWorkDir("darwin")).toBe("/tmp/aether-home/.local/share/aether/update/aether")
    expect(WebUpdateTest.getWorkDir("linux")).toBe("/tmp/aether-home/.local/share/aether/update/aether")
    expect(WebUpdateTest.getWorkDir("windows")).toBe("/tmp/aether-home/.local/share/aether/update/aether")

    process.env.HOME = home
  })

  test("fetchManifest honors configured update base URL", async () => {
    const desc = Object.getOwnPropertyDescriptor(process, "arch")
    Object.defineProperty(process, "arch", { value: "x64" })
    await using tmp = await tmpdir({
      init: async (dir) => {
        const cfg = path.join(dir, "config")
        await fs.mkdir(cfg, { recursive: true })
        await Bun.write(
          path.join(cfg, "update-config.json"),
          JSON.stringify({ updateBaseUrl: "https://mirror.example.com/base" }),
        )
        return cfg
      },
    })

    const prev = Global.Path.config
    const fetch = globalThis.fetch
    Global.Path.config = tmp.extra
    WebUpdateTest.resetUpdateBase()
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) =>
      new Response(
        [
          "version: 1.2.3",
          "package:",
          "  url: aether-linux-x64-1.2.3.zip",
          "  sha512: abc123",
          "  size: 42",
          "installer:",
          "  url: update_linux.sh",
        ].join("\n"),
        { status: 200 },
      )) as unknown as typeof fetch

    try {
      const data = await WebUpdateTest.fetchManifest("linux", "1.2.3")
      expect(data.ok).toBe(true)
      if (data.ok) {
        expect(data.url).toBe("https://mirror.example.com/base/1.2.3/linux-x64.yml")
        expect(data.package_url).toBe("https://mirror.example.com/base/1.2.3/aether-linux-x64-1.2.3.zip")
        expect(data.installer_url).toBe("https://mirror.example.com/base/1.2.3/update_linux.sh")
      }
    } finally {
      globalThis.fetch = fetch
      Global.Path.config = prev
      WebUpdateTest.resetUpdateBase()
      if (desc) Object.defineProperty(process, "arch", desc)
    }
  })
})
