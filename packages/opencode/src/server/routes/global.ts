import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { spawn } from "child_process"
import { BusEvent } from "@/bus/bus-event"
import { SyncEvent } from "@/sync"
import { GlobalBus } from "@/bus/global"
import { AsyncQueue } from "@/util/queue"
import { Instance } from "../../project/instance"
import { Installation } from "@/installation"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"
import { Config } from "../../config/config"
import { errors } from "../error"
import { Lease } from "../lease"

const log = Log.create({ service: "server" })

export const GlobalDisposedEvent = BusEvent.define("global.disposed", z.object({}))

const ProxyTarget = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
})

const ProxyConfig = z.object({
  enabled: z.boolean(),
  http: ProxyTarget,
  https: ProxyTarget,
})

const PingInput = z.object({
  id: z.string().min(1),
  alive: z.boolean().optional(),
})

const WebUpdateOS = z.enum(["darwin", "linux", "windows"])

const WEB_UPDATE_BASE = "https://aether.aiphys.cn/download"

const INSTALLER_YML: Record<string, string> = {
  darwin: "latest/mac-arm64.yml",
  linux: "latest/linux-x64.yml",
  windows: "latest/windows-x64.yml",
}

const INSTALLER_SCRIPT: Record<string, string> = {
  darwin: "aether_darwin_installer.command",
  linux: "aether_linux_installer.sh",
  windows: "aether_windows_installer.bat",
}

async function findInstallerScript(os: string): Promise<string | null> {
  const name = INSTALLER_SCRIPT[os]
  if (!name) return null
  const appRoot = getAppRoot()
  const candidates = [
    // web package: Update/ dir inside app root
    path.join(appRoot, "Update", name),
    // electron: extraResources puts Update/ next to the app
    path.join(appRoot, "..", "Resources", "Update", name),
    // fallback: script directly in app root
    path.join(appRoot, name),
    // dev mode: run from packages/opencode, repo Update/ is ../../Update/
    path.join(process.cwd(), "Update", name),
    path.join(process.cwd(), "..", "..", "Update", name),
  ]
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate)
      await fs.access(resolved)
      return resolved
    } catch {}
  }
  return null
}

function computeWorkDir(scriptPath: string): string {
  const dir = path.dirname(path.resolve(scriptPath))
  const base = path.basename(dir)
  if (base.startsWith("aether-")) return path.dirname(dir)
  return dir
}

function parseResultYml(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const m = line.match(/^(\w+):\s*'(.*)'/)
    if (m) result[m[1]] = m[2]
    else {
      const n = line.match(/^(\w+):\s*(\S+)/)
      if (n) result[n[1]] = n[2]
    }
  }
  return result
}

function getAppRoot(): string {
  return path.dirname(process.execPath)
}

function generateSelfUpdateScript(os: string, pkgPath: string, appRoot: string): string {
  const escaped = (s: string) => s.replace(/'/g, "'\\''")
  if (os === "darwin") {
    return `#!/bin/bash
set -euo pipefail
PKG='${escaped(pkgPath)}'
ROOT='${escaped(appRoot)}'
SELF=$(perl -MCwd -e 'print Cwd::abs_path(shift)' "$0" 2>/dev/null || echo "")
echo "Aether self-update starting..." >&2
sleep 3
MNT=$(hdiutil attach -nobrowse -noautoopen "$PKG" 2>/dev/null | tail -1 | awk '{print $NF}')
if [ -z "$MNT" ]; then
  echo "Failed to mount DMG" >&2; exit 1
fi
SRC="$MNT"
# if DMG has a single wrapper dir, descend into it
WRAPPER=$(find "$MNT" -mindepth 1 -maxdepth 1 -type d ! -name ".*" | head -1)
if [ -n "$WRAPPER" ]; then
  CNT=$(find "$MNT" -mindepth 1 -maxdepth 1 ! -name ".*" | wc -l | tr -d ' ')
  [ "$CNT" -eq 1 ] && SRC="$WRAPPER"
fi
APP=$(find "$SRC" -maxdepth 1 -name "*.app" -type d | head -1)
if [ -n "$APP" ]; then
  # .app bundle: extract binary, frameworks, resources to flat ROOT
  BIN=$(find "$APP/Contents/MacOS" -type f 2>/dev/null | head -1)
  if [ -n "$BIN" ]; then
    BASENAME=$(basename "$BIN")
    cp -f "$BIN" "$ROOT/$BASENAME" 2>/dev/null || true
    chmod +x "$ROOT/$BASENAME" 2>/dev/null || true
  fi
  if [ -d "$APP/Contents/Frameworks" ]; then
    mkdir -p "$ROOT/Frameworks" 2>/dev/null || true
    rsync -a --delete "$APP/Contents/Frameworks/" "$ROOT/Frameworks/"
  fi
  if [ -d "$APP/Contents/Resources" ]; then
    mkdir -p "$ROOT/Resources" 2>/dev/null || true
    rsync -a --delete --exclude='Update/downloads' "$APP/Contents/Resources/" "$ROOT/Resources/"
  fi
  # copy other top-level items from Contents (locales, etc.)
  for item in "$APP/Contents/"*; do
    name=$(basename "$item")
    case "$name" in MacOS|Frameworks|Resources|Info.plist|PkgInfo|CodeSignature|_CodeSignature|.LSOverride) continue ;; esac
    if [ -d "$item" ]; then
      mkdir -p "$ROOT/$name" 2>/dev/null || true
      rsync -a --delete "$item/" "$ROOT/$name/"
    elif [ -f "$item" ]; then
      cp -f "$item" "$ROOT/$name" 2>/dev/null || true
    fi
  done
else
  # flat directory structure: rsync directly
  rsync -a --delete --exclude='Update/downloads' "$SRC/" "$ROOT/"
  # ensure binary is executable
  chmod +x "$ROOT/Aether" 2>/dev/null || true
  chmod +x "$ROOT/opencode" 2>/dev/null || true
fi
hdiutil detach "$MNT" -force 2>/dev/null || true
echo "Update complete, restarting..." >&2
# cleanup self
[ -n "$SELF" ] && rm -f "$SELF" 2>/dev/null || true
# launch the new binary
BIN="$ROOT/Aether"
[ ! -x "$BIN" ] && BIN="$ROOT/opencode"
if [ -x "$BIN" ]; then
  cd "$ROOT" && nohup "$BIN" >/dev/null 2>&1 &
else
  echo "No executable found in $ROOT" >&2; exit 1
fi
`
  }
  if (os === "linux") {
    return `#!/bin/bash
set -euo pipefail
PKG='${escaped(pkgPath)}'
ROOT='${escaped(appRoot)}'
echo "Aether self-update starting..." >&2
sleep 2
TMP=$(mktemp -d)
case "$PKG" in
  *.tar.gz|*.tgz) tar xzf "$PKG" -C "$TMP" ;;
  *.tar.xz) tar xJf "$PKG" -C "$TMP" ;;
  *.zip) unzip -o -q "$PKG" -d "$TMP" ;;
  *.AppImage) cp "$PKG" "$ROOT/" ;;
  *) echo "Unknown package format: $PKG" >&2; rm -rf "$TMP"; exit 1 ;;
esac
CNT=$(find "$TMP" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
if [ "$CNT" -eq 1 ]; then
  DIR=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -n "$DIR" ] && rsync -a --delete "$DIR/" "$ROOT/"
else
  rsync -a --delete "$TMP/" "$ROOT/"
fi
rm -rf "$TMP"
chmod +x "$ROOT/Aether" 2>/dev/null || true
echo "Update complete, restarting..." >&2
nohup "$ROOT/Aether" >/dev/null 2>&1 &
`
  }
  // windows
  return `@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "PKG=${pkgPath.replace(/\\/g, "\\\\")}"
set "ROOT=${appRoot.replace(/\\/g, "\\\\")}"
echo Aether self-update starting...
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "& {
  $pkg = $env:PKG; $root = $env:ROOT; $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'aether-update-' + [GUID]::NewGuid().ToString('N'))
  Expand-Archive -LiteralPath $pkg -DestinationPath $tmp -Force
  $items = Get-ChildItem -LiteralPath $tmp
  if ($items.Count -eq 1 -and $items[0].PSIsContainer) {
    Get-ChildItem -LiteralPath $items[0].FullName -Recurse | ForEach-Object {
      $dest = Join-Path $root $_.FullName.Substring($items[0].FullName.Length).TrimStart('\\')
      if ($_.PSIsContainer) { New-Item -ItemType Directory -Path $dest -Force -ErrorAction SilentlyContinue } else { Copy-Item -LiteralPath $_.FullName -Destination $dest -Force }
    }
  } else { Copy-Item -Path "$tmp\\*" -Destination $root -Recurse -Force }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Start-Process (Join-Path $root 'Aether.exe')
}"
`
}


function parseProxy(value?: string) {
  if (!value) return { host: "", port: 8080 }
  try {
    const url = new URL(value)
    const port = Number.parseInt(url.port, 10)
    return {
      host: url.hostname,
      port: Number.isInteger(port) ? port : 8080,
    }
  } catch {
    return { host: "", port: 8080 }
  }
}

function keepLoopbackNoProxy(value?: string) {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (items.some((item) => item.toLowerCase() === host)) continue
    items.push(host)
  }
  return items.join(",")
}

async function streamEvents(c: Context, subscribe: (q: AsyncQueue<string | null>) => () => void) {
  return streamSSE(c, async (stream) => {
    const q = new AsyncQueue<string | null>()
    let done = false

    q.push(
      JSON.stringify({
        payload: {
          type: "server.connected",
          properties: {},
        },
      }),
    )

    // Send heartbeat every 10s to prevent stalled proxy streams.
    const heartbeat = setInterval(() => {
      q.push(
        JSON.stringify({
          payload: {
            type: "server.heartbeat",
            properties: {},
          },
        }),
      )
    }, 10_000)

    const stop = () => {
      if (done) return
      done = true
      clearInterval(heartbeat)
      unsub()
      q.push(null)
      log.info("global event disconnected")
    }

    const unsub = subscribe(q)

    stream.onAbort(stop)

    try {
      for await (const data of q) {
        if (data === null) return
        await stream.writeSSE({ data })
      }
    } finally {
      stop()
    }
  })
}

export const GlobalRoutes = lazy(() =>
  new Hono()
    .get(
      "/proxy",
      describeRoute({
        summary: "Get proxy configuration",
        description: "Get current process-level HTTP/HTTPS proxy configuration.",
        operationId: "global.proxy.get",
        responses: {
          200: {
            description: "Proxy config",
            content: {
              "application/json": {
                schema: resolver(ProxyConfig),
              },
            },
          },
        },
      }),
      async (c) => {
        const all = parseProxy(process.env.ALL_PROXY ?? process.env.all_proxy)
        const http = parseProxy(process.env.HTTP_PROXY ?? process.env.http_proxy)
        const https = parseProxy(process.env.HTTPS_PROXY ?? process.env.https_proxy)
        return c.json({
          enabled: !!(http.host || https.host || all.host),
          http: http.host ? http : all,
          https: https.host ? https : all,
        })
      },
    )
    .patch(
      "/proxy",
      describeRoute({
        summary: "Update proxy configuration",
        description: "Update process-level HTTP/HTTPS proxy configuration.",
        operationId: "global.proxy.update",
        responses: {
          200: {
            description: "Updated proxy config",
            content: {
              "application/json": {
                schema: resolver(ProxyConfig),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", ProxyConfig),
      async (c) => {
        const config = c.req.valid("json")
        if (!config.enabled) {
          delete process.env.HTTP_PROXY
          delete process.env.HTTPS_PROXY
          delete process.env.ALL_PROXY
          delete process.env.http_proxy
          delete process.env.https_proxy
          delete process.env.all_proxy
          log.info("proxy updated", { enabled: false })
          return c.json(config)
        }
        const http = config.http.host.trim() ? `http://${config.http.host.trim()}:${config.http.port}` : ""
        const https = config.https.host.trim() ? `http://${config.https.host.trim()}:${config.https.port}` : ""
        if (!http && !https) return c.json({ error: "Proxy host is required for HTTP or HTTPS" }, 400)
        const httpValue = http || https
        const httpsValue = https || http
        process.env.HTTP_PROXY = httpValue
        process.env.HTTPS_PROXY = httpsValue
        process.env.ALL_PROXY = httpsValue
        process.env.http_proxy = httpValue
        process.env.https_proxy = httpsValue
        process.env.all_proxy = httpsValue
        const noProxy = keepLoopbackNoProxy(process.env.NO_PROXY ?? process.env.no_proxy)
        process.env.NO_PROXY = noProxy
        process.env.no_proxy = noProxy
        log.info("proxy updated", {
          enabled: true,
          http_host: config.http.host.trim() || "-",
          http_port: config.http.port,
          https_host: config.https.host.trim() || "-",
          https_port: config.https.port,
          no_proxy: noProxy,
        })
        return c.json({
          ...config,
          http: {
            ...config.http,
            host: config.http.host.trim(),
          },
          https: {
            ...config.https,
            host: config.https.host.trim(),
          },
        })
      },
    )
    .get(
      "/health",
      describeRoute({
        summary: "Get health",
        description: "Get health information about the OpenCode server.",
        operationId: "global.health",
        responses: {
          200: {
            description: "Health information",
            content: {
              "application/json": {
                schema: resolver(z.object({ healthy: z.literal(true), version: z.string() })),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({ healthy: true, version: Installation.VERSION })
      },
    )
    .post(
      "/ping",
      describeRoute({
        summary: "Ping lease",
        description: "Refresh or release browser lease for web auto-exit detection.",
        operationId: "global.ping",
        responses: {
          200: {
            description: "Lease touched",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.literal(true) })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", PingInput),
      async (c) => {
        const body = c.req.valid("json")
        if (body.alive === false) {
          Lease.drop(body.id)
          return c.json({ ok: true as const })
        }
        Lease.touch(body.id)
        return c.json({ ok: true as const })
      },
    )
    .get(
      "/event",
      describeRoute({
        summary: "Get global events",
        description: "Subscribe to global events from the OpenCode system using server-sent events.",
        operationId: "global.event",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      directory: z.string(),
                      payload: BusEvent.payloads(),
                    })
                    .meta({
                      ref: "GlobalEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global event connected")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamEvents(c, (q) => {
          async function handler(event: any) {
            q.push(JSON.stringify(event))
          }
          GlobalBus.on("event", handler)
          return () => GlobalBus.off("event", handler)
        })
      },
    )
    .get(
      "/sync-event",
      describeRoute({
        summary: "Subscribe to global sync events",
        description: "Get global sync events",
        operationId: "global.sync-event.subscribe",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: resolver(
                  z
                    .object({
                      payload: SyncEvent.payloads(),
                    })
                    .meta({
                      ref: "SyncEvent",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        log.info("global sync event connected")
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamEvents(c, (q) => {
          return SyncEvent.subscribeAll(({ def, event }) => {
            // TODO: don't pass def, just pass the type (and it should
            // be versioned)
            q.push(
              JSON.stringify({
                payload: {
                  ...event,
                  type: SyncEvent.versionedType(def.type, def.version),
                },
              }),
            )
          })
        })
      },
    )
    .get(
      "/config",
      describeRoute({
        summary: "Get global configuration",
        description: "Retrieve the current global OpenCode configuration settings and preferences.",
        operationId: "global.config.get",
        responses: {
          200: {
            description: "Get global config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Config.getGlobal())
      },
    )
    .patch(
      "/config",
      describeRoute({
        summary: "Update global configuration",
        description: "Update global OpenCode configuration settings and preferences.",
        operationId: "global.config.update",
        responses: {
          200: {
            description: "Successfully updated global config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        const next = await Config.updateGlobal(config)
        return c.json(next)
      },
    )
    .post(
      "/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        operationId: "global.dispose",
        responses: {
          200: {
            description: "Global disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.disposeAll()
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: GlobalDisposedEvent.type,
            properties: {},
          },
        })
        return c.json(true)
      },
    )
    .get(
      "/web-update/check",
      describeRoute({
        summary: "Check web update",
        description: "Check for available web application updates by fetching remote version metadata.",
        operationId: "global.web-update.check",
        responses: {
          200: {
            description: "Version check result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    currentVersion: z.string(),
                    remoteVersion: z.string(),
                    updateAvailable: z.boolean(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const os = c.req.query("os")
        if (!os || !WebUpdateOS.safeParse(os).success) {
          return c.json({ error: "Invalid or missing 'os' query parameter. Expected: darwin, linux, or windows" }, 400)
        }
        const ymlPath = INSTALLER_YML[os]
        const metaUrl = `${WEB_UPDATE_BASE}/${ymlPath}`
        try {
          const res = await fetch(metaUrl)
          if (!res.ok) {
            return c.json({ error: `Failed to fetch version metadata: ${res.status}` }, 400)
          }
          const text = await res.text()
          const match = text.match(/^version:\s*(.+)$/m)
          const remoteVersion = (match?.[1]?.trim() ?? "").replace(/^['"]|['"]$/g, "")
          if (!remoteVersion) {
            return c.json({ error: "Could not parse remote version from metadata" }, 400)
          }
          const currentVersion = Installation.VERSION
          // also check if a newer version was already downloaded
          let downloadedVersion = ""
          try {
            const scriptPath2 = await findInstallerScript(os)
            if (scriptPath2) {
              const wd = computeWorkDir(scriptPath2)
              const rp = path.join(wd, "downloads", "last-result.yml")
              const content = await fs.readFile(rp, "utf-8")
              const cached = parseResultYml(content)
              if (cached.target_version) downloadedVersion = cached.target_version
            }
          } catch {}
          return c.json({
            currentVersion,
            remoteVersion,
            updateAvailable: remoteVersion !== currentVersion,
            downloadedVersion,
          })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return c.json({ error: `Failed to check update: ${message}` }, 400)
        }
      },
    )
    .post(
      "/web-update/download",
      describeRoute({
        summary: "Download web update script",
        description: "Download the update/install script for the specified OS and version.",
        operationId: "global.web-update.download",
        responses: {
          200: {
            description: "Download result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({ success: z.literal(true), path: z.string() }),
                    z.object({ success: z.literal(false), error: z.string() }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          os: WebUpdateOS,
          version: z.string().min(1),
        }),
      ),
      async (c) => {
        const { os, version } = c.req.valid("json")
        const scriptPath = await findInstallerScript(os)
        if (!scriptPath) {
          return c.json({ success: false as const, error: `Installer script not found for ${os}` })
        }
        try {
          await fs.chmod(scriptPath, 0o755)
        } catch {}
        const workDir = computeWorkDir(scriptPath)
        const currentVersion = Installation.VERSION
        // check if latest version is already downloaded
        const resultPath = path.join(workDir, "downloads", "last-result.yml")
        try {
          const content = await fs.readFile(resultPath, "utf-8")
          const cached = parseResultYml(content)
          if (
            cached.status === "update_ready" &&
            cached.target_version === version &&
            cached.package_path
          ) {
            await fs.access(cached.package_path).catch(() => { throw new Error("missing") })
            log.info("using cached download", { os, version, pkg: cached.package_path })
            return c.json({ success: true as const, path: resultPath })
          }
        } catch {}
        log.info("running installer auto mode", { os, script: scriptPath, version: currentVersion, workDir })
        try {
          const exitCode = await new Promise<number>((resolve, reject) => {
            const cmd = os === "windows" ? "cmd" : "bash"
            const cmdArgs = os === "windows"
              ? ["/c", scriptPath, "auto", currentVersion]
              : [scriptPath, "auto", currentVersion]
            const child = spawn(cmd, cmdArgs, { cwd: workDir })
            child.on("close", (code: number | null) => resolve(code ?? 1))
            child.on("error", reject)
          })
          let resultData: Record<string, string> = {}
          try {
            const content = await fs.readFile(resultPath, "utf-8")
            resultData = parseResultYml(content)
          } catch {}
          log.info("installer auto result", { exitCode, status: resultData.status, workDir })
          if (exitCode === 20) {
            return c.json({ success: false as const, error: "Already up to date" })
          }
          if (exitCode === 10) {
            return c.json({ success: true as const, path: resultPath })
          }
          const errMsg = resultData.status ?? `Installer exited with code ${exitCode}`
          return c.json({ success: false as const, error: errMsg })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return c.json({ success: false as const, error: `Download failed: ${message}` })
        }
      },
    )
    .post(
      "/web-update/install",
      describeRoute({
        summary: "Execute web update script",
        description: "Execute the previously downloaded update script to install the new version.",
        operationId: "global.web-update.install",
        responses: {
          200: {
            description: "Install result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({ success: z.literal(true) }),
                    z.object({ success: z.literal(false), error: z.string() }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          os: WebUpdateOS,
        }),
      ),
      async (c) => {
        const { os } = c.req.valid("json")
        const scriptPath = await findInstallerScript(os)
        if (!scriptPath) {
          return c.json({ success: false as const, error: `Installer script not found for ${os}` })
        }
        const workDir = computeWorkDir(scriptPath)
        const resultPath = path.join(workDir, "downloads", "last-result.yml")
        let resultData: Record<string, string> = {}
        try {
          const content = await fs.readFile(resultPath, "utf-8")
          resultData = parseResultYml(content)
        } catch {}
        const installerExe = resultData.installer_path
        if (installerExe) {
          try {
            await fs.access(installerExe)
          } catch {
            return c.json({ success: false as const, error: `Version installer not found: ${installerExe}` })
          }
          try {
            await fs.chmod(installerExe, 0o755)
          } catch {}
          log.info("launching version installer", { os, installer: installerExe })
          try {
            const child = os === "windows"
              ? spawn("cmd", ["/c", installerExe], { detached: true, stdio: "ignore", cwd: workDir })
              : spawn("bash", [installerExe], { detached: true, stdio: "ignore", cwd: workDir })
            child.unref()
            log.info("version installer launched", { os, path: installerExe, pid: child.pid })
            return c.json({ success: true as const })
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            return c.json({ success: false as const, error: `Failed to execute installer: ${message}` })
          }
        }

        // fallback: no installer_path, use package_path directly
        const pkgPath = resultData.package_path
        if (!pkgPath) {
          return c.json({ success: false as const, error: "No installer_path or package_path in last-result.yml" })
        }
        try {
          await fs.access(pkgPath)
        } catch {
          return c.json({ success: false as const, error: `Package not found: ${pkgPath}` })
        }
        const dir = path.basename(workDir)
        const appRoot = (dir === "Update" || dir === "update") ? path.dirname(workDir) : workDir
        log.info("launching package-based update", { os, pkg: pkgPath, appRoot })
        try {
          const updScript = generateSelfUpdateScript(os, pkgPath, appRoot)
          const updPath = path.join(workDir, "downloads", `self-update-${Date.now()}.${os === "windows" ? "bat" : "sh"}`)
          await fs.writeFile(updPath, updScript, { mode: 0o755 })
          const child = os === "windows"
            ? spawn("cmd", ["/c", updPath], { detached: true, stdio: "ignore", cwd: workDir })
            : spawn("bash", [updPath], { detached: true, stdio: "ignore", cwd: workDir })
          child.unref()
          log.info("self-update script launched", { os, path: updPath, pid: child.pid })
          return c.json({ success: true as const })
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return c.json({ success: false as const, error: `Failed to launch self-update: ${message}` })
        }
      },
    )
    .post(
      "/upgrade",
      describeRoute({
        summary: "Upgrade opencode",
        description: "Upgrade opencode to the specified version or latest if not specified.",
        operationId: "global.upgrade",
        responses: {
          200: {
            description: "Upgrade result",
            content: {
              "application/json": {
                schema: resolver(
                  z.union([
                    z.object({
                      success: z.literal(true),
                      version: z.string(),
                    }),
                    z.object({
                      success: z.literal(false),
                      error: z.string(),
                    }),
                  ]),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          target: z.string().optional(),
        }),
      ),
      async (c) => {
        const method = await Installation.method()
        if (method === "unknown") {
          return c.json({ success: false, error: "Unknown installation method" }, 400)
        }
        const target = c.req.valid("json").target || (await Installation.latest(method))
        const result = await Installation.upgrade(method, target)
          .then(() => ({ success: true as const, version: target }))
          .catch((e) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
        if (result.success) {
          GlobalBus.emit("event", {
            directory: "global",
            payload: {
              type: Installation.Event.Updated.type,
              properties: { version: target },
            },
          })
          return c.json(result)
        }
        return c.json(result, 500)
      },
    ),
)
