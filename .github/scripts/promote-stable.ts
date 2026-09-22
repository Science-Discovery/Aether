import { join } from "node:path"

type Link = {
  url: string
  contentType: string
}

type Upload = Link & {
  objectKey: string
}

type DesktopPresign = {
  files: Upload[]
}

type Presign = {
  ok: boolean
  desktop?: DesktopPresign
  platforms?: Record<string, { archive: Upload; installer: Upload }>
}

type DesktopFile = {
  url?: string
  latestUrl?: string
  manifestUrl?: string
  latestManifestUrl?: string
}

type CommitFile = {
  url?: string
  latestUrl?: string
  manifestUrl?: string
  latestManifestUrl?: string
  installerUrl?: string
  latestInstallerUrl?: string
}

type Commit = {
  ok: boolean
  desktop?: {
    version: string
    channel?: string
    status?: string
    missingFiles?: string[]
    files?: DesktopFile[]
  }
  files?: CommitFile[]
}

const desktopFiles = [
  "aether-desktop-mac-arm64.dmg",
  "aether-desktop-mac-arm64.dmg.blockmap",
  "aether-desktop-mac-arm64.zip",
  "aether-desktop-mac-arm64.zip.blockmap",
  "aether-desktop-mac-x64.dmg",
  "aether-desktop-mac-x64.dmg.blockmap",
  "aether-desktop-mac-x64.zip",
  "aether-desktop-mac-x64.zip.blockmap",
  "aether-desktop-win-x64.exe",
  "aether-desktop-win-x64.exe.blockmap",
  "aether-desktop-win-arm64.exe",
  "aether-desktop-win-arm64.exe.blockmap",
  "aether-desktop-linux-amd64.deb",
  "aether-desktop-linux-arm64.deb",
  "latest.yml",
  "latest-mac.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
]

const desktopMainPackages = [
  "aether-desktop-mac-arm64.dmg",
  "aether-desktop-mac-x64.dmg",
  "aether-desktop-win-x64.exe",
  "aether-desktop-win-arm64.exe",
  "aether-desktop-linux-amd64.deb",
  "aether-desktop-linux-arm64.deb",
]

const webItems = {
  mac: { archive: "aether-darwin-arm64.dmg", installer: "update_darwin.command" },
  macIntel: { archive: "aether-darwin-x64.dmg", installer: "update_darwin.command" },
  windows: { archive: "aether-windows-x64.zip", installer: "update_windows.bat" },
  linux: { archive: "aether-linux-x64.zip", installer: "update_linux.sh" },
  linuxArm64: { archive: "aether-linux-arm64.zip", installer: "update_linux.sh" },
} satisfies Record<string, { archive: string; installer: string }>

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function env(key: string) {
  return process.env[key]?.trim() || fail(`Missing ${key}`)
}

function envFlag(key: string) {
  return process.env[key]?.trim() === "true"
}

function url(root: string, path: string) {
  return `${root.replace(/\/+$/, "")}${path}`
}

async function json(res: Response) {
  return await res.json().catch(() => fail(`Invalid JSON response from ${res.url}: ${res.status}`))
}

function upload(val: unknown): val is Upload {
  if (!val || typeof val !== "object") return false
  if (!("url" in val) || typeof val.url !== "string" || !val.url) return false
  if (!("contentType" in val) || typeof val.contentType !== "string") return false
  if (!("objectKey" in val) || typeof val.objectKey !== "string" || !val.objectKey) return false
  return true
}

async function post(root: string, path: string, pass: string, body: Record<string, unknown>) {
  const res = await fetch(url(root, path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-download-admin-password": pass,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) fail(`Request failed: ${path} ${res.status}`)
  return (await json(res)) as Commit & Presign
}

const uploadTimeoutMs = Number(process.env.UPLOAD_TIMEOUT_MS) || 900_000
const uploadAttempts = 3
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function put(file: string, name: string, represign: (name: string) => Promise<Upload>, link: Upload) {
  for (let n = 1; ; n++) {
    try {
      const res = await fetch(link.url, {
        method: "PUT",
        headers: { "Content-Type": link.contentType },
        body: Bun.file(file),
        signal: AbortSignal.timeout(uploadTimeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      console.log(`uploaded ${name}`)
      return
    } catch (err) {
      if (n >= uploadAttempts) fail(`Upload failed after ${n} attempts: ${name}: ${err}`)
      console.error(`Retrying ${name} (attempt ${n} failed): ${err}`)
      await sleep(n * 15_000)
      link = await represign(name)
    }
  }
}

async function uploadAll(tasks: Array<[string, Upload]>, represign: (name: string) => Promise<Upload>) {
  const queue = [...tasks]
  const workers = Array.from({ length: 3 }, async () => {
    for (;;) {
      const task = queue.shift()
      if (!task) return
      const name = task[1].objectKey.split("/").pop() ?? ""
      await put(task[0], name, represign, task[1])
    }
  })
  await Promise.all(workers)
}

async function missingFiles(dir: string, files: string[]) {
  const missing: string[] = []
  for (const file of files) {
    if (!(await Bun.file(join(dir, file)).exists())) missing.push(file)
  }
  return missing
}

async function digest(file: string) {
  const blob = Bun.file(file)
  const hasher = new Bun.CryptoHasher("sha512")
  hasher.update(await blob.arrayBuffer())
  return { sha512: hasher.digest("base64"), size: blob.size }
}

function isPublic(u: string) {
  return u.startsWith("/download/")
}

function failPublic(items: unknown[], kind: string): never {
  fail(`${kind} commit response includes non-public URLs: ${JSON.stringify(items).slice(0, 500)}`)
}

const root = env("ADMIN_BASE")
const pass = env("ADMIN_PASSWORD")
const ver = env("VERSION")
const assets = env("ASSETS_DIR")
const updates = env("UPDATE_DIR")
const promoteDesktop = envFlag("PROMOTE_DESKTOP")
const promoteWeb = envFlag("PROMOTE_WEB")

if (!promoteDesktop && !promoteWeb) fail("Nothing to promote: enable promote_desktop or promote_web")

if (promoteDesktop) {
  const absent = await missingFiles(assets, desktopFiles)
  if (absent.length > 0) fail(`Missing desktop assets: ${absent.join(", ")}`)

  const presignDesktop = async () => {
    const pre = await post(root, "/api/download/admin/presign", pass, {
      desktop: { version: ver, files: desktopFiles },
    })
    if (!pre.ok || !pre.desktop) fail("Invalid desktop presign response")
    const links = new Map<string, Upload>()
    for (const file of pre.desktop.files) {
      if (!upload(file)) fail(`Invalid desktop presign entry: ${JSON.stringify(file).slice(0, 200)}`)
      links.set(file.objectKey.split("/").pop() ?? "", file)
    }
    const badKeys = desktopFiles.filter((name) => {
      const link = links.get(name)
      return !link || !link.objectKey.startsWith(`desktop/${ver}/`)
    })
    if (badKeys.length > 0) fail(`Unexpected desktop presign object keys for: ${badKeys.join(", ")}`)
    return links
  }
  const links = await presignDesktop()
  const represignDesktop = async (name: string) => (await presignDesktop()).get(name)!

  await uploadAll(
    desktopFiles.map((name) => [join(assets, name), links.get(name)!]),
    represignDesktop,
  )

  const fileMetadata: Record<string, { sha512: string; size: number }> = {}
  for (const name of desktopMainPackages) {
    fileMetadata[name] = await digest(join(assets, name))
  }
  const done = await post(root, "/api/download/admin/commit", pass, {
    desktop: { version: ver, fileMetadata },
  })
  if (!done.ok) fail("Invalid desktop commit response")
  if (done.desktop?.status !== "published") {
    fail(
      `Desktop commit not published: status=${done.desktop?.status ?? "unknown"} missing=${
        JSON.stringify(done.desktop?.missingFiles ?? []) ?? "[]"
      }`,
    )
  }
  const urls = (done.desktop.files ?? []).flatMap((file) =>
    [file.url, file.latestUrl, file.manifestUrl, file.latestManifestUrl].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    ),
  )
  if (urls.length === 0) fail("Desktop commit response includes no URLs")
  if (!urls.every(isPublic)) failPublic(urls as unknown as CommitFile[], "Desktop")
  console.log(`Promoted desktop ${ver} to public channel`)
}

if (promoteWeb) {
  const absent = await missingFiles(
    assets,
    Object.values(webItems).map((item) => item.archive),
  )
  const absentInstallers = await missingFiles(updates, [
    ...new Set(Object.values(webItems).map((item) => item.installer)),
  ])
  if (absent.length > 0 || absentInstallers.length > 0) {
    fail(`Missing web assets: ${[...absent, ...absentInstallers].join(", ")}`)
  }

  const body = Object.fromEntries(Object.keys(webItems).map((key) => [key, { version: ver }]))
  const presignWeb = async () => {
    const pre = await post(root, "/api/download/admin/presign", pass, body)
    if (!pre.ok || !pre.platforms) fail("Invalid web presign response")
    const links = new Map<string, Upload>()
    for (const [key, item] of Object.entries(webItems)) {
      const entry = pre.platforms[key]
      if (!entry || !upload(entry.archive) || !upload(entry.installer)) {
        fail(`Invalid web presign entry for ${key}`)
      }
      if (!entry.archive.objectKey.startsWith(`${ver}/`) || !entry.installer.objectKey.startsWith(`${ver}/`)) {
        fail(`Unexpected web presign object keys for ${key}`)
      }
      links.set(entry.archive.objectKey.split("/").pop() ?? "", entry.archive)
      links.set(entry.installer.objectKey.split("/").pop() ?? "", entry.installer)
    }
    return links
  }
  const links = await presignWeb()
  const represignWeb = async (name: string) => (await presignWeb()).get(name)!
  const tasks: Array<[string, Upload]> = []
  for (const item of Object.values(webItems)) {
    const archive = links.get(item.archive)
    const installer = links.get(item.installer)
    if (!archive || !installer) fail(`Missing web presign link for ${item.archive}`)
    tasks.push([join(assets, item.archive), archive], [join(updates, item.installer), installer])
  }

  await uploadAll(tasks, represignWeb)

  const done = await post(root, "/api/download/admin/commit", pass, {
    ...body,
    releaseDate: new Date().toISOString(),
  })
  if (!done.ok) fail("Invalid web commit response")
  const files = done.files ?? []
  if (files.length < Object.keys(webItems).length) fail("Web commit response is missing files")
  const urls = files.flatMap((file) =>
    [file.url, file.latestUrl, file.manifestUrl, file.latestManifestUrl].filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    ),
  )
  if (urls.length === 0) fail("Web commit response includes no URLs")
  if (!urls.every(isPublic)) failPublic(files, "Web")
  console.log(`Promoted web ${ver} to public channel`)
}
