type Item = {
  archive: string
  installer: string
}

type Link = {
  url: string
  contentType: string
}

type Platform = {
  archive: Link
  installer: Link
}

type Presign = {
  ok: boolean
  platforms: Record<string, Platform>
}

type Commit = {
  ok: boolean
  files?: Array<{
    url?: string
    latestUrl?: string
    manifestUrl?: string
    latestManifestUrl?: string
    installerUrl?: string
    latestInstallerUrl?: string
  }>
  ossWarnings?: unknown[]
}

const items = {
  mac: {
    archive: "dist/aether-darwin-arm64.dmg",
    installer: "Update/update_darwin.command",
  },
  windows: {
    archive: "dist/aether-windows-x64.zip",
    installer: "Update/update_windows.bat",
  },
  linux: {
    archive: "dist/aether-linux-x64.zip",
    installer: "Update/update_linux.sh",
  },
  linuxArm64: {
    archive: "dist/aether-linux-arm64.zip",
    installer: "Update/update_linux.sh",
  },
} satisfies Record<string, Item>

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function env(key: string) {
  return process.env[key]?.trim() || fail(`Missing ${key}`)
}

function url(root: string, path: string) {
  return `${root.replace(/\/+$/, "")}${path}`
}

async function json(res: Response) {
  return await res.json().catch(() => fail(`Invalid JSON response from ${res.url}: ${res.status}`))
}

function link(val: unknown): val is Link {
  if (!val || typeof val !== "object") return false
  if (!("url" in val) || typeof val.url !== "string" || !val.url) return false
  if (!("contentType" in val) || typeof val.contentType !== "string" || !val.contentType) return false
  return true
}

function platform(val: unknown): val is Platform {
  if (!val || typeof val !== "object") return false
  if (!("archive" in val) || !link(val.archive)) return false
  if (!("installer" in val) || !link(val.installer)) return false
  return true
}

function presign(val: unknown): val is Presign {
  if (!val || typeof val !== "object") return false
  if (!("ok" in val) || val.ok !== true) return false
  if (!("platforms" in val) || !val.platforms || typeof val.platforms !== "object") return false
  return Object.keys(items).every((key) => platform((val.platforms as Record<string, unknown>)[key]))
}

function commit(val: unknown): val is Commit {
  if (!val || typeof val !== "object") return false
  return "ok" in val && val.ok === true
}

function beta(val: unknown) {
  if (typeof val !== "string") return false
  if (!val) return false
  return val.startsWith("/downloadbeta/")
}

function urls(file: NonNullable<Commit["files"]>[number]) {
  return [
    file.url,
    file.latestUrl,
    file.manifestUrl,
    file.latestManifestUrl,
    file.installerUrl,
    file.latestInstallerUrl,
  ].filter((x): x is string => typeof x === "string" && x.length > 0)
}

async function exists(item: Item) {
  await Promise.all(
    [item.archive, item.installer].map(async (file) => {
      if (!(await Bun.file(file).exists())) fail(`Missing upload file: ${file}`)
    }),
  )
}

async function post(root: string, path: string, pass: string, body: Record<string, unknown>) {
  const res = await fetch(url(root, path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-download-admin-password": pass,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) fail(`Request failed: ${path} ${res.status}`)
  return await json(res)
}

async function put(file: string, link: Link) {
  const res = await fetch(link.url, {
    method: "PUT",
    headers: { "Content-Type": link.contentType },
    body: Bun.file(file),
  })
  if (!res.ok) fail(`Upload failed: ${file} ${res.status}`)
}

const root = env("DOWNLOAD_BETA_BASE_URL")
const pass = env("DOWNLOAD_ADMIN_PASSWORD")
const ver = env("DOWNLOAD_BETA_VERSION")
const body = Object.fromEntries(Object.keys(items).map((key) => [key, { version: ver }]))

await Promise.all(Object.values(items).map(exists))

const pre = await post(root, "/api/downloadbeta/admin/presign", pass, body)
if (!presign(pre)) fail("Invalid presign response")

await Promise.all(
  Object.entries(items).flatMap(([key, item]) => [
    put(item.archive, pre.platforms[key]!.archive),
    put(item.installer, pre.platforms[key]!.installer),
  ]),
)

const done = await post(root, "/api/downloadbeta/admin/commit", pass, {
  ...body,
  releaseDate: new Date().toISOString(),
})

if (!commit(done)) fail("Invalid commit response")
if (Array.isArray(done.ossWarnings) && done.ossWarnings.length > 0) fail("Commit returned OSS warnings")
if (!Array.isArray(done.files) || done.files.length < Object.keys(items).length)
  fail("Commit response is missing files")
const links = done.files.map(urls)
if (links.some((item) => item.length === 0) || !links.flat().every(beta)) {
  fail("Commit response includes non-beta URLs")
}

console.log(`Uploaded ${ver} to downloadbeta`)
