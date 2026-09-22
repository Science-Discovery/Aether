import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { betaDesktopNames, betaItems, betaPlatformKeys, runScript } from "./fixtures"

function serveBeta(opts: { failFirst?: Record<string, number>; omitObjectKeys?: boolean; commitStallMs?: number }) {
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
  const uploaded = new Map<string, number>()
  const attempts = new Map<string, number>()
  let presigns = 0
  let commits = 0
  let bound = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const reqUrl = new URL(req.url)
      const base = `http://127.0.0.1:${bound}`
      if (req.method === "POST" && reqUrl.pathname === "/api/downloadbeta/admin/presign") {
        presigns++
        return Response.json({
          ok: true,
          platforms: Object.fromEntries(
            Object.entries(betaPlatformKeys).map(([key, val]) => [
              key,
              {
                archive: {
                  url: `${base}/${val.archive}?sig=archive`,
                  contentType: "application/octet-stream",
                  objectKey: opts.omitObjectKeys ? undefined : val.archive,
                },
                installer: {
                  url: `${base}/${val.installer}?sig=installer`,
                  contentType: "text/x-shellscript",
                  objectKey: opts.omitObjectKeys ? undefined : val.installer,
                },
              },
            ]),
          ),
          desktop: {
            files: betaDesktopNames.map((name) => ({
              url: `${base}/desktop/aether-desktop/${name}?sig=desktop`,
              contentType: "application/octet-stream",
              objectKey: `desktop/aether-desktop/${name}`,
            })),
          },
        })
      }
      if (req.method === "PUT") {
        const key = decodeURIComponent(reqUrl.pathname.slice(1))
        const fails = opts.failFirst?.[key] ?? 0
        const seen = (attempts.get(key) ?? 0) + 1
        attempts.set(key, seen)
        if (seen > fails) uploaded.set(key, (uploaded.get(key) ?? 0) + 1)
        return new Response(seen > fails ? null : "injected failure", { status: seen > fails ? 200 : 500 })
      }
      if (req.method === "POST" && reqUrl.pathname === "/api/downloadbeta/admin/commit") {
        commits++
        if (opts.commitStallMs && commits === 1) await sleep(opts.commitStallMs)
        return Response.json({
          ok: true,
          files: Object.entries(betaPlatformKeys).map(([platform, val]) => ({
            platform,
            url: `/downloadbeta/${val.archive}`,
            latestUrl: `/downloadbeta/latest/${val.archive.split("/").pop()}`,
            manifestUrl: `/downloadbeta/manifest.yml`,
            latestManifestUrl: `/downloadbeta/latest/manifest.yml`,
            installerUrl: `/downloadbeta/${val.installer}`,
            latestInstallerUrl: `/downloadbeta/latest/${val.installer.split("/").pop()}`,
          })),
          desktop: {
            files: betaDesktopNames.map((name) => ({
              url: `/downloadbeta/desktop/${name}`,
              latestUrl: `/downloadbeta/latest/desktop/${name}`,
            })),
          },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  bound = server.port ?? 0
  return { server, uploaded, attempts, presigns: () => presigns, commits: () => commits }
}

async function makeFiles() {
  const dir = await mkdtemp(join(tmpdir(), "downloadbeta-test-"))
  await mkdir(join(dir, "dist"))
  await mkdir(join(dir, "Update"))
  for (const item of Object.values(betaItems)) {
    await writeFile(join(dir, item.archive), `archive:${item.archive}`)
  }
  for (const name of new Set(Object.values(betaItems).map((item) => item.installer))) {
    await writeFile(join(dir, name), `installer:${name}`)
  }
  for (const name of betaDesktopNames) {
    await writeFile(join(dir, "dist", name), `desktop:${name}`)
  }
  return dir
}

test("uploads beta assets for every platform to its own object key", async () => {
  const mock = serveBeta({})
  const dir = await makeFiles()
  const { stdout, stderr, code } = await runScript("upload-downloadbeta.ts", dir, {
    DOWNLOAD_BETA_BASE_URL: `http://127.0.0.1:${mock.server.port}`,
    DOWNLOAD_ADMIN_PASSWORD: "secret",
    DOWNLOAD_BETA_VERSION: "1.4.0",
    UPLOAD_RETRY_DELAY_MS: "10",
  })
  await rm(dir, { recursive: true, force: true })
  if (code !== 0) console.error(stderr)
  expect(code).toBe(0)
  expect(stdout).toContain("Uploaded 1.4.0 to downloadbeta")
  expect(mock.presigns()).toBe(1)
  expect(mock.commits()).toBe(1)
  const expected = [
    ...new Set(Object.values(betaPlatformKeys).flatMap((val) => [val.archive, val.installer])),
    ...betaDesktopNames.map((name) => `desktop/aether-desktop/${name}`),
  ].sort()
  expect([...mock.uploaded.keys()].sort()).toEqual(expected)
}, 60000)

test("failed platform installer retries against its own object key", async () => {
  const macIntelInstaller = betaPlatformKeys.macIntel!.installer
  const macInstaller = betaPlatformKeys.mac!.installer
  const mock = serveBeta({ failFirst: { [macIntelInstaller]: 1 } })
  const dir = await makeFiles()
  const { stderr, code } = await runScript("upload-downloadbeta.ts", dir, {
    DOWNLOAD_BETA_BASE_URL: `http://127.0.0.1:${mock.server.port}`,
    DOWNLOAD_ADMIN_PASSWORD: "secret",
    DOWNLOAD_BETA_VERSION: "1.4.0",
    UPLOAD_RETRY_DELAY_MS: "10",
  })
  await rm(dir, { recursive: true, force: true })
  if (code !== 0) console.error(stderr)
  expect(code).toBe(0)
  expect(mock.attempts.get(macIntelInstaller)).toBe(2)
  expect(mock.attempts.get(macInstaller)).toBe(1)
  expect(mock.presigns()).toBe(2)
}, 60000)

test("slow first commit is retried with a dedicated commit timeout", async () => {
  const mock = serveBeta({ commitStallMs: 3000 })
  const dir = await makeFiles()
  const { stdout, stderr, code } = await runScript("upload-downloadbeta.ts", dir, {
    DOWNLOAD_BETA_BASE_URL: `http://127.0.0.1:${mock.server.port}`,
    DOWNLOAD_ADMIN_PASSWORD: "secret",
    DOWNLOAD_BETA_VERSION: "1.4.0",
    UPLOAD_RETRY_DELAY_MS: "10",
    COMMIT_TIMEOUT_MS: "500",
  })
  await rm(dir, { recursive: true, force: true })
  if (code !== 0) console.error(stderr)
  expect(code).toBe(0)
  expect(stdout).toContain("Uploaded 1.4.0 to downloadbeta")
  expect(mock.commits()).toBe(2)
}, 60000)

test("fails loudly when presign entries lack object keys", async () => {
  const mock = serveBeta({ omitObjectKeys: true })
  const dir = await makeFiles()
  const { stderr, code } = await runScript("upload-downloadbeta.ts", dir, {
    DOWNLOAD_BETA_BASE_URL: `http://127.0.0.1:${mock.server.port}`,
    DOWNLOAD_ADMIN_PASSWORD: "secret",
    DOWNLOAD_BETA_VERSION: "1.4.0",
    UPLOAD_RETRY_DELAY_MS: "10",
  })
  await rm(dir, { recursive: true, force: true })
  expect(code).toBe(1)
  expect(stderr).toContain("Invalid presign response")
}, 60000)
