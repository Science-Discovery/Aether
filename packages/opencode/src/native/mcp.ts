import z from "zod"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Codex } from "./codex"
import type { Protocol } from "./protocol"

export namespace NativeMcp {
  const Server = z.object({
    name: z.string(),
    status: z.string(),
    auth: z.string(),
    error: z.string().optional(),
    tools: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  })
  export const Status = z
    .object({
      state: z.enum(["ready", "disabled", "unavailable"]),
      servers: z.array(Server),
      error: z.string().optional(),
    })
    .meta({ ref: "NativeMcpStatus" })
  const page = z.object({
    data: z
      .array(
        z.object({
          name: z.string(),
          runtimeStatus: z.string().nullable().optional(),
          authStatus: z.string().optional(),
          toolsError: z.string().nullable().optional(),
          tools: z.record(z.string(), z.object({ name: z.string().optional(), description: z.string().optional() })),
        }),
      )
      .max(1000),
    nextCursor: z.string().nullable().optional(),
  })
  const cache = Instance.state(() => new Map<string, { at: number; value: Promise<z.infer<typeof Status>> }>())

  export async function list(client: Pick<Protocol.Client, "request">) {
    const servers = new Map<string, z.infer<typeof Server>>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let index = 0; index < 100; index++) {
      const result = page.parse(
        await client.request("mcpServerStatus/list", { cursor, limit: 100 }, { timeout: 15_000 }),
      )
      for (const item of result.data) {
        servers.set(item.name, {
          name: item.name,
          status: item.runtimeStatus ?? "unknown",
          auth: item.authStatus ?? "unknown",
          error: item.toolsError ?? undefined,
          tools: Object.entries(item.tools).map(([name, tool]) => ({
            name: tool.name ?? name,
            description: tool.description,
          })),
        })
      }
      if (!result.nextCursor) return { state: "ready" as const, servers: [...servers.values()] }
      if (cursors.has(result.nextCursor)) throw new Error("Codex returned a repeated MCP cursor")
      cursors.add(result.nextCursor)
      cursor = result.nextCursor
    }
    throw new Error("Codex MCP catalog exceeds the pagination limit")
  }

  export async function read(opts: { refresh?: boolean } = {}): Promise<z.infer<typeof Status>> {
    const cfg = (await Config.getGlobal()).native?.codex
    if (cfg?.enabled === false) return { state: "disabled", servers: [] }
    const key = JSON.stringify([cfg?.path ?? "", process.env.CODEX_HOME ?? ""])
    const previous = cache().get(key)
    if (!opts.refresh && previous && Date.now() - previous.at < 30_000) return previous.value
    const value = (async () => {
      const connection = await Codex.connect({
        executable: cfg?.path,
        cwd: Instance.directory,
        signal: AbortSignal.timeout(30_000),
      })
      return list(connection.client).finally(() => connection.client.close())
    })().catch((err: unknown) => ({
      state: "unavailable" as const,
      servers: [],
      error: err instanceof Error ? err.message : String(err),
    }))
    cache().clear()
    cache().set(key, { at: Date.now(), value })
    const result = await value
    const current = (await Config.getGlobal()).native?.codex
    if (current?.enabled === false) return { state: "disabled", servers: [] }
    if (key !== JSON.stringify([current?.path ?? "", process.env.CODEX_HOME ?? ""]))
      return { state: "unavailable", servers: [], error: "Codex configuration changed; refresh MCP status." }
    return result
  }
}
