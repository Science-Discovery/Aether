import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { which } from "@/util/which"
import { Protocol } from "./protocol"

export namespace Codex {
  export const Config = z.object({ path: z.string().trim().optional() }).meta({ ref: "NativeCodexConfig" })
  export const Model = z
    .object({
      id: z.string(),
      name: z.string(),
      default: z.boolean(),
      efforts: z.array(z.string()),
      effort: z.string().optional(),
      images: z.boolean().optional(),
    })
    .meta({ ref: "NativeCodexModel" })
  export const Status = z
    .object({
      installed: z.boolean(),
      path: z.string().optional(),
      version: z.string().optional(),
      connected: z.boolean(),
      auth: z.enum(["chatgpt", "apiKey", "unknown", "missing"]),
      models: z.array(Model),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeCodexStatus" })
  export type Status = z.infer<typeof Status>

  const account = z.object({
    account: z.object({ type: z.string() }).nullable(),
    requiresOpenaiAuth: z.boolean().optional(),
  })
  const catalog = z.object({
    data: z.array(
      z.object({
        id: z.string(),
        model: z.string().optional(),
        displayName: z.string(),
        hidden: z.boolean().optional(),
        isDefault: z.boolean(),
        supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([]),
        defaultReasoningEffort: z.string().nullable().optional(),
        inputModalities: z.array(z.string()).optional(),
      }),
    ),
    nextCursor: z.string().nullable().optional(),
  })

  async function executable(file: string) {
    const stat = await fs.stat(file).catch(() => undefined)
    if (!stat?.isFile()) return
    if (
      process.platform !== "win32" &&
      !(await fs.access(file, constants.X_OK).then(
        () => true,
        () => false,
      ))
    )
      return
    return path.resolve(file)
  }

  /** Read installation locations only; credentials remain owned by Codex. */
  export async function discover(file?: string): Promise<string | undefined> {
    if (file?.trim()) {
      const value = file.trim()
      if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) return executable(value)
      const found = which(value)
      return found ? executable(found) : undefined
    }
    const found = which("codex")
    if (found) {
      const value = await executable(found)
      if (value) return value
    }
    const home = Global.Path.home
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")
    const candidates =
      process.platform === "win32"
        ? [
            path.join(local, "OpenAI", "Codex", "bin", "codex.exe"),
            path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
            path.join(home, ".local", "bin", "codex.exe"),
          ]
        : [
            path.join(home, ".local", "bin", "codex"),
            ...(process.platform === "darwin"
              ? [
                  "/Applications/Codex.app/Contents/Resources/codex",
                  path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex"),
                ]
              : []),
          ]
    for (const candidate of candidates) {
      const value = await executable(candidate)
      if (value) return value
    }
    if (process.platform !== "win32") return
    const root = path.join(local, "OpenAI", "Codex", "bin")
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const versions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const file = path.join(root, entry.name, "codex.exe")
          const stat = await fs.stat(file).catch(() => undefined)
          if (!stat?.isFile()) return
          return { path: file, time: stat.mtimeMs }
        }),
    )
    return versions
      .filter((entry) => entry !== undefined)
      .sort((a, b) => b.time - a.time || a.path.localeCompare(b.path))[0]?.path
  }

  export async function connect(opts: Omit<Protocol.Options, "executable"> & { executable?: string } = {}) {
    const file = await discover(opts.executable)
    if (!file) throw new Error("Codex executable was not found; install Codex or configure its executable path")
    const client = Protocol.connect({ ...opts, executable: file })
    return (async () => {
      const result = z.object({ userAgent: z.string() }).parse(
        await client.request(
          "initialize",
          {
            clientInfo: { name: "aether", title: "Aether", version: "1.0.0" },
            capabilities: { experimentalApi: true, requestAttestation: false },
          },
          { timeout: 15_000 },
        ),
      )
      await client.notify("initialized")
      return { client, version: result.userAgent.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] }
    })().catch(async (error: unknown) => {
      await client.close()
      throw error
    })
  }

  export async function models(client: Protocol.Client) {
    const result: z.infer<typeof Model>[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const response = catalog.parse(await client.request("model/list", { cursor, limit: 100, includeHidden: false }))
      for (const model of response.data) {
        if (model.hidden || result.some((entry) => entry.id === (model.model ?? model.id))) continue
        result.push({
          id: model.model ?? model.id,
          name: model.displayName,
          default: model.isDefault,
          efforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
          effort: model.defaultReasoningEffort ?? undefined,
          images: model.inputModalities?.includes("image"),
        })
      }
      if (!response.nextCursor) return result
      if (cursors.has(response.nextCursor)) throw new Error("Codex returned a repeated model cursor")
      cursors.add(response.nextCursor)
      cursor = response.nextCursor
    }
    throw new Error("Codex model catalog exceeds the pagination limit")
  }

  export async function status(file?: string): Promise<Status> {
    const resolved = await discover(file)
    if (!resolved)
      return {
        installed: false,
        connected: false,
        auth: "missing",
        models: [],
        error: !file?.trim() ? "Codex executable was not found" : "The configured Codex executable was not found",
      }
    const opened = await connect({ executable: resolved, signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
    if (!opened)
      return {
        installed: true,
        path: resolved,
        connected: false,
        auth: "unknown",
        models: [],
        error: "Codex app-server could not initialize; check the executable path and Codex version",
      }
    return (async () => {
      const results = await Promise.allSettled([
        opened.client.request("account/read", { refreshToken: false }).then((value) => account.parse(value)),
        models(opened.client),
      ])
      const current = results[0].status === "fulfilled" ? results[0].value : undefined
      const type = current?.account?.type
      return {
        installed: true,
        path: resolved,
        version: opened.version,
        connected: true,
        auth:
          type === "chatgpt" || type === "apiKey"
            ? type
            : current?.account === null && current.requiresOpenaiAuth !== false
              ? "missing"
              : "unknown",
        models: results[1].status === "fulfilled" ? results[1].value : [],
        ...(results.some((result) => result.status === "rejected")
          ? { error: "Codex connected, but account or model discovery failed" }
          : {}),
      } satisfies Status
    })().finally(() => opened.client.close())
  }
}
