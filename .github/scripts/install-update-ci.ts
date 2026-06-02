#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type Asset = {
  name: string
  browser_download_url: string
}

type Release = {
  tag_name: string
  prerelease: boolean
  draft: boolean
  assets: Asset[]
}

type Meta = {
  version: string
  package?: {
    url?: string
    sha512?: string
    size?: number
  }
}

type Cmd = {
  cwd?: string
  env?: Record<string, string>
  ok?: number[]
  timeout?: number
}

const cfg = {
  id: env("AETHER_CI_ID"),
  product: env("AETHER_CI_PRODUCT"),
  task: env("AETHER_CI_TASK"),
  platform: env("AETHER_CI_PLATFORM"),
  arch: env("AETHER_CI_ARCH"),
  format: process.env.AETHER_CI_FORMAT ?? "",
}

const root = process.cwd()
const tmp = path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "aether-install-update", cfg.id)
const out = path.join(root, "install-update-artifacts", cfg.id)
const summary = process.env.GITHUB_STEP_SUMMARY
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
let page: { screenshot: (opts: { path: string; fullPage: boolean }) => Promise<unknown> } | null = null

await fs.mkdir(tmp, { recursive: true })
await fs.mkdir(out, { recursive: true })

try {
  await main()
} catch (cause) {
  await screenshot().catch(() => undefined)
  await collect().catch(() => undefined)
  await note(`## ${cfg.id}\n\nfailed: ${message(cause)}\n`)
  await write("result.json", JSON.stringify({ status: "failed", cfg, error: message(cause) }, null, 2))
  throw cause
}

async function main() {
  await note(`## ${cfg.id}\n\n- product: ${cfg.product}\n- task: ${cfg.task}\n- platform: ${cfg.platform}\n- arch: ${cfg.arch}\n- format: ${cfg.format || "-"}\n`)
  if (cfg.product === "web" && cfg.task === "site-install") return await webSite()
  if (cfg.product === "web" && cfg.task === "github-install") return await webGithub()
  if (cfg.product === "web" && cfg.task === "auto-update") return await webAuto()
  if (cfg.product === "web" && cfg.task === "manual-update") return await webManual()
  if (cfg.product === "electron" && cfg.task === "github-install") return await electronGithub()
  if (cfg.product === "electron" && cfg.task === "auto-update") return await electronAuto()
  if (cfg.product === "electron" && cfg.task === "manual-update") return await electronManual()
  throw new Error(`Unsupported matrix item: ${JSON.stringify(cfg)}`)
}

async function webSite() {
  const item = webSiteInstaller()
  if (!item) return await skip("missing website installer mapping")
  if (!(await okUrl(item.url))) return await skip(`missing website installer: ${item.url}`)
  if (!(await webStable())) return await skip("missing website stable manifest")
  const file = await download(item.url, item.name)
  await runWebInstaller(file)
  const hit = await webReady()
  await pass(`website install started web app at ${hit.url} with version ${hit.version}`)
}

async function webGithub() {
  const rel = await pre()
  if (!rel) return await skip("missing GitHub prerelease")
  const asset = webAsset(rel)
  if (!asset) return await skip(`missing GitHub web prerelease asset in ${rel.tag_name}`)
  await installWebAsset(asset)
  const hit = await webReady()
  const want = ver(rel)
  if (cmp(hit.version, want) < 0) throw new Error(`Expected web version ${want}, got ${hit.version}`)
  await pass(`GitHub web install started version ${hit.version}`)
}

async function webAuto() {
  const item = webSiteInstaller()
  if (!item) return await skip("missing website installer mapping")
  const stable = await webStable()
  if (!stable) return await skip("missing website stable manifest")
  const beta = await webBeta()
  if (!beta) return await skip("missing downloadbeta manifest")
  if (cmp(beta.version, stable.version) <= 0) return await skip(`downloadbeta ${beta.version} is not newer than stable ${stable.version}`)
  const file = await download(item.url, item.name)
  await writeWebCfg()
  await runWebInstaller(file)
  const hit = await webPage()
  const state = { reload: false }
  hit.page.on("framenavigated", () => {
    state.reload = true
  })
  await waitWebToast(hit.page)
  await hit.page.getByRole("button", { name: /更新并重启|Update & Restart/i }).click()
  const next = await waitWebVersion(hit.url, beta.version, state)
  await hit.browser.close()
  if (!next.reload) throw new Error("Web automatic update did not reload the original browser page")
  await pass(`web auto update reloaded page to ${next.version}`)
}

async function webManual() {
  const item = webSiteInstaller()
  if (!item) return await skip("missing website installer mapping")
  if (!(await webStable())) return await skip("missing website stable manifest")
  const rel = await pre()
  if (!rel) return await skip("missing GitHub prerelease")
  const asset = webAsset(rel)
  if (!asset) return await skip(`missing GitHub web prerelease asset in ${rel.tag_name}`)
  const file = await download(item.url, item.name)
  await runWebInstaller(file)
  const hit = await webPage()
  await hit.browser.close()
  await installWebAsset(asset)
  const next = await webReady()
  const want = ver(rel)
  if (cmp(next.version, want) < 0) throw new Error(`Expected web version ${want}, got ${next.version}`)
  await pass(`web manual update restarted page at version ${next.version}`)
}

async function electronGithub() {
  const rel = await pre()
  if (!rel) return await skip("missing GitHub prerelease")
  const asset = electronAsset(rel)
  if (!asset) return await skip(`missing GitHub Electron prerelease asset in ${rel.tag_name}`)
  await installElectron(asset)
  await launchElectron(asset)
  await electronReady()
  await assertElectronVersion(ver(rel))
  await pass(`Electron GitHub install started version ${ver(rel)}`)
}

async function electronAuto() {
  const base = await stableOrFallback()
  if (base.fallback) return await skip(base.reason)
  const asset = electronAsset(base.release)!
  const target = await pre()
  if (!target) return await skip("missing GitHub prerelease")
  const next = electronAsset(target)
  if (!next) return await skip(`missing prerelease Electron asset in ${target.tag_name}`)
  if (cmp(ver(target), ver(base.release)) <= 0) return await skip(`prerelease ${ver(target)} is not newer than stable ${ver(base.release)}`)
  await installElectron(asset)
  await writeElectronCfg()
  await launchElectron(asset)
  await electronReady()
  if (manualElectron()) {
    await waitElectronLog(/update available; manual install required/i)
    await acceptDialog()
    await verifyReleaseLink(ver(target))
    await installElectron(next)
    await launchElectron(next)
    await electronReady()
    await assertElectronVersion(ver(target))
    await pass(`Electron manual-install update prompt opened release and updated to ${ver(target)}`)
    return
  }
  await waitElectronLog(/update download completed/i)
  await acceptDialog()
  await waitElectronVersion(ver(target))
  await electronReady()
  await pass(`Electron automatic update restarted to ${ver(target)}`)
}

async function electronManual() {
  const base = await stableOrFallback()
  if (base.fallback) return await skip(base.reason)
  const asset = electronAsset(base.release)!
  const target = await pre()
  if (!target) return await skip("missing GitHub prerelease")
  const next = electronAsset(target)
  if (!next) return await skip(`missing prerelease Electron asset in ${target.tag_name}`)
  await installElectron(asset)
  await launchElectron(asset)
  await electronReady()
  await installElectron(next)
  await launchElectron(next)
  await electronReady()
  await assertElectronVersion(ver(target))
  await pass(`Electron manual update started version ${ver(target)}`)
}

async function runWebInstaller(file: string) {
  if (cfg.platform === "windows") {
    await run("cmd.exe", ["/d", "/c", file], { timeout: 20 * 60_000 })
    return
  }
  await run("chmod", ["+x", file])
  await run(file, [], { timeout: 20 * 60_000 })
}

async function installWebAsset(asset: Asset) {
  const file = await download(asset.browser_download_url, asset.name)
  const dir = await unpack(file)
  const name = cfg.platform === "windows" ? "install.bat" : cfg.platform === "darwin" ? "install.command" : "install.sh"
  const runfile = await find(dir, name)
  if (!runfile) throw new Error(`Missing ${name} in ${asset.name}`)
  await runWebInstaller(runfile)
  if (file.endsWith(".dmg")) await unmount(dir)
}

async function installElectron(asset: Asset) {
  const file = await download(asset.browser_download_url, asset.name)
  if (cfg.platform === "darwin") {
    const dir = await mount(file)
    const app = await find(dir, ".app")
    if (!app) throw new Error(`No .app found in ${asset.name}`)
    const dest = path.join("/Applications", path.basename(app))
    await run("rm", ["-rf", dest])
    await run("cp", ["-R", app, dest])
    await unmount(dir)
    return
  }
  if (cfg.platform === "linux" && cfg.format === "appimage") {
    await run("chmod", ["+x", file])
    await write("electron-appimage-path.txt", file)
    return
  }
  if (cfg.platform === "linux" && cfg.format === "deb") {
    await run("sudo", ["apt-get", "install", "-y", file], { timeout: 20 * 60_000 })
    return
  }
  if (cfg.platform === "linux" && cfg.format === "rpm") {
    await elevate("dnf", ["install", "-y", file], { timeout: 20 * 60_000 })
    return
  }
  if (cfg.platform === "windows") {
    const proc = spawn(file, [], { detached: true, stdio: "ignore" })
    proc.unref()
    await driveInstaller()
    return
  }
  throw new Error(`Unsupported Electron install target: ${cfg.platform} ${cfg.format}`)
}

async function launchElectron(asset?: Asset) {
  await clearElectronLogs()
  if (cfg.platform === "darwin") {
    await run("open", ["-a", "Aether Desktop"])
    return
  }
  if (cfg.platform === "linux" && cfg.format === "appimage") {
    const file = (await fs.readFile(path.join(out, "electron-appimage-path.txt"), "utf8")).trim()
    const child = spawn(file, [], { detached: true, stdio: "ignore", env: process.env })
    child.unref()
    return
  }
  if (cfg.platform === "linux") {
    const bin = (await which("aether-desktop")) ?? (await first(["/opt/Aether Desktop/aether-desktop", "/opt/aether-desktop/aether-desktop"]))
    if (!bin) throw new Error("Could not find installed Electron Linux launcher")
    const child = spawn(bin, [], { detached: true, stdio: "ignore", env: process.env })
    child.unref()
    return
  }
  if (cfg.platform === "windows") {
    const exe = await winExe()
    if (!exe) throw new Error(`Could not find installed Electron exe after ${asset?.name ?? "install"}`)
    await run("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath ${ps(exe)}`])
  }
}

async function webPage() {
  const hit = await webReady()
  const mod = (await Function("return import('playwright')")()) as {
    chromium: {
      launch: () => Promise<{
        newPage: () => Promise<{
          goto: (url: string) => Promise<unknown>
          screenshot: (opts: { path: string; fullPage: boolean }) => Promise<unknown>
          close?: () => Promise<unknown>
          on: (name: string, fn: () => void) => void
          getByText: (pat: RegExp) => { waitFor: (opts: { timeout: number }) => Promise<void> }
          getByRole: (role: string, opts: { name: RegExp }) => { click: () => Promise<void> }
        }>
        close: () => Promise<unknown>
      }>
    }
  }
  const browser = await mod.chromium.launch()
  page = await browser.newPage()
  await page.goto(hit.url)
  return { browser, page, url: hit.url, version: hit.version }
}

async function webReady() {
  const ports = Array.from({ length: 16 }, (_, idx) => 4096 + idx)
  const end = Date.now() + 120_000
  while (Date.now() < end) {
    for (const port of ports) {
      const url = `http://127.0.0.1:${port}`
      const version = await webHealth(url)
      if (version) return { url, version }
    }
    await sleep(1000)
  }
  throw new Error("Timed out waiting for Web app health")
}

async function waitWebVersion(url: string, want: string, state: { reload: boolean }) {
  const end = Date.now() + 180_000
  while (Date.now() < end) {
    const version = await webHealth(url)
    if (version && cmp(version, want) >= 0) {
      for (let i = 0; i < 20 && !state.reload; i++) await sleep(250)
      return { version, reload: state.reload }
    }
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for Web version ${want}`)
}

async function waitWebToast(page: { getByText: (pat: RegExp) => { waitFor: (opts: { timeout: number }) => Promise<void> } }) {
  await page.getByText(/有可用更新|Update available/i).waitFor({ timeout: 180_000 })
}

async function webHealth(url: string) {
  const res = await fetch(`${url}/global/health?t=${Date.now()}`).catch(() => null)
  if (!res?.ok) return ""
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return typeof data?.version === "string" ? data.version : ""
}

async function electronReady() {
  await waitElectronLog(/server ready/i)
  await waitElectronWindow()
  await sleep(5000)
}

async function waitElectronWindow() {
  const end = Date.now() + 120_000
  while (Date.now() < end) {
    if (await electronWindow()) return
    await sleep(1000)
  }
  throw new Error("Timed out waiting for Electron main window")
}

async function electronWindow() {
  if (cfg.platform === "darwin") {
    const text = await capture("osascript", ["-e", 'tell application "System Events" to if exists process "Aether Desktop" then return count windows of process "Aether Desktop"']).catch(() => "")
    return Number(text.trim()) > 0
  }
  if (cfg.platform === "windows") {
    const text = await capture("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-Process | Where-Object { $_.ProcessName -like '*Aether*' -and $_.MainWindowHandle -ne 0 }).Count",
    ]).catch(() => "")
    return Number(text.trim()) > 0
  }
  const text = await capture("xdotool", ["search", "--onlyvisible", "--name", "Aether"]).catch(() => "")
  return text.trim().length > 0
}

async function waitElectronLog(pat: RegExp) {
  const end = Date.now() + 180_000
  while (Date.now() < end) {
    const logs = await electronLogs()
    for (const log of logs) {
      const text = await fs.readFile(log, "utf8").catch(() => "")
      await write(path.join("logs", path.basename(log)), text.slice(-300_000))
      if (pat.test(text)) return text
    }
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for Electron log pattern ${pat}`)
}

async function electronLogs() {
  const home = os.homedir()
  const list =
    cfg.platform === "darwin"
      ? [path.join(home, "Library/Logs/Aether Desktop/main.log")]
      : cfg.platform === "windows"
        ? [path.join(process.env.APPDATA ?? path.join(home, "AppData/Roaming"), "Aether Desktop/logs/main.log")]
        : [
            path.join(home, ".config/Aether Desktop/logs/main.log"),
            path.join(home, ".config/aether-desktop/logs/main.log"),
          ]
  return list.filter((x) => existsSync(x))
}

async function clearElectronLogs() {
  for (const log of await electronLogs()) {
    await fs.rm(log, { force: true }).catch(() => undefined)
  }
}

async function assertElectronVersion(want: string) {
  const got = await electronVersion()
  if (!got) throw new Error(`Could not determine Electron version; expected ${want}`)
  if (cmp(got, want) < 0) throw new Error(`Expected Electron version ${want}, got ${got}`)
}

async function waitElectronVersion(want: string) {
  const end = Date.now() + 180_000
  while (Date.now() < end) {
    const got = await electronVersion()
    if (got && cmp(got, want) >= 0) return
    for (const log of await electronLogs()) {
      const text = await fs.readFile(log, "utf8").catch(() => "")
      if (new RegExp(`app starting[\\s\\S]*${escape(want)}`, "i").test(text)) return
    }
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for Electron version ${want}`)
}

async function electronVersion() {
  if (cfg.platform === "darwin") {
    const app = "/Applications/Aether Desktop.app/Contents/Info.plist"
    if (!existsSync(app)) return ""
    return (await capture("defaults", ["read", app.replace(/\.plist$/, ""), "CFBundleShortVersionString"])).trim()
  }
  if (cfg.platform === "linux" && cfg.format === "deb") {
    return (await capture("dpkg-query", ["-W", "-f=${Version}", "aether-desktop"]).catch(() => "")).trim()
  }
  if (cfg.platform === "linux" && cfg.format === "rpm") {
    return (await capture("rpm", ["-q", "--qf", "%{VERSION}", "aether-desktop"]).catch(() => "")).trim()
  }
  if (cfg.platform === "windows") {
    const exe = await winExe()
    if (!exe) return ""
    return (
      await capture("powershell", ["-NoProfile", "-Command", `(Get-Item ${ps(exe)}).VersionInfo.ProductVersion`]).catch(
        () => "",
      )
    ).trim()
  }
  return await electronLogVersion()
}

async function electronLogVersion() {
  for (const log of await electronLogs()) {
    const text = await fs.readFile(log, "utf8").catch(() => "")
    const hit = text.match(/app starting[\s\S]{0,500}?version['"]?\s*[:=]\s*['"]?([0-9][^,'"\s}]*)/i)
    if (hit?.[1]) return hit[1]
  }
  return ""
}

async function driveInstaller() {
  const end = Date.now() + 180_000
  while (Date.now() < end) {
    await acceptDialog().catch(() => undefined)
    if (await winExe()) return
    await sleep(2000)
  }
  throw new Error("Timed out driving Windows installer with default choices")
}

async function acceptDialog() {
  if (cfg.platform === "darwin") {
    await run("osascript", ["-e", 'tell application "System Events" to key code 36'])
    return
  }
  if (cfg.platform === "windows") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    ])
    return
  }
  await run("xdotool", ["key", "Return"])
}

async function verifyReleaseLink(version: string) {
  const url = `https://github.com/Science-Discovery/Aether/releases/tag/v${version}`
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    const seen = await openUrl()
    if (seen.includes(url)) return
    await sleep(1000)
  }
  throw new Error(`GitHub Releases link was not observed: ${url}`)
}

async function openUrl() {
  if (cfg.platform === "darwin") {
    const js = 'tell application "Safari" to if (count of windows) > 0 then return URL of current tab of front window'
    return await capture("osascript", ["-e", js]).catch(() => "")
  }
  return await capture("bash", ["-lc", "ps -eo args | grep 'github.com/Science-Discovery/Aether/releases' | grep -v grep || true"])
}

async function writeWebCfg() {
  await writeCfg(JSON.stringify({ updateBaseUrl: "https://aether.aiphys.cn/downloadbeta" }, null, 2))
}

async function writeElectronCfg() {
  await writeCfg("{}\n")
}

async function writeCfg(text: string) {
  const dir = path.join(os.homedir(), ".config", "aether")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "update-config.jsonc"), text)
}

function webSiteInstaller() {
  const base = "https://aether.aiphys.cn/download/installer"
  if (cfg.platform === "windows" && cfg.arch === "x64") return { url: `${base}/aether_windows_installer.bat`, name: "aether_windows_installer.bat" }
  if (cfg.platform === "windows") return null
  if (cfg.platform === "darwin" && cfg.arch === "arm64") return { url: `${base}/aether_darwin_installer.command`, name: "aether_darwin_installer.command" }
  if (cfg.platform === "darwin" && cfg.arch === "x64") return { url: `${base}/aether_darwin_x64_installer.command`, name: "aether_darwin_x64_installer.command" }
  if (cfg.platform === "linux" && cfg.arch === "x64") return { url: `${base}/aether_linux_installer.sh`, name: "aether_linux_installer.sh" }
  if (cfg.platform === "linux" && cfg.arch === "arm64") return { url: `${base}/aether_linux_arm64_installer.sh`, name: "aether_linux_arm64_installer.sh" }
  return null
}

async function webStable() {
  return await webMeta("https://aether.aiphys.cn/download")
}

async function webBeta() {
  return await webMeta("https://aether.aiphys.cn/downloadbeta")
}

async function webMeta(base: string) {
  const file =
    cfg.platform === "darwin"
      ? `latest/mac-${cfg.arch}.yml`
      : cfg.platform === "linux"
        ? `latest/linux-${cfg.arch}.yml`
        : cfg.platform === "windows" && cfg.arch === "x64"
          ? "latest/windows-x64.yml"
          : ""
  if (!file) return null
  const res = await fetch(`${base}/${file}`).catch(() => null)
  if (!res?.ok) return null
  return parseYml(await res.text())
}

function parseYml(text: string): Meta {
  const meta: Meta = { version: "" }
  let sec = ""
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith("version:")) meta.version = clean(line.slice("version:".length))
    if (line === "package:") sec = "package"
    if (sec === "package") {
      if (line.startsWith("url:")) meta.package = { ...(meta.package ?? {}), url: clean(line.slice("url:".length)) }
      if (line.startsWith("sha512:")) meta.package = { ...(meta.package ?? {}), sha512: clean(line.slice("sha512:".length)) }
      if (line.startsWith("size:")) meta.package = { ...(meta.package ?? {}), size: Number(clean(line.slice("size:".length))) }
    }
  }
  return meta.version ? meta : { version: "" }
}

function webAsset(rel: Release) {
  const ext = cfg.platform === "darwin" ? "dmg" : "zip"
  const stem =
    cfg.platform === "darwin"
      ? `aether-darwin-${cfg.arch}`
      : cfg.platform === "linux"
        ? `aether-linux-${cfg.arch}`
        : cfg.platform === "windows" && cfg.arch === "x64"
          ? "aether-windows-x64"
        : ""
  if (!stem) return null
  const names = [`${stem}.${ext}`]
  const asset = rel.assets.find((x) => names.includes(x.name)) ?? null
  void write(
    path.join("release", `${rel.tag_name}-${cfg.product}-${cfg.platform}-${cfg.arch}.json`),
    JSON.stringify({ tag: rel.tag_name, want: names, hit: asset?.name ?? null, assets: rel.assets.map((x) => x.name) }, null, 2),
  )
  return asset
}

function electronAsset(rel: Release) {
  const names = electronNames()
  const asset = rel.assets.find((x) => names.includes(x.name)) ?? null
  void write(
    path.join("release", `${rel.tag_name}-${cfg.product}-${cfg.platform}-${cfg.arch}-${cfg.format || "default"}.json`),
    JSON.stringify({ tag: rel.tag_name, want: names, hit: asset?.name ?? null, assets: rel.assets.map((x) => x.name) }, null, 2),
  )
  return asset
}

function electronNames() {
  if (cfg.platform === "windows") return [`aether-desktop-win-${cfg.arch}.exe`, `aether-desktop-windows-${cfg.arch}.exe`]
  if (cfg.platform === "darwin") return [`aether-desktop-mac-${cfg.arch}.dmg`]
  if (cfg.format === "appimage") return [`aether-desktop-linux-${linuxArch()}.AppImage`]
  if (cfg.format === "deb") return [`aether-desktop-linux-${cfg.arch === "x64" ? "amd64" : "arm64"}.deb`]
  if (cfg.format === "rpm") return [`aether-desktop-linux-${cfg.arch === "x64" ? "x86_64" : "aarch64"}.rpm`]
  return []
}

function linuxArch() {
  if (cfg.arch === "x64") return "x86_64"
  return cfg.arch
}

async function stableOrFallback() {
  const list = await releases()
  const rel = list.find((x) => !x.draft && !x.prerelease)
  if (rel && electronAsset(rel)) return { fallback: false as const, release: rel }
  const next = list.find((x) => !x.draft && x.prerelease && electronAsset(x))
  if (!next) return { fallback: true as const, reason: "missing stable and prerelease Electron asset" }
  const why = rel ? `stable asset missing in ${rel.tag_name}` : "stable release missing"
  return { fallback: true as const, reason: `${why}; fallback ${next.tag_name} is installable but update case is skipped` }
}

async function pre() {
  const rel = (await releases()).find((x) => !x.draft && x.prerelease)
  return rel ?? null
}

async function releases() {
  const list = (await api("/releases")) as Release[]
  await write(
    "release/releases.json",
    JSON.stringify(
      list.map((rel) => ({
        tag: rel.tag_name,
        draft: rel.draft,
        prerelease: rel.prerelease,
        assets: rel.assets.map((asset) => asset.name),
      })),
      null,
      2,
    ),
  )
  return list
}

async function api(url: string) {
  const res = await fetch(`https://api.github.com/repos/Science-Discovery/Aether${url}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`GitHub API failed ${url}: ${res.status}`)
  return await res.json()
}

async function download(url: string, name: string) {
  const file = path.join(tmp, name)
  const res = await fetch(url, { redirect: "follow", headers: token && url.includes("github") ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`Download failed: ${url} ${res.status}`)
  await Bun.write(file, res)
  await write(`downloads/${name}.url.txt`, `${url}\n`)
  return file
}

async function okUrl(url: string) {
  const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } }).catch(() => null)
  return !!res?.ok || res?.status === 206
}

async function unpack(file: string) {
  if (file.endsWith(".zip")) {
    const dir = path.join(tmp, `${path.basename(file)}.out`)
    await fs.mkdir(dir, { recursive: true })
    if (cfg.platform === "windows") {
      await run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${ps(file)} -DestinationPath ${ps(dir)} -Force`])
      return dir
    }
    await run("unzip", ["-q", file, "-d", dir])
    return dir
  }
  if (file.endsWith(".dmg")) return await mount(file)
  return path.dirname(file)
}

async function mount(file: string) {
  const dir = path.join(tmp, `${path.basename(file)}.mnt`)
  await fs.mkdir(dir, { recursive: true })
  await run("hdiutil", ["attach", file, "-nobrowse", "-mountpoint", dir], { timeout: 120_000 })
  return dir
}

async function unmount(dir: string) {
  await run("hdiutil", ["detach", dir], { ok: [0, 16] })
}

async function find(dir: string, name: string): Promise<string | null> {
  const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const item of list) {
    const full = path.join(dir, item.name)
    if (item.name === name || item.name.endsWith(name)) return full
    if (item.isDirectory()) {
      const hit = await find(full, name)
      if (hit) return hit
    }
  }
  return null
}

async function first(list: string[]) {
  return list.find((x) => existsSync(x)) ?? null
}

async function which(name: string) {
  const cmd = process.platform === "win32" ? "where" : "command"
  const args = process.platform === "win32" ? [name] : ["-v", name]
  const hit = await capture(cmd, args).catch(() => "")
  return hit.split(/\r?\n/).find(Boolean) ?? null
}

async function winExe() {
  if (cfg.platform !== "windows") return null
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs"),
    path.join(process.env.ProgramFiles ?? "", ""),
    path.join(process.env["ProgramFiles(x86)"] ?? "", ""),
  ].filter(Boolean)
  for (const dir of roots) {
    const hit = await find(dir, "Aether Desktop.exe")
    if (hit) return hit
  }
  return null
}

function manualElectron() {
  return cfg.platform === "darwin" || (cfg.platform === "linux" && cfg.format !== "appimage")
}

async function run(cmd: string, args: string[], opts: Cmd = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const proc = spawn(cmd, args, {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const log = path.join(out, "commands.log")
  const timer = opts.timeout
    ? setTimeout(() => {
        proc.kill("SIGTERM")
      }, opts.timeout)
    : null
  proc.stdout.on("data", (x: Buffer) => {
    process.stdout.write(x)
    void fs.appendFile(log, x)
  })
  proc.stderr.on("data", (x: Buffer) => {
    process.stderr.write(x)
    void fs.appendFile(log, x)
  })
  const code = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (x) => resolve(x ?? 1))
  })
  if (timer) clearTimeout(timer)
  const ok = opts.ok ?? [0]
  if (!ok.includes(code)) throw new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}`)
}

async function elevate(cmd: string, args: string[], opts: Cmd = {}) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await run(cmd, args, opts)
    return
  }
  await run("sudo", [cmd, ...args], opts)
}

async function capture(cmd: string, args: string[]) {
  const proc = spawn(cmd, args, { cwd: root, env: process.env })
  const chunks: Buffer[] = []
  const errs: Buffer[] = []
  proc.stdout.on("data", (x: Buffer) => chunks.push(x))
  proc.stderr.on("data", (x: Buffer) => errs.push(x))
  const code = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject)
    proc.on("close", (x) => resolve(x ?? 1))
  })
  if (code !== 0) throw new Error(Buffer.concat(errs).toString() || `${cmd} exited ${code}`)
  return Buffer.concat(chunks).toString()
}

async function skip(reason: string) {
  await note(`\nstatus: skipped\nreason: ${reason}\n`)
  await write("result.json", JSON.stringify({ status: "skipped", cfg, reason }, null, 2))
  console.log(`SKIP: ${reason}`)
}

async function pass(msg: string) {
  await note(`\nstatus: passed\n${msg}\n`)
  await write("result.json", JSON.stringify({ status: "passed", cfg, message: msg }, null, 2))
}

async function write(file: string, text: string) {
  const dest = path.join(out, file)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.writeFile(dest, text)
}

async function collect() {
  for (const dir of collectDirs()) {
    if (!existsSync(dir)) continue
    await write(path.join("paths", safe(dir) + ".txt"), (await list(dir, 0)).join("\n"))
  }
  for (const log of await electronLogs()) {
    await write(path.join("logs", path.basename(log)), await fs.readFile(log, "utf8").catch(() => ""))
  }
}

async function screenshot() {
  await fs.mkdir(path.join(out, "screenshots"), { recursive: true })
  if (page) {
    await page.screenshot({ path: path.join(out, "screenshots", "web.png"), fullPage: true }).catch(() => undefined)
  }
  if (cfg.platform === "darwin") {
    await run("screencapture", ["-x", path.join(out, "screenshots", "screen.png")], { ok: [0, 1], timeout: 30_000 })
    return
  }
  if (cfg.platform === "windows") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `$p=${ps(path.join(out, "screenshots", "screen.png"))}; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $m=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($m); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $m.Save($p); $g.Dispose(); $m.Dispose()`,
    ], { timeout: 30_000 })
    return
  }
  await run("import", ["-window", "root", path.join(out, "screenshots", "screen.png")], { ok: [0, 1], timeout: 30_000 })
}

function collectDirs() {
  const home = os.homedir()
  const dirs = [
    path.join(home, ".config", "aether"),
    path.join(home, ".local", "share", "aether", "update", "aether"),
    path.join(home, ".local", "share", "applications", "aether"),
    path.join(home, "Applications", "aether"),
  ]
  if (cfg.platform === "windows") {
    dirs.push(
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "aether"),
      path.join(home, ".local", "share", "aether", "update", "aether"),
      path.join(process.env.APPDATA ?? "", "Aether Desktop"),
    )
  }
  if (cfg.platform === "darwin") {
    dirs.push("/Applications/Aether Desktop.app", path.join(home, "Library", "Logs", "Aether Desktop"))
  }
  if (cfg.platform === "linux") {
    dirs.push(path.join(home, ".config", "Aether Desktop"), "/opt/Aether Desktop", "/opt/aether-desktop")
  }
  return dirs.filter(Boolean)
}

async function list(dir: string, depth: number): Promise<string[]> {
  if (depth > 3) return []
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const rows: string[] = []
  for (const item of items.slice(0, 400)) {
    const full = path.join(dir, item.name)
    const stat = await fs.stat(full).catch(() => null)
    rows.push(`${"  ".repeat(depth)}${item.isDirectory() ? "d" : "f"} ${full}${stat ? ` ${stat.size}` : ""}`)
    if (item.isDirectory()) rows.push(...(await list(full, depth + 1)))
  }
  return rows
}

function safe(input: string) {
  return input.replace(/^[A-Za-z]:/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "root"
}

async function note(text: string) {
  if (!summary) return
  await fs.appendFile(summary, `${text}\n`)
}

function cmp(a: string, b: string) {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  if (pa.pre === null && pb.pre !== null) return 1
  if (pa.pre !== null && pb.pre === null) return -1
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0
  return 0
}

function parse(input: string) {
  const raw = input.trim().replace(/^v/i, "")
  const idx = raw.indexOf("-")
  const rel = idx >= 0 ? raw.slice(0, idx) : raw
  const nums = rel.split(".").map((x) => Number.parseInt(x, 10))
  if (nums.some((x) => Number.isNaN(x))) return null
  return { nums, pre: idx >= 0 ? raw.slice(idx + 1) : null }
}

function clean(input: string) {
  return input.trim().replace(/^['"]|['"]$/g, "")
}

function ver(rel: Release) {
  return rel.tag_name.replace(/^v/i, "")
}

function ps(input: string) {
  return `'${input.replace(/'/g, "''")}'`
}

function escape(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function env(key: string) {
  const val = process.env[key]?.trim()
  if (!val) throw new Error(`Missing ${key}`)
  return val
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
