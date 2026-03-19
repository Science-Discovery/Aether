import { Hono } from "hono"
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

export const FileRoutes = lazy(() =>
  new Hono()
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
          ...errors(400),
        },
      }),
      validator("json", z.object({ path: z.string(), content: z.string() })),
      async (c) => {
        const { path, content } = c.req.valid("json")
        await File.write(path, content)
        return c.json({ ok: true })
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
        let stat: Stats | undefined; 
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
              const proc = spawn(["explorer.exe", `${inputPath}`]);
              await proc.exited;
            } else {
              const proc = spawn(["explorer.exe", "/select,", `${inputPath}`]);
              await proc.exited;
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
          return c.json({ 
            error: "Failed to open in explorer",
            details: error instanceof Error ? error.message : String(error)
          }, 500)
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
          return c.json({
            error: "Failed to open file",
            details: error instanceof Error ? error.message : String(error),
          }, 500)
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
    ),
)
