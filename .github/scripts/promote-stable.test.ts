import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { webItems } from "./upload-plan"
import { platformKeys, presignFixture, runScript, ver } from "./fixtures"

function servePromote(opts: { installerless?: string[]; failFirst?: Record<string, number> }) {
  const uploaded = new Map<string, number>()
  const attempts = new Map<string, number>()
  let presigns = 0
  let commits = 0
  let bound = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const reqUrl = new URL(req.url)
      if (req.method === "POST" && reqUrl.pathname === "/api/download/admin/presign") {
        presigns++
        return Response.json({ ok: true, platforms: presignFixture(`http://127.0.0.1:${bound}`) })
      }
      if (req.method === "PUT") {
        const key = decodeURIComponent(reqUrl.pathname.slice(1))
        const fails = opts.failFirst?.[key] ?? 0
        const seen = (attempts.get(key) ?? 0) + 1
        attempts.set(key, seen)
        if (seen > fails) uploaded.set(key, (uploaded.get(key) ?? 0) + 1)
        return new Response(seen > fails ? null : "injected failure", { status: seen > fails ? 200 : 500 })
      }
      if (req.method === "POST" && reqUrl.pathname === "/api/download/admin/commit") {
        commits++
        const files = Object.entries(platformKeys).map(([platform, val]) => ({
          platform,
          url: `/download/${val.archive}`,
          latestUrl: `/download/latest/${val.archive.split("/").pop()}`,
          manifestUrl: `/download/${ver}/manifest.yml`,
          latestManifestUrl: `/download/latest/manifest.yml`,
          ...(opts.installerless?.includes(platform)
            ? {}
            : {
                installerUrl: `/download/${val.installer}`,
                latestInstallerUrl: `/download/latest/${val.installer.split("/").pop()}`,
              }),
        }))
        return Response.json({ ok: true, files })
      }
      return new Response("not found", { status: 404 })
    },
  })
  bound = server.port ?? 0
  return { server, uploaded, attempts, presigns: () => presigns, commits: () => commits }
}

async function makeAssets() {
  const dir = await mkdtemp(join(tmpdir(), "promote-test-"))
  const assets = join(dir, "assets")
  const updates = join(dir, "Update")
  await mkdir(assets)
  await mkdir(updates)
  for (const item of Object.values(webItems)) {
    await writeFile(join(assets, item.archive), `archive:${item.archive}`)
  }
  for (const name of new Set(Object.values(webItems).map((item) => item.installer))) {
    await writeFile(join(updates, name), `installer:${name}`)
  }
  return { dir, assets, updates }
}

function expectedKeys() {
  return [...new Set(Object.values(platformKeys).flatMap((val) => [val.archive, val.installer]))].sort()
}

test("promotes web assets for every platform to its own object key", async () => {
  const mock = servePromote({})
  const { dir, assets, updates } = await makeAssets()
  const { stdout, stderr, code } = await runScript("promote-stable.ts", dir, {
    ADMIN_BASE: `http://127.0.0.1:${mock.server.port}`,
    ADMIN_PASSWORD: "secret",
    VERSION: ver,
    ASSETS_DIR: assets,
    UPDATE_DIR: updates,
    PROMOTE_WEB: "true",
    UPLOAD_RETRY_DELAY_MS: "10",
  })
  await rm(dir, { recursive: true, force: true })
  if (code !== 0) console.error(stderr)
  expect(code).toBe(0)
  expect(stdout).toContain(`Promoted web ${ver}`)
  expect(mock.presigns()).toBe(1)
  expect(mock.commits()).toBe(1)
  expect([...mock.uploaded.keys()].sort()).toEqual(expectedKeys())
  for (const key of expectedKeys()) expect(mock.uploaded.get(key)).toBe(1)
}, 60000)

test("retry after failed upload re-signs the same object key", async () => {
  const macIntelInstaller = platformKeys.macIntel!.installer
  const mock = servePromote({ failFirst: { [macIntelInstaller]: 1 } })
  const { dir, assets, updates } = await makeAssets()
  const { stderr, code } = await runScript("promote-stable.ts", dir, {
    ADMIN_BASE: `http://127.0.0.1:${mock.server.port}`,
    ADMIN_PASSWORD: "secret",
    VERSION: ver,
    ASSETS_DIR: assets,
    UPDATE_DIR: updates,
    PROMOTE_WEB: "true",
    UPLOAD_RETRY_DELAY_MS: "10",
  })
  await rm(dir, { recursive: true, force: true })
  if (code !== 0) console.error(stderr)
  expect(code).toBe(0)
  expect(mock.attempts.get(macIntelInstaller)).toBe(2)
  expect(mock.presigns()).toBe(2)
  expect([...mock.uploaded.keys()].sort()).toEqual(expectedKeys())
}, 60000)

test("commit response without installer URLs fails loudly", async () => {
  const mock = servePromote({ installerless: ["macIntel"] })
  const { dir, assets, updates } = await makeAssets()
  const { stderr, code } = await runScript("promote-stable.ts", dir, {
    ADMIN_BASE: `http://127.0.0.1:${mock.server.port}`,
    ADMIN_PASSWORD: "secret",
    VERSION: ver,
    ASSETS_DIR: assets,
    UPDATE_DIR: updates,
    PROMOTE_WEB: "true",
    UPLOAD_RETRY_DELAY_MS: "10",
  })
  await rm(dir, { recursive: true, force: true })
  expect(code).toBe(1)
  expect(stderr).toContain("missing installer URLs")
}, 60000)
