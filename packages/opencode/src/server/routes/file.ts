import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { File } from "../../file"
import { FolderSummary } from "../../file/summary"
import { Ripgrep } from "../../file/ripgrep"
import { LSP } from "../../lsp"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { $ } from "bun"
import { spawn } from "bun"
import path from "path"
import type { Stats } from "fs"
import { parsePDF } from "../../knowledge/document"
import {
  startConversion,
  getTask,
  cancelTask,
  getQueuePosition,
  getQueueLength,
  listActiveTasks,
} from "../../pdf-converter"
import { generateTaskID, computeOutputPaths } from "../../pdf-converter/util"
import { checkPythonAvailable } from "../../pdf-converter/pdf-renderer"
import {
  startTranslation,
  getTranslateTask,
  cancelTranslateTask,
  generateTranslateTaskID,
  listActiveTranslateTasks,
} from "../../markdown-translator"
import { detectDataJson, chunkByContent, chunksFromDataJson } from "../../markdown-translator/chunker"
import fs from "fs/promises"

const encode = (input: string) =>
  encodeURIComponent(input).replace(/['()*]/g, (part) => `%${part.charCodeAt(0).toString(16).toUpperCase()}`)

const ascii = (input: string) => {
  const out = input
    .replaceAll(/["\\;\r\n]/g, "_")
    .split("")
    .map((part) => (/[\x20-\x7E]/.test(part) ? part : "_"))
    .join("")
    .trim()

  return out || "download"
}

const attachment = (name: string) => `attachment; filename="${ascii(name)}"; filename*=UTF-8''${encode(name)}`

const resolvePath = (input: string) => (path.isAbsolute(input) ? input : path.join(Instance.directory, input))

const requireDirectory = async (input: string) => {
  try {
    const dir = resolvePath(input)
    const stat = await fs.stat(dir)
    if (!stat.isDirectory()) throw new Error("路径必须指向一个文件夹")
    return dir
  } catch {
    throw new Error("路径必须指向一个文件夹")
  }
}

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/file/active-tasks",
      describeRoute({
        summary: "List active conversion/translation tasks",
        description:
          "Returns all currently running PDF conversion and markdown translation tasks, allowing the frontend to restore progress bars after page reload.",
        operationId: "file.activeTasks",
        responses: {
          200: {
            description: "Active tasks",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      taskID: z.string(),
                      status: z.string(),
                      path: z.string(),
                      taskType: z.enum(["convert", "translate"]),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const convertTasks = listActiveTasks()
        const translateTasks = listActiveTranslateTasks()
        return c.json([...convertTasks, ...translateTasks])
      },
    )
    .get(
      "/file/check-directory",
      describeRoute({
        summary: "Check directory",
        description: "Check whether a path exists and points to a directory.",
        operationId: "file.checkDirectory",
        responses: {
          200: {
            description: "Directory check result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    path: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        try {
          const dir = await requireDirectory(c.req.valid("query").path)
          return c.json({ path: dir })
        } catch (e: any) {
          return c.json({ error: e?.message || "路径必须指向一个文件夹" }, 400)
        }
      },
    )
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) => {
        const pattern = c.req.valid("query").pattern
        const result = await Ripgrep.search({
          cwd: Instance.directory,
          pattern,
          limit: 10,
        })
        return c.json(result)
      },
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query").query
        const dirs = c.req.valid("query").dirs
        const type = c.req.valid("query").type
        const limit = c.req.valid("query").limit

        // On Windows, return drive roots when browsing from "/"
        if (process.platform === "win32" && type === "directory") {
          const rawDir = (() => {
            const v = c.req.query("directory") || ""
            try { return decodeURIComponent(v) } catch { return v }
          })()
          if (rawDir === "/") {
            const { existsSync } = await import("fs")
            const drives: string[] = []
            for (let code = 65; code <= 90; code++) {
              const letter = String.fromCharCode(code)
              if (existsSync(`${letter}:\\`)) {
                drives.push(`${letter}:/`)
              }
            }
            return c.json(drives)
          }
        }

        const results = await File.search({
          query,
          limit: limit ?? 10,
          dirs: dirs !== "false",
          type,
        })
        return c.json(results)
      },
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        /*
      const query = c.req.valid("query").query
      const result = await LSP.workspaceSymbol(query)
      return c.json(result)
      */
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const rawDir = (() => {
          const v = c.req.query("directory") || ""
          try { return decodeURIComponent(v) } catch { return v }
        })()

        // On Windows, return drive roots when browsing from "/"
        if (process.platform === "win32" && !path && rawDir === "/") {
          const { existsSync } = await import("fs")
          const drives: Array<{ name: string; path: string; absolute: string; type: "directory"; ignored: boolean }> = []
          for (let code = 65; code <= 90; code++) {
            const letter = String.fromCharCode(code)
            const drivePath = `${letter}:\\`
            if (existsSync(drivePath)) {
              drives.push({ name: `${letter}:`, path: `${letter}:/`, absolute: `${letter}:/`, type: "directory", ignored: false })
            }
          }
          return c.json(drives)
        }

        const content = await File.list(path)
        return c.json(content)
      },
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path
        const content = await File.read(path)
        return c.json(content)
      },
    )
    .get(
      "/file/download",
      describeRoute({
        summary: "Download file or directory",
        description: "Download a file directly or a directory as a zip archive.",
        operationId: "file.download",
        responses: {
          200: {
            description: "File payload",
          },
          ...errors(400),
          ...errors(404),
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const path = c.req.valid("query").path

        try {
          const out = await File.download(path)
          return new Response(out.body, {
            headers: {
              "Content-Type": out.type,
              "Content-Disposition": attachment(out.name),
            },
          })
        } catch (err) {
          if (err instanceof Error && /ENOENT/.test(err.message)) {
            return c.json({ error: "File not found" }, 404)
          }
          throw err
        }
      },
    )
    .put(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write content to a specified file within the project.",
        operationId: "file.write",
        responses: {
          200: {
            description: "Written",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          409: {
            description: "Write conflict",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    error: z.literal("conflict"),
                    currentChecksum: z.string(),
                    currentContent: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ path: z.string(), content: z.string(), expectedChecksum: z.string().optional() })),
      async (c) => {
        const { path, content, expectedChecksum } = c.req.valid("json")
        const result = await File.write(path, content, { expectedChecksum })
        if (result) {
          return c.json(
            {
              error: "conflict",
              currentChecksum: result.currentChecksum,
              currentContent: result.currentContent,
            },
            409,
          )
        }
        return c.json({ ok: true })
      },
    )
    .post(
      "/file/upload",
      describeRoute({
        summary: "Upload files or directories",
        description: "Upload one or more files or directories into the current project.",
        operationId: "file.upload",
        responses: {
          200: {
            description: "Uploaded",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.boolean(),
                    dirs: z.number().int(),
                    created: z.number().int(),
                    updated: z.number().int(),
                    failed: z.array(
                      z.object({
                        path: z.string(),
                        error: z.string(),
                      }),
                    ),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const form = await c.req.formData()
        const root = form.get("target")
        const dirs = form.get("dirs")
        const paths = form.get("paths")
        const files = form.getAll("files")

        const next = typeof root === "string" ? root : ""
        const parse = (input: FormDataEntryValue | null) => {
          if (typeof input !== "string") return []
          try {
            return JSON.parse(input)
          } catch {
            return undefined
          }
        }
        const dir = parse(dirs)
        const list = parse(paths)

        if (!Array.isArray(dir) || !dir.every((item) => typeof item === "string")) {
          return c.json({ error: "Invalid upload directories" }, 400)
        }
        if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
          return c.json({ error: "Invalid upload paths" }, 400)
        }

        const body = files.filter((item): item is globalThis.File => item instanceof globalThis.File)
        if (body.length !== list.length) {
          return c.json({ error: "Upload payload is malformed" }, 400)
        }

        const result = await File.upload({
          root: next,
          dirs: dir,
          files: body.map((file, idx) => ({
            path: list[idx]!,
            file,
          })),
        })

        return c.json(result)
      },
    )
    .post(
      "/file",
      describeRoute({
        summary: "Create file or directory",
        description: "Create a new file or directory at the specified path within the project.",
        operationId: "file.create",
        responses: {
          200: {
            description: "Created",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ path: z.string(), type: z.enum(["file", "directory"]) })),
      async (c) => {
        const { path, type } = c.req.valid("json")
        await File.create(path, type)
        return c.json({ ok: true })
      },
    )
    .delete(
      "/file",
      describeRoute({
        summary: "Delete file or directory",
        description: "Delete a file or directory at the specified path within the project.",
        operationId: "file.delete",
        responses: {
          200: {
            description: "Deleted",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400),
        },
      }),
      validator("query", z.object({ path: z.string() })),
      async (c) => {
        const { path } = c.req.valid("query")
        await File.remove(path)
        return c.json({ ok: true })
      },
    )
    .patch(
      "/file",
      describeRoute({
        summary: "Rename file or directory",
        description: "Rename a file or directory within the project.",
        operationId: "file.rename",
        responses: {
          200: {
            description: "Renamed",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean(), path: z.string() })) } },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ path: z.string(), name: z.string() })),
      async (c) => {
        const { path, name } = c.req.valid("json")
        const newPath = await File.rename(path, name)
        return c.json({ ok: true, path: newPath })
      },
    )
    .post(
      "/file/summarize",
      describeRoute({
        summary: "Generate directory summaries",
        description: "Generate .summary files for all directories in the project using LLM.",
        operationId: "file.summarize",
        responses: {
          200: {
            description: "Generated",
            content: { "application/json": { schema: resolver(z.object({ count: z.number() })) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          directory: z.string().optional(),
          maxDepth: z.number().int().min(1).max(5).optional(),
          force: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const { directory, maxDepth, force } = c.req.valid("json")
        const root = directory ?? Instance.directory
        const generated = await FolderSummary.generateAll(root, maxDepth ?? 3, force ?? false)
        return c.json({ count: generated.length })
      },
    )
    .post(
      "/file/open-in-explorer",
      describeRoute({
        summary: "Open in explorer",
        description: "Open a file or directory in the system file explorer (server-side implementation).",
        operationId: "file.openInExplorer",
        responses: {
          200: {
            description: "Opened",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400),
          ...errors(403),
          ...errors(404),
        },
      }),
      validator("json", z.object({ path: z.string() })),
      async (c) => {
        const inputPath = c.req.valid("json").path
        let stat: Stats | undefined
        try {
          stat = await Bun.file(inputPath).stat()
        } catch {
          return c.json({ error: "Failed to access path" }, 500)
        }

        try {
          if (process.platform === "win32") {
            // Windows: use explorer
            const isDir = stat.isDirectory()
            if (isDir) {
              const proc = spawn(["explorer.exe", `${inputPath}`])
              await proc.exited
            } else {
              const proc = spawn(["explorer.exe", "/select,", `${inputPath}`])
              await proc.exited
            }
          } else if (process.platform === "darwin") {
            // macOS: open -R / open // todo
            const stat = await Bun.file(inputPath).stat()
            const isDir = stat.isDirectory()
            if (isDir) {
              await $`open ${inputPath}`.nothrow()
            } else {
              await $`open -R ${inputPath}`.nothrow()
            }
          } else {
            // Linux: xdg-open // todo
            const dir = path.dirname(inputPath)
            await $`xdg-open ${dir}`.nothrow()
          }

          return c.json({ ok: true })
        } catch (error) {
          console.error("Failed to open in explorer:", error)
          return c.json(
            {
              error: "Failed to open in explorer",
              details: error instanceof Error ? error.message : String(error),
            },
            500,
          )
        }
      },
    )
    .post(
      "/file/open",
      describeRoute({
        summary: "Open file",
        description: "Open a file or directory with the system default application.",
        operationId: "file.open",
        responses: {
          200: {
            description: "Opened",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
          ...errors(400),
          ...errors(403),
          ...errors(404),
        },
      }),
      validator("json", z.object({ path: z.string(), app: z.string().optional() })),
      async (c) => {
        const { path: inputPath, app } = c.req.valid("json")
        let stat: Stats | undefined
        try {
          stat = await Bun.file(inputPath).stat()
        } catch {
          return c.json({ error: "Failed to access path" }, 500)
        }

        try {
          if (app) {
            if (process.platform === "darwin") {
              const proc = spawn(["open", "-a", app, inputPath])
              await proc.exited
            } else {
              const proc = spawn([app, inputPath])
              await proc.exited
            }
            return c.json({ ok: true })
          }

          if (process.platform === "win32") {
            // Windows: start "" filepath
            const proc = spawn(["cmd.exe", "/c", "start", "", inputPath])
            await proc.exited
          } else if (process.platform === "darwin") {
            // macOS: open filepath
            const proc = spawn(["open", inputPath])
            await proc.exited
          } else {
            // Linux: xdg-open filepath
            const proc = spawn(["xdg-open", inputPath])
            await proc.exited
          }

          return c.json({ ok: true })
        } catch (error) {
          console.error("Failed to open file:", error)
          return c.json(
            {
              error: "Failed to open file",
              details: error instanceof Error ? error.message : String(error),
            },
            500,
          )
        }
      },
    )
    .post(
      "/file/pick-folder",
      describeRoute({
        summary: "Pick folder",
        description: "Open the native OS folder picker dialog and return the selected directory path.",
        operationId: "file.pickFolder",
        responses: {
          200: {
            description: "Selected folder path or null if cancelled",
            content: { "application/json": { schema: resolver(z.object({ path: z.string().nullable() })) } },
          },
        },
      }),
      async (c) => {
        try {
          let selected: string | null = null
          if (process.platform === "win32") {
            const ps = spawn([
              "powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; $owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; $owner.WindowState = 'Minimized'; $owner.ShowInTaskbar = $false; $owner.Show(); $owner.Hide(); if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }; $owner.Dispose()",
            ])
            const output = await new Response(ps.stdout).text()
            await ps.exited
            const trimmed = output.trim()
            if (trimmed) selected = trimmed
          } else if (process.platform === "darwin") {
            const proc = spawn(["osascript", "-e", "POSIX path of (choose folder)"])
            const output = await new Response(proc.stdout).text()
            await proc.exited
            const trimmed = output.trim()
            if (trimmed) selected = trimmed.replace(/\/$/, "")
          } else {
            try {
              const proc = spawn(["zenity", "--file-selection", "--directory", "--title=Select Folder"])
              const output = await new Response(proc.stdout).text()
              await proc.exited
              const trimmed = output.trim()
              if (trimmed) selected = trimmed
            } catch {
              try {
                const proc = spawn(["kdialog", "--getexistingdirectory", process.env.HOME || "/"])
                const output = await new Response(proc.stdout).text()
                await proc.exited
                const trimmed = output.trim()
                if (trimmed) selected = trimmed
              } catch {
                // No native dialog available
              }
            }
          }
          return c.json({ path: selected })
        } catch (error) {
          console.error("Failed to open folder picker:", error)
          return c.json({ path: null })
        }
      },
    )
    .post(
      "/file/gitignore",
      describeRoute({
        summary: "Add to .gitignore",
        description: "Add a file or directory path to the project's .gitignore file, creating it if necessary.",
        operationId: "file.addToGitignore",
        responses: {
          200: {
            description: "Result",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), created: z.boolean(), alreadyExists: z.boolean() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ path: z.string(), type: z.enum(["file", "directory"]) })),
      async (c) => {
        const { path: filePath, type } = c.req.valid("json")
        const result = await File.addToGitignore(filePath, type)
        return c.json({ ok: true, ...result })
      },
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const content = await File.status()
        return c.json(content)
      },
    )
    // ====== PDF → Markdown 转换路由 ======
    .get(
      "/file/pdf-page-count",
      describeRoute({
        summary: "Get PDF page count",
        description: "Get total page count and expected output paths for a PDF file.",
        operationId: "file.pdfPageCount",
        responses: {
          200: {
            description: "Page count and output paths",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    pageCount: z.number(),
                    outputPath: z.object({
                      merged: z.string(),
                      perPage: z.string(),
                      images: z.string(),
                    }),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          outputDir: z.string().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const absPath = resolvePath(query.path)
        try {
          const outputDir = query.outputDir ? await requireDirectory(query.outputDir) : undefined
          const parsed = await parsePDF(absPath)
          const outputPaths = computeOutputPaths(absPath, "merged", outputDir)

          // 检查已存在的输出文件
          const existingFiles: string[] = []
          if (await Bun.file(outputPaths.merged).exists()) existingFiles.push(outputPaths.merged)
          const perPageDir = outputPaths.perPage
          try {
            const stat = await Bun.file(perPageDir).stat()
            if (stat.isDirectory()) existingFiles.push(perPageDir)
          } catch {
            /* not exists */
          }

          return c.json({
            pageCount: parsed.pageCount,
            outputPath: {
              merged: outputPaths.merged,
              perPage: outputPaths.perPage,
              images: outputPaths.images,
            },
            existingFiles,
          })
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 400)
        }
      },
    )
    .get(
      "/file/pdf-python-check",
      describeRoute({
        summary: "Check Python availability",
        description: "Check if Python + PyMuPDF + Pillow are available for PDF rendering.",
        operationId: "file.pdfPythonCheck",
        responses: {
          200: {
            description: "Python status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    available: z.boolean(),
                    pythonPath: z.string().nullable(),
                    missingDeps: z.string().array(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const result = await checkPythonAvailable()
        return c.json(result)
      },
    )
    .post(
      "/file/pdf-to-markdown",
      describeRoute({
        summary: "Start PDF to Markdown conversion",
        description: "Start an async PDF to Markdown conversion task.",
        operationId: "file.pdfToMarkdown",
        responses: {
          200: {
            description: "Task started",
            content: {
              "application/json": {
                schema: resolver(z.object({ taskID: z.string() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          providerID: z.string(),
          modelID: z.string(),
          startPage: z.number().int().min(1),
          endPage: z.number().int().min(1),
          outputMode: z.enum(["merged", "per-page"]),
          conflictAction: z.enum(["replace", "rename", "cancel"]),
          outputDir: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")

        // 校验页面范围
        if (body.endPage < body.startPage) {
          return c.json({ error: "结束页码不能小于起始页码" }, 400)
        }
        if (body.endPage - body.startPage + 1 > 50) {
          return c.json({ error: "页面范围不能超过 50 页" }, 400)
        }

        const absPath = resolvePath(body.path)
        const outputDir = body.outputDir ? await requireDirectory(body.outputDir).catch(() => undefined) : undefined
        if (body.outputDir && !outputDir) {
          return c.json({ error: "路径必须指向一个文件夹" }, 400)
        }

        const taskID = generateTaskID()
        startConversion(taskID, {
          ...body,
          path: absPath,
          outputDir,
        })

        return c.json({ taskID })
      },
    )
    .get(
      "/file/pdf-to-markdown/progress",
      describeRoute({
        summary: "Get conversion progress",
        description: "SSE endpoint for real-time PDF conversion progress.",
        operationId: "file.pdfToMarkdownProgress",
        responses: {
          200: {
            description: "Progress event stream",
            content: {
              "text/event-stream": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          taskID: z.string(),
        }),
      ),
      async (c) => {
        const { taskID } = c.req.valid("query")
        const task = getTask(taskID)
        if (!task) {
          return c.json({ error: "任务不存在" }, 404)
        }

        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamSSE(c, async (stream) => {
          // 先注册监听器，再重放历史事件，避免竞态：
          // 如果先重放再注册，重放结束到注册之间产生的事件会丢失
          const pendingEvents: any[] = []
          let replayDone = false
          let cleanedUp = false

          const removeListener = () => {
            task.listeners.delete(listener)
          }
          const doCleanup = (hb?: ReturnType<typeof setInterval>) => {
            if (cleanedUp) return
            cleanedUp = true
            removeListener()
            if (hb) clearInterval(hb)
          }

          const listener = async (event: any) => {
            if (!replayDone) {
              // 重放阶段：新事件暂存，避免乱序
              pendingEvents.push(event)
              return
            }
            try {
              await stream.writeSSE({ data: JSON.stringify(event) })
            } catch {
              /* stream broken */
            }
          }

          task.listeners.add(listener)

          // 重放已有的事件
          const replayedCount = task.events.length
          for (let i = 0; i < replayedCount; i++) {
            await stream.writeSSE({ data: JSON.stringify(task.events[i]) })
          }

          // 重放期间可能有新事件通过 listener 暂存，现在发送它们
          replayDone = true
          for (const event of pendingEvents) {
            try {
              await stream.writeSSE({ data: JSON.stringify(event) })
            } catch {
              /* stream broken */
            }
          }

          // 如果任务已完成（重放+暂存事件中已包含终态），直接关闭
          if (task.status !== "running") {
            removeListener()
            return
          }

          // 心跳保活
          const heartbeat = setInterval(() => {
            stream
              .writeSSE({
                data: JSON.stringify({ type: "heartbeat" }),
              })
              .catch(() => doCleanup(heartbeat))
          }, 5_000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              doCleanup(heartbeat)
              resolve()
            })

            // 任务完成时也关闭
            const checkDone = setInterval(() => {
              if (task.status !== "running") {
                clearInterval(checkDone)
                doCleanup(heartbeat)
                resolve()
              }
            }, 1000)
          })
        })
      },
    )
    .post(
      "/file/pdf-to-markdown/cancel",
      describeRoute({
        summary: "Cancel PDF conversion",
        description: "Cancel a running PDF to Markdown conversion task.",
        operationId: "file.pdfToMarkdownCancel",
        responses: {
          200: {
            description: "Cancelled",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ taskID: z.string() })),
      async (c) => {
        const { taskID } = c.req.valid("json")
        const ok = cancelTask(taskID)
        return c.json({ ok })
      },
    )
    // ====== 原始文件内容（用于 <img src> 等二进制文件） ======
    .get(
      "/file/raw",
      describeRoute({
        summary: "Serve raw file",
        description: "Serve a file's raw binary content with appropriate Content-Type.",
        operationId: "file.raw",
        responses: {
          200: { description: "File content" },
          ...errors(400, 404),
        },
      }),
      validator("query", z.object({ path: z.string() })),
      async (c) => {
        const filePath = c.req.valid("query").path
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(Instance.directory, filePath)
        const file = Bun.file(absPath)
        if (!(await file.exists())) {
          return c.json({ error: "File not found" }, 404)
        }
        const ext = absPath.split(".").pop()?.toLowerCase() ?? ""
        const mimeMap: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          svg: "image/svg+xml",
          webp: "image/webp",
          pdf: "application/pdf",
        }
        const contentType = mimeMap[ext] || "application/octet-stream"
        return new Response(file, {
          headers: { "Content-Type": contentType, "Cache-Control": "max-age=3600" },
        })
      },
    )
    // ====== Markdown 翻译路由 ======
    .get(
      "/file/translate-markdown/check",
      describeRoute({
        summary: "Check markdown for translation",
        description:
          "Pre-check a markdown file before translation: detect _data.json, estimate chunks, check conflicts.",
        operationId: "file.translateMarkdownCheck",
        responses: {
          200: {
            description: "Pre-check result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    hasDataJson: z.boolean(),
                    chunkCount: z.number(),
                    outputPath: z.string(),
                    existingFiles: z.string().array(),
                    fileSize: z.number(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
          outputDir: z.string().optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const absPath = resolvePath(query.path)
        try {
          const outputDir = query.outputDir ? await requireDirectory(query.outputDir) : undefined
          const stat = await Bun.file(absPath).stat()
          const fileSize = stat.size

          const dataJsonPath = await detectDataJson(absPath)
          let chunkCount: number
          if (dataJsonPath) {
            const raw = await fs.readFile(dataJsonPath, "utf-8")
            const data = JSON.parse(raw)
            chunkCount = data.pages?.length ?? 0
          } else {
            const content = await fs.readFile(absPath, "utf-8")
            chunkCount = chunkByContent(content).length
          }

          const ext = absPath.match(/\.[^.]+$/)?.[0] ?? ""
          const dir = outputDir ?? path.dirname(absPath)
          const base = path.join(dir, path.basename(absPath, ext))
          const outputPath = `${base}_zh${ext}`

          const existingFiles: string[] = []
          if (await Bun.file(outputPath).exists()) existingFiles.push(outputPath)

          return c.json({
            hasDataJson: !!dataJsonPath,
            chunkCount,
            outputPath,
            existingFiles,
            fileSize,
          })
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 400)
        }
      },
    )
    .post(
      "/file/translate-markdown",
      describeRoute({
        summary: "Start markdown translation",
        description: "Start an async markdown translation task.",
        operationId: "file.translateMarkdown",
        responses: {
          200: {
            description: "Task started",
            content: {
              "application/json": {
                schema: resolver(z.object({ taskID: z.string() })),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string(),
          providerID: z.string(),
          modelID: z.string(),
          targetLanguage: z.string().optional().default("zh-CN"),
          conflictAction: z.enum(["replace", "rename", "cancel"]),
          outputDir: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const absPath = resolvePath(body.path)
        const outputDir = body.outputDir ? await requireDirectory(body.outputDir).catch(() => undefined) : undefined
        if (body.outputDir && !outputDir) {
          return c.json({ error: "路径必须指向一个文件夹" }, 400)
        }

        const taskID = generateTranslateTaskID()
        startTranslation(taskID, {
          ...body,
          path: absPath,
          outputDir,
        })

        return c.json({ taskID })
      },
    )
    .get(
      "/file/translate-markdown/progress",
      describeRoute({
        summary: "Get translation progress",
        description: "SSE endpoint for real-time markdown translation progress.",
        operationId: "file.translateMarkdownProgress",
        responses: {
          200: {
            description: "Progress event stream",
            content: {
              "text/event-stream": {
                schema: resolver(z.any()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          taskID: z.string(),
        }),
      ),
      async (c) => {
        const { taskID } = c.req.valid("query")
        const task = getTranslateTask(taskID)
        if (!task) {
          return c.json({ error: "任务不存在" }, 404)
        }

        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")

        return streamSSE(c, async (stream) => {
          // 先注册监听器，再重放历史事件，避免竞态
          const pendingEvents: any[] = []
          let replayDone = false

          let cleanedUp = false
          const removeListener = () => {
            task.listeners.delete(listener)
          }
          const doCleanup = (hb?: ReturnType<typeof setInterval>) => {
            if (cleanedUp) return
            cleanedUp = true
            removeListener()
            if (hb) clearInterval(hb)
          }

          const listener = async (event: any) => {
            if (!replayDone) {
              pendingEvents.push(event)
              return
            }
            try {
              await stream.writeSSE({ data: JSON.stringify(event) })
            } catch {
              /* stream broken */
            }
          }

          task.listeners.add(listener)

          const replayedCount = task.events.length
          for (let i = 0; i < replayedCount; i++) {
            await stream.writeSSE({ data: JSON.stringify(task.events[i]) })
          }

          replayDone = true
          for (const event of pendingEvents) {
            try {
              await stream.writeSSE({ data: JSON.stringify(event) })
            } catch {
              /* stream broken */
            }
          }

          if (task.status !== "running") {
            removeListener()
            return
          }

          const heartbeat = setInterval(() => {
            stream
              .writeSSE({
                data: JSON.stringify({ type: "heartbeat" }),
              })
              .catch(() => doCleanup(heartbeat))
          }, 5_000)

          await new Promise<void>((resolve) => {
            stream.onAbort(() => {
              doCleanup(heartbeat)
              resolve()
            })

            const checkDone = setInterval(() => {
              if (task.status !== "running") {
                clearInterval(checkDone)
                doCleanup(heartbeat)
                resolve()
              }
            }, 1000)
          })
        })
      },
    )
    .post(
      "/file/translate-markdown/cancel",
      describeRoute({
        summary: "Cancel markdown translation",
        description: "Cancel a running markdown translation task.",
        operationId: "file.translateMarkdownCancel",
        responses: {
          200: {
            description: "Cancelled",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ taskID: z.string() })),
      async (c) => {
        const { taskID } = c.req.valid("json")
        const ok = cancelTranslateTask(taskID)
        return c.json({ ok })
      },
    ),
)
