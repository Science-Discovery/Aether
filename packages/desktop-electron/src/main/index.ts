import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import semver from "semver"
import type { Event } from "electron"
import { app, BrowserWindow, dialog, shell } from "electron"
import pkg from "electron-updater"
const { autoUpdater } = pkg

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import type { CommandChild } from "./cli"
import { installCli, killStaleSidecar, saveSidecarPid, syncCli } from "./cli"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { createMenu } from "./menu"
import "./paths"
import { ensureDesktopPersist } from "./persist"
import {
  getDefaultServerUrl,
  getProxyConfig,
  getWslConfig,
  setDefaultServerUrl,
  setProxyConfig,
  setWslConfig,
  spawnLocalServer,
} from "./server"
import { createLoadingWindow, createMainWindow, setBackgroundColor, setDockIcon } from "./windows"

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let sidecar: CommandChild | null = null
let sidecarPid: number | null = null
const loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const initDone = defer<void>()
const logger = initLogging()
const MANUAL_INSTALL_UPDATE = process.platform === "darwin" || (process.platform === "linux" && !process.env.APPIMAGE)
const SITE_URL = "https://aether.aiphys.cn/"
const UPDATE_URL = "https://aether.aiphys.cn/download/desktop/latest"
const RENDERER_UPDATER_ENABLED = UPDATER_ENABLED && !MANUAL_INSTALL_UPDATE
const SETTINGS_UPDATER_ENABLED = UPDATER_ENABLED

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
})

setupApp()

// Last-resort synchronous cleanup: fires on normal exit and most crash paths,
// but NOT on SIGKILL (which is fundamentally uncatchable — killStaleSidecar
// handles that on next startup). On macOS/Linux the detached process is in its
// own process group (PGID = sidecarPid), so killing -PGID removes it entirely.
process.on("exit", () => {
  if (sidecarPid === null) return
  if (process.platform !== "win32") {
    try {
      process.kill(-sidecarPid, "SIGKILL")
    } catch {
      // process already gone — ignore
    }
  }
})

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("aether://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    killSidecar()
  })

  app.on("will-quit", () => {
    killSidecar()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecar()
      app.exit(0)
    })
  }

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("aether")
    setDockIcon()
    setupAutoUpdater()
    syncCli()
    await initialize()
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize() {
  let overlay: BrowserWindow | null = null

  const port = await getSidecarPort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  ensureDesktopPersist()
  logger.log("killing stale sidecar processes")
  await killStaleSidecar()
  logger.log("spawning sidecar", { url })
  const { child, health, events } = spawnLocalServer(hostname, port, password)
  sidecar = child
  sidecarPid = child.pid ?? null
  if (child.pid) saveSidecarPid(child.pid)
  serverReady.resolve({
    url,
    username: "opencode",
    password,
  })

  let sidecarFailed = false

  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    const probe = Promise.race([
      health.wait,
      delay(30_000).then(() => {
        throw new Error("Sidecar health check timed out")
      }),
    ]).catch((error) => {
      logger.error("sidecar health check failed", error)
      sidecarFailed = true
    })

    events.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    await probe

    logger.log("loading task finished")
  })()

  const globals = {
    updaterEnabled: RENDERER_UPDATER_ENABLED,
    settingsUpdaterEnabled: SETTINGS_UPDATER_ENABLED,
    deepLinks: pendingDeepLinks,
  }

  const show = await Promise.race([loadingTask.then(() => false), delay(1_000).then(() => true)])
  if (show) {
    overlay = createLoadingWindow(globals)
    await delay(1_000)
  }

  await loadingTask
  setInitStep({ phase: "done" })
  initDone.resolve()

  if (sidecarFailed) {
    overlay?.close()
    await dialog
      .showMessageBox({
        type: "error",
        title: "Startup Failed",
        message: "Backend service failed to start.",
        detail: `Possible cause: antivirus software blocked ${process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"}.\nPlease add it to your antivirus whitelist and restart.`,
        buttons: ["Restart", "Quit"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((response) => {
        killSidecar()
        if (response.response === 0) {
          app.relaunch()
        }
        app.exit(response.response === 0 ? 0 : 1)
      })
    return
  }

  if (overlay) {
    await loadingComplete.promise
  }

  mainWindow = createMainWindow(globals)
  wireMenu()

  overlay?.close()
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    installCli: () => {
      void installCli()
    },
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      killSidecar()
      app.relaunch()
      app.exit(0)
    },
  })
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  installCli: async () => installCli(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      if (initStep.phase !== "done") await initDone.promise
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getProxyConfig: () => Promise.resolve(getProxyConfig()),
  setProxyConfig: async (config) => {
    setProxyConfig(config)
    const data = await serverReady.promise.catch(() => null)
    if (!data) return
    if (!data.username || !data.password) return
    const auth = Buffer.from(`${data.username}:${data.password}`).toString("base64")
    await fetch(new URL("/global/proxy", data.url), {
      method: "PATCH",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined)
  },
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  setBackgroundColor: (color) => setBackgroundColor(color),
})

function killSidecar() {
  if (!sidecar) return
  const pid = sidecar.pid
  sidecar.kill()
  sidecar = null
  sidecarPid = null
  // tree-kill is async; also send process group signal as immediate fallback
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
  }
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  const AETHER_PORT = 19527
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const server = createServer()
      server.on("error", () => {
        server.close()
        resolve(null)
      })
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port))
      })
    })

  for (let i = 0; i < 5; i++) {
    const port = await tryPort(AETHER_PORT + i)
    if (port !== null) return port
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.setFeedURL(UPDATE_URL)
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  logger.log("auto updater configured", {
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  const INTERVAL = 24 * 60 * 60 * 1000
  setTimeout(() => {
    void checkForUpdates(false)
    setInterval(() => void checkForUpdates(false), INTERVAL)
  }, 10_000)
}

let updateReady = false
type Check = { updateAvailable: boolean; version?: string; failed?: boolean }
let checking: Promise<Check> | undefined

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  if (checking) return checking
  checking = (async () => {
    autoUpdater.allowDowngrade = false
    updateReady = false
    const base = beta()

    let preVersion: string | null = null
    if (base) {
      autoUpdater.setFeedURL(base)
      autoUpdater.allowPrerelease = true
      logger.log("checking for updates (prerelease)", {
        currentVersion: app.getVersion(),
        allowPrerelease: true,
        feed: base,
      })
      try {
        const r = await autoUpdater.checkForUpdates()
        preVersion = r?.updateInfo?.version ?? null
        if (r?.isUpdateAvailable && preVersion) {
          logger.log("prerelease update found", { version: preVersion })
        } else {
          logger.log("no prerelease update available")
        }
      } catch (error) {
        logger.error("prerelease update check failed", error)
      }
    }

    autoUpdater.setFeedURL(UPDATE_URL)
    autoUpdater.allowPrerelease = false
    logger.log("checking for updates (stable)", {
      currentVersion: app.getVersion(),
      allowPrerelease: false,
      feed: UPDATE_URL,
    })
    let stableVersion: string | undefined
    let stableAvailable = false
    let stableFailed = false
    try {
      const result = await autoUpdater.checkForUpdates()
      stableVersion = result?.updateInfo?.version
      stableAvailable = result?.isUpdateAvailable !== false && !!stableVersion
      logger.log("update metadata fetched", {
        releaseVersion: result?.updateInfo?.version ?? null,
        releaseDate: result?.updateInfo?.releaseDate ?? null,
        releaseName: result?.updateInfo?.releaseName ?? null,
        files: result?.updateInfo?.files?.map((file) => file.url) ?? [],
      })
    } catch (error) {
      stableFailed = true
      logger.error("stable update check failed", error)
    }

    try {
      if (!stableAvailable && !preVersion) {
        if (stableFailed) return { updateAvailable: false, failed: true }
        logger.log("no update available", { reason: "no newer version in any channel" })
        return { updateAvailable: false }
      }

      const pickPre = !!preVersion && (!stableAvailable || semver.gt(preVersion, stableVersion!))
      if (pickPre) {
        logger.log("prerelease version is newer, re-checking to set download state", {
          preVersion,
          stableVersion: stableVersion ?? null,
        })
        autoUpdater.allowPrerelease = true
        if (base) autoUpdater.setFeedURL(base)
        try {
          const r2 = await autoUpdater.checkForUpdates()
          const v2 = r2?.updateInfo?.version
          if (r2?.isUpdateAvailable && v2) {
            const version = v2
            if (MANUAL_INSTALL_UPDATE) {
              logger.log("update available; manual install required", { version, platform: process.platform })
              return { updateAvailable: true, version }
            }
            await autoUpdater.downloadUpdate()
            logger.log("update download completed", { version })
            updateReady = true
            return { updateAvailable: true, version }
          }
        } catch (error) {
          logger.error("prerelease re-check failed, falling back to stable", error)
        }
        if (!stableAvailable) {
          logger.log("no update decision", {
            reason: "prerelease re-check failed and no stable fallback",
          })
          return { updateAvailable: false, failed: true }
        }
        autoUpdater.allowPrerelease = false
        autoUpdater.setFeedURL(UPDATE_URL)
        await autoUpdater.checkForUpdates()
      }

      const version = stableVersion!
      if (MANUAL_INSTALL_UPDATE) {
        logger.log("update available; manual install required", { version, platform: process.platform })
        return { updateAvailable: true, version }
      }
      await autoUpdater.downloadUpdate()
      logger.log("update download completed", { version })
      updateReady = true
      return { updateAvailable: true, version }
    } catch (error) {
      logger.error("update check failed", error)
      return { updateAvailable: false, failed: true }
    }
  })().finally(() => {
    checking = undefined
  })
  return checking
}

async function installUpdate() {
  if (MANUAL_INSTALL_UPDATE) {
    await shell.openExternal(SITE_URL)
    return
  }
  if (!updateReady) return
  killSidecar()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  if (MANUAL_INSTALL_UPDATE) {
    const response = await dialog.showMessageBox({
      type: "info",
      title: "Update Available",
      message: `Aether Desktop ${result.version ?? ""} is available.`,
      detail:
        process.platform === "darwin"
          ? "Automatic download and installation are not enabled for macOS yet. Please download the latest macOS release from the Aether website and replace your existing app."
          : "Automatic download and installation are only enabled for Linux AppImage builds. Please download the latest .deb or .rpm package from the Aether website and upgrade with your package manager.",
      buttons: ["Open Aether Website", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response.response === 0) await shell.openExternal(SITE_URL)
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}

function beta() {
  const file = ["jsonc", "json"].map((ext) => join(cfg(), `update-config.${ext}`)).find((item) => existsSync(item))
  if (!file) return null
  const data: unknown = (() => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch {
      return null
    }
  })()
  if (!data || typeof data !== "object") return null
  if (!("updateBaseUrl" in data) || typeof data.updateBaseUrl !== "string") return null
  const url = data.updateBaseUrl.trim()
  if (!url) return null
  return `${url.replace(/\/+$/, "")}/desktop/latest`
}

function cfg() {
  const root = process.env.XDG_CONFIG_HOME || join(process.env.OPENCODE_TEST_HOME || app.getPath("home"), ".config")
  return join(root, "aether")
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
