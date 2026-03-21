import nodePath from "path"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
}
function getMimeType(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] ?? "application/octet-stream"
}
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { proxy } from "hono/proxy"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { LSP } from "../lsp"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { Command } from "../command"
import { Global } from "../global"
import { WorkspaceContext } from "../control-plane/workspace-context"
import { WorkspaceID } from "../control-plane/schema"
import { ProviderID } from "../provider/schema"
import { WorkspaceRouterMiddleware } from "../control-plane/workspace-router-middleware"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { EventRoutes } from "./routes/event"
import { InstanceBootstrap } from "../project/bootstrap"
import { NotFoundError } from "../storage/db"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"
import { HTTPException } from "hono/http-exception"
import { errors } from "./error"
import { Filesystem } from "@/util/filesystem"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { GlobalRoutes } from "./routes/global"
import { KnowledgeRoutes } from "./routes/knowledge"
import { MDNS } from "./mdns"
import { lazy } from "@/util/lazy"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

async function isWsl(): Promise<boolean> {
  if (process.platform !== "linux") return false
  try {
    const text = await Bun.file("/proc/version").text()
    return text.toLowerCase().includes("microsoft")
  } catch {
    return false
  }
}

async function nativePickerAvailable(): Promise<boolean> {
  if (process.platform === "darwin") return true
  if (process.platform === "win32") return true
  // WSL2: the Windows dialog cannot browse Linux paths; use DialogFileBrowser instead (backend API)
  if (await isWsl()) return false
  if (process.platform === "linux" && process.env.DISPLAY) {
    const r = Bun.spawnSync(["which", "zenity"])
    if (r.exitCode === 0) return true
    const r2 = Bun.spawnSync(["which", "kdialog"])
    if (r2.exitCode === 0) return true
  }
  return false
}

// Build a PowerShell script that shows the modern Vista-style IFileDialog folder picker
// (address bar, navigation panel — same as Windows Explorer) instead of the old tree-view dialog.
function buildModernPickerScript(title: string): string {
  const safeTitle = title.replace(/'/g, "''")
  return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinFolderPicker {
    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr ptr);
    [ComImport, ClassInterface(ClassInterfaceType.None), Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog {}
    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] uint Show(IntPtr hwnd);
        void SetFileTypes(uint c, IntPtr r); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
        void Advise(IntPtr p, out uint c); void Unadvise(uint c);
        void SetOptions(uint fos); void GetOptions(out uint fos);
        void SetDefaultFolder([MarshalAs(UnmanagedType.Interface)] IShellItem psi);
        void SetFolder([MarshalAs(UnmanagedType.Interface)] IShellItem psi);
        void GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string s); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string s);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string s);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string s); void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
        void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void AddPlace([MarshalAs(UnmanagedType.Interface)] IShellItem psi, int f);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string s);
        void Close(int hr); void SetClientGuid(ref Guid g); void ClearClientData(); void SetFilter(IntPtr p);
    }
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare([MarshalAs(UnmanagedType.Interface)] IShellItem psi, uint hint, out int piOrder);
    }
    public static string Pick(string title) {
        try {
            var dlg = (IFileDialog)new FileOpenDialog();
            dlg.SetOptions(0x20u); // FOS_PICKFOLDERS (no FOS_FORCEFILESYSTEM so WSL paths are reachable)
            dlg.SetTitle(title);
            if (dlg.Show(IntPtr.Zero) != 0) return "";
            IShellItem item; dlg.GetResult(out item);
            IntPtr pPath = IntPtr.Zero;
            // SIGDN_FILESYSPATH for drives; fall back to SIGDN_DESKTOPABSOLUTEPARSING for WSL/network paths
            try { item.GetDisplayName(0x80058000u, out pPath); }
            catch { try { item.GetDisplayName(0x80028000u, out pPath); } catch { return ""; } }
            string path = Marshal.PtrToStringUni(pPath);
            if (pPath != IntPtr.Zero) CoTaskMemFree(pPath);
            return path ?? "";
        } catch { return ""; }
    }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[WinFolderPicker]::Pick('${safeTitle}')
`.trim()
}

// Convert a Windows path returned by the dialog to a WSL (Linux) path.
// Handles both drive paths (C:\...) and WSL UNC paths (\\wsl.localhost\Distro\...).
function convertWindowsPathForWsl(winPath: string): string {
  // \\wsl.localhost\Ubuntu\home\zheng\... → /home/zheng/...
  // \\wsl$\Ubuntu\home\zheng\...         → /home/zheng/...
  const wslMatch = winPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(?:\\(.*))?$/i)
  if (wslMatch) {
    const rest = (wslMatch[1] ?? "").replace(/\\/g, "/")
    return rest ? `/${rest}` : "/"
  }
  // C:\Users\zheng\... → /mnt/c/Users/zheng/...
  const driveMatch = winPath.match(/^([A-Za-z]):[\\\/]?(.*)$/)
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase()
    const rest = (driveMatch[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
  }
  return winPath.replace(/\\/g, "/")
}

async function openNativeDirectoryPicker(title: string, multiple: boolean): Promise<string[] | null> {
  // Native Windows (win32): modern IFileDialog, path returned as-is
  if (process.platform === "win32") {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", buildModernPickerScript(title)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    const winPath = (await new Response(proc.stdout).text()).trim()
    return winPath ? [winPath] : null
  }

  if (await isWsl()) {
    // WSL2: modern IFileDialog via PowerShell, convert result to WSL path
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", buildModernPickerScript(title)], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    const winPath = (await new Response(proc.stdout).text()).trim()
    if (!winPath) return null
    return [convertWindowsPathForWsl(winPath)]
  }

  if (process.platform === "darwin") {
    const script = multiple
      ? `POSIX path of (choose folder with prompt "${title}" with multiple selections allowed)`
      : `POSIX path of (choose folder with prompt "${title}")`
    const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    const output = await new Response(proc.stdout).text()
    // multiple returns ": "-separated paths on some macOS versions
    const paths = output
      .trim()
      .split(", ")
      .map((p) => p.trim())
      .filter(Boolean)
    return paths.length > 0 ? paths : null
  }

  if (process.platform === "linux" && process.env.DISPLAY) {
    const hasZenity = Bun.spawnSync(["which", "zenity"]).exitCode === 0
    if (hasZenity) {
      const args = ["zenity", "--file-selection", "--directory", `--title=${title}`]
      if (multiple) args.push("--multiple", "--separator=\n")
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
      await proc.exited
      const output = await new Response(proc.stdout).text()
      const paths = output.trim().split("\n").filter(Boolean)
      return paths.length > 0 ? paths : null
    }
    const hasKdialog = Bun.spawnSync(["which", "kdialog"]).exitCode === 0
    if (hasKdialog) {
      const proc = Bun.spawn(["kdialog", "--getexistingdirectory", "--title", title], {
        stdout: "pipe",
        stderr: "pipe",
      })
      await proc.exited
      const output = await new Response(proc.stdout).text()
      const p = output.trim()
      return p ? [p] : null
    }
  }

  return null
}

export namespace Server {
  const log = Log.create({ service: "server" })

  export const Default = lazy(() => createApp({}))

  export const createApp = (opts: { cors?: string[]; onBrowserConnectionChange?: (count: number) => void }): Hono => {
    const app = new Hono()
    let sseConnectionCount = 0
    return app
      .onError((err, c) => {
        log.error("failed", {
          error: err,
        })
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode
          if (err instanceof NotFoundError) status = 404
          else if (err instanceof Provider.ModelNotFoundError) status = 400
          else if (err.name === "ProviderAuthValidationFailed") status = 400
          else if (err.name.startsWith("Worktree")) status = 400
          else status = 500
          return c.json(err.toObject(), { status })
        }
        if (err instanceof HTTPException) return err.getResponse()
        const message = err instanceof Error && err.stack ? err.stack : err.toString()
        return c.json(new NamedError.Unknown({ message }).toObject(), {
          status: 500,
        })
      })
      .use((c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return next()
        const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skipLogging = c.req.path === "/log"
        if (!skipLogging) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skipLogging) {
          timer.stop()
        }
      })
      .use(
        cors({
          origin(input) {
            if (!input) return

            if (input.startsWith("http://localhost:")) return input
            if (input.startsWith("http://127.0.0.1:")) return input
            if (
              input === "tauri://localhost" ||
              input === "http://tauri.localhost" ||
              input === "https://tauri.localhost"
            )
              return input

            // *.opencode.ai (https only, adjust if needed)
            if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
              return input
            }
            if (opts?.cors?.includes(input)) {
              return input
            }

            return
          },
        }),
      )
      .route("/global", GlobalRoutes())
      .put(
        "/auth/:providerID",
        describeRoute({
          summary: "Set auth credentials",
          description: "Set authentication credentials",
          operationId: "auth.set",
          responses: {
            200: {
              description: "Successfully set authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        validator("json", Auth.Info.zod),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const info = c.req.valid("json")
          await Auth.set(providerID, info)
          return c.json(true)
        },
      )
      .delete(
        "/auth/:providerID",
        describeRoute({
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
          operationId: "auth.remove",
          responses: {
            200: {
              description: "Successfully removed authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          await Auth.remove(providerID)
          return c.json(true)
        },
      )
      .use(async (c, next) => {
        if (c.req.path === "/log") return next()
        const rawWorkspaceID = c.req.query("workspace") || c.req.header("x-opencode-workspace")
        const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
        const directory = Filesystem.resolve(
          (() => {
            try {
              return decodeURIComponent(raw)
            } catch {
              return raw
            }
          })(),
        )

        return WorkspaceContext.provide({
          workspaceID: rawWorkspaceID ? WorkspaceID.make(rawWorkspaceID) : undefined,
          async fn() {
            return Instance.provide({
              directory,
              init: InstanceBootstrap,
              async fn() {
                return next()
              },
            })
          },
        })
      })
      .use(WorkspaceRouterMiddleware)
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "opencode",
              version: "0.0.3",
              description: "opencode api",
            },
            openapi: "3.1.1",
          },
        }),
      )
      .use(
        validator(
          "query",
          z.object({
            directory: z.string().optional(),
            workspace: z.string().optional(),
          }),
        ),
      )
      .route("/project", ProjectRoutes())
      .route("/pty", PtyRoutes())
      .route("/config", ConfigRoutes())
      .route("/experimental", ExperimentalRoutes())
      .route("/session", SessionRoutes())
      .route("/permission", PermissionRoutes())
      .route("/question", QuestionRoutes())
      .route("/provider", ProviderRoutes())
      .route("/", FileRoutes())
      .route("/", EventRoutes())
      .route("/mcp", McpRoutes())
      .route("/tui", TuiRoutes())
      .route("/knowledge", KnowledgeRoutes())
      .post(
        "/instance/dispose",
        describeRoute({
          summary: "Dispose instance",
          description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          operationId: "instance.dispose",
          responses: {
            200: {
              description: "Instance disposed",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
          },
        }),
        async (c) => {
          await Instance.dispose()
          return c.json(true)
        },
      )
      .get(
        "/path",
        describeRoute({
          summary: "Get paths",
          description: "Retrieve the current working directory and related path information for the OpenCode instance.",
          operationId: "path.get",
          responses: {
            200: {
              description: "Path",
              content: {
                "application/json": {
                  schema: resolver(
                    z
                      .object({
                        home: z.string(),
                        state: z.string(),
                        config: z.string(),
                        worktree: z.string(),
                        directory: z.string(),
                      })
                      .meta({
                        ref: "Path",
                      }),
                  ),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json({
            home: Global.Path.home,
            state: Global.Path.state,
            config: Global.Path.config,
            worktree: Instance.worktree,
            directory: Instance.directory,
          })
        },
      )
      .get(
        "/path/picker/check",
        describeRoute({
          summary: "Check native picker",
          description: "Check whether a native OS directory picker dialog is available on this server.",
          operationId: "path.picker.check",
          responses: {
            200: {
              description: "Availability",
              content: {
                "application/json": {
                  schema: resolver(z.object({ available: z.boolean() })),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json({ available: await nativePickerAvailable() })
        },
      )
      .get(
        "/path/picker",
        describeRoute({
          summary: "Open native directory picker",
          description: "Open a native OS directory picker dialog and return the selected path(s).",
          operationId: "path.picker.open",
          responses: {
            200: {
              description: "Selected paths",
              content: {
                "application/json": {
                  schema: resolver(z.object({ paths: z.array(z.string()).nullable() })),
                },
              },
            },
          },
        }),
        async (c) => {
          const title = c.req.query("title") || "Select folder"
          const multiple = c.req.query("multiple") === "true"
          const paths = await openNativeDirectoryPicker(title, multiple)
          return c.json({ paths })
        },
      )
      .get(
        "/vcs",
        describeRoute({
          summary: "Get VCS info",
          description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
          operationId: "vcs.get",
          responses: {
            200: {
              description: "VCS info",
              content: {
                "application/json": {
                  schema: resolver(Vcs.Info),
                },
              },
            },
          },
        }),
        async (c) => {
          const branch = await Vcs.branch()
          return c.json({
            branch,
          })
        },
      )
      .get(
        "/command",
        describeRoute({
          summary: "List commands",
          description: "Get a list of all available commands in the OpenCode system.",
          operationId: "command.list",
          responses: {
            200: {
              description: "List of commands",
              content: {
                "application/json": {
                  schema: resolver(Command.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const commands = await Command.list()
          return c.json(commands)
        },
      )
      .post(
        "/log",
        describeRoute({
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
          operationId: "app.log",
          responses: {
            200: {
              description: "Log entry written successfully",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            service: z.string().meta({ description: "Service name for the log entry" }),
            level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
            message: z.string().meta({ description: "Log message" }),
            extra: z
              .record(z.string(), z.any())
              .optional()
              .meta({ description: "Additional metadata for the log entry" }),
          }),
        ),
        async (c) => {
          const { service, level, message, extra } = c.req.valid("json")
          const logger = Log.create({ service })

          switch (level) {
            case "debug":
              logger.debug(message, extra)
              break
            case "info":
              logger.info(message, extra)
              break
            case "error":
              logger.error(message, extra)
              break
            case "warn":
              logger.warn(message, extra)
              break
          }

          return c.json(true)
        },
      )
      .get(
        "/agent",
        describeRoute({
          summary: "List agents",
          description: "Get a list of all available AI agents in the OpenCode system.",
          operationId: "app.agents",
          responses: {
            200: {
              description: "List of agents",
              content: {
                "application/json": {
                  schema: resolver(Agent.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const modes = await Agent.list()
          return c.json(modes)
        },
      )
      .get(
        "/skill",
        describeRoute({
          summary: "List skills",
          description: "Get a list of all available skills in the OpenCode system.",
          operationId: "app.skills",
          responses: {
            200: {
              description: "List of skills",
              content: {
                "application/json": {
                  schema: resolver(Skill.Info.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          const skills = await Skill.all()
          return c.json(skills)
        },
      )
      .get(
        "/lsp",
        describeRoute({
          summary: "Get LSP status",
          description: "Get LSP server status",
          operationId: "lsp.status",
          responses: {
            200: {
              description: "LSP server status",
              content: {
                "application/json": {
                  schema: resolver(LSP.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await LSP.status())
        },
      )
      .get(
        "/formatter",
        describeRoute({
          summary: "Get formatter status",
          description: "Get formatter status",
          operationId: "formatter.status",
          responses: {
            200: {
              description: "Formatter status",
              content: {
                "application/json": {
                  schema: resolver(Format.Status.array()),
                },
              },
            },
          },
        }),
        async (c) => {
          return c.json(await Format.status())
        },
      )
      .get(
        "/event",
        describeRoute({
          summary: "Subscribe to events",
          description: "Get events",
          operationId: "event.subscribe",
          responses: {
            200: {
              description: "Event stream",
              content: {
                "text/event-stream": {
                  schema: resolver(BusEvent.payloads()),
                },
              },
            },
          },
        }),
        async (c) => {
          log.info("event connected")
          c.header("X-Accel-Buffering", "no")
          c.header("X-Content-Type-Options", "nosniff")
          sseConnectionCount++
          opts.onBrowserConnectionChange?.(sseConnectionCount)
          return streamSSE(c, async (stream) => {
            stream.writeSSE({
              data: JSON.stringify({
                type: "server.connected",
                properties: {},
              }),
            })
            const unsub = Bus.subscribeAll(async (event) => {
              await stream.writeSSE({
                data: JSON.stringify(event),
              })
              if (event.type === Bus.InstanceDisposed.type) {
                stream.close()
              }
            })

            // Track disconnection via either onAbort (immediate) or heartbeat
            // write failure (Bun only detects TCP close on next write attempt).
            let disconnected = false
            const onDisconnect = () => {
              if (disconnected) return
              disconnected = true
              sseConnectionCount--
              opts.onBrowserConnectionChange?.(sseConnectionCount)
            }

            // Heartbeat every 3s: keeps proxy streams alive and detects browser close.
            const heartbeat = setInterval(() => {
              stream
                .writeSSE({
                  data: JSON.stringify({
                    type: "server.heartbeat",
                    properties: {},
                  }),
                })
                .catch(() => {
                  clearInterval(heartbeat)
                  unsub()
                  onDisconnect()
                })
            }, 3_000)

            await new Promise<void>((resolve) => {
              stream.onAbort(() => {
                clearInterval(heartbeat)
                unsub()
                resolve()
                onDisconnect()
                log.info("event disconnected")
              })
            })
          })
        },
      )
      .all("/*", async (c) => {
        const reqPath = c.req.path

        // Serve local web assets if available (next to the binary)
        const webDir = nodePath.join(nodePath.dirname(process.execPath), "web")
        const localFilePath = nodePath.join(webDir, reqPath === "/" ? "index.html" : reqPath)
        const localFile = Bun.file(localFilePath)
        if (await localFile.exists()) {
          return new Response(localFile, { headers: { "content-type": getMimeType(localFilePath) } })
        }
        // SPA fallback: serve index.html for unknown paths
        const indexFile = Bun.file(nodePath.join(webDir, "index.html"))
        if (await indexFile.exists()) {
          return new Response(indexFile, { headers: { "content-type": "text/html" } })
        }

        // Fall back to remote proxy
        const response = await proxy(`https://app.opencode.ai${reqPath}`, {
          ...c.req,
          headers: {
            ...c.req.raw.headers,
            host: "app.opencode.ai",
          },
        })
        response.headers.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:",
        )
        return response
      })
  }

  export async function openapi() {
    // Cast to break excessive type recursion from long route chains
    const result = await generateSpecs(Default(), {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  /** @deprecated do not use this dumb shit */
  export let url: URL

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
    onBrowserConnectionChange?: (count: number) => void
  }) {
    url = new URL(`http://${opts.hostname}:${opts.port}`)
    const app = createApp(opts)
    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: app.fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
