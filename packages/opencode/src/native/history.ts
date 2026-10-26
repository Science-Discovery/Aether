import { createHash } from "node:crypto"
import z from "zod"
import type { Protocol } from "./protocol"
import { project as projection } from "./projection"

/** Read-only history: never resume a thread or infer ownership from its status. */
export namespace NativeHistory {
  export const Item = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough()
  export type Item = z.infer<typeof Item>
  export const Turn = z
    .object({
      id: z.string().min(1),
      status: z.string(),
      items: Item.array(),
      itemsView: z.string().optional(),
      startedAt: z.number().finite().nullable().optional(),
      completedAt: z.number().finite().nullable().optional(),
    })
    .passthrough()
  export type Turn = z.infer<typeof Turn>
  export const Thread = z
    .object({
      id: z.string().min(1),
      createdAt: z.number().finite(),
      updatedAt: z.number().finite(),
      status: z.object({ type: z.string() }).passthrough(),
    })
    .passthrough()
  export type Thread = z.infer<typeof Thread>
  export type Issue = { code: string; message: string; turn?: string; item?: string }
  export type Snapshot = {
    thread?: Thread
    turns: Turn[]
    complete: boolean
    issues: Issue[]
  }
  export type Options = { signal?: AbortSignal; pages?: number; items?: number; bytes?: number }

  const page = z.object({ data: z.array(z.unknown()), nextCursor: z.string().min(1).nullable() })
  const entry = z.object({ turnId: z.string(), item: Item })
  const response = z.object({ thread: Thread })

  export function key(...parts: string[]) {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)
  }

  export async function read(client: Pick<Protocol.Client, "request">, thread: string, opts: Options = {}) {
    const bounds = { pages: opts.pages ?? 100, items: opts.items ?? 10_000, bytes: opts.bytes ?? 32 * 1024 * 1024 }
    if (!thread || Object.values(bounds).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("Invalid native history limits or thread ID")
    }
    opts.signal?.throwIfAborted()
    const snapshot: Snapshot = { turns: [], complete: false, issues: [] }
    const state = { pages: 0, bytes: 0, items: 0 }
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(opts.signal ? [opts.signal] : [])])
    const turns = new Set<string>()

    async function request(method: string, params: Record<string, unknown>) {
      signal.throwIfAborted()
      const value = await client.request(method, params, { signal, timeout: 15_000 })
      state.bytes += Buffer.byteLength(JSON.stringify(value) ?? "")
      if (state.bytes > bounds.bytes) throw new Error("Native history exceeds the byte limit")
      return value
    }

    async function collect(
      method: string,
      params: Record<string, unknown>,
      consume: (value: unknown) => Promise<void>,
    ) {
      const seen = new Set<string>()
      let cursor: string | undefined
      while (true) {
        if (++state.pages > bounds.pages) throw new Error("Native history exceeds the page limit")
        const result = page.parse(await request(method, { ...params, limit: 100, sortDirection: "asc", cursor }))
        for (const value of result.data) await consume(value)
        if (result.nextCursor === null) return
        if (seen.has(result.nextCursor)) throw new Error("Codex repeated a history cursor")
        if (!result.data.length) throw new Error("Codex returned an empty nonterminal history page")
        seen.add(result.nextCursor)
        cursor = result.nextCursor
      }
    }

    async function load() {
      const before = response.parse(await request("thread/read", { threadId: thread, includeTurns: false })).thread
      if (before.id !== thread) throw new Error("Codex returned another thread's history")
      snapshot.thread = before
      if (!["idle", "notLoaded"].includes(before.status.type)) {
        snapshot.issues.push({ code: "unsettled", message: `The reading connection reports ${before.status.type}` })
      }
      await collect("thread/turns/list", { threadId: thread, itemsView: "full" }, async (value) => {
        const turn = Turn.parse(value)
        if (turns.has(turn.id)) throw new Error("Codex repeated a history turn")
        turns.add(turn.id)
        // A different app-server can label an externally running turn interrupted.
        // Only completed turns are eligible; do not synthesize failed/stopped UI.
        if (turn.status !== "completed") {
          snapshot.issues.push({
            code: "unsettled",
            turn: turn.id,
            message: `Turn history reports ${turn.status}; its global execution state is unknown`,
          })
          return
        }
        const items: Item[] = []
        if (turn.itemsView !== undefined && turn.itemsView !== "full") {
          await collect("thread/items/list", { threadId: thread, turnId: turn.id }, async (value) => {
            const item = entry.parse(value)
            if (item.turnId !== turn.id) throw new Error("Codex returned an item from another turn")
            items.push(item.item)
            if (++state.items > bounds.items) throw new Error("Native history exceeds the item limit")
          })
        } else {
          state.items += turn.items.length
          if (state.items > bounds.items) throw new Error("Native history exceeds the item limit")
          items.push(...turn.items)
        }
        if (new Set(items.map((item) => item.id)).size !== items.length) {
          throw new Error("Codex repeated a history item within a turn")
        }
        snapshot.turns.push({ ...turn, items, itemsView: "full" })
      })
      const after = response.parse(await request("thread/read", { threadId: thread, includeTurns: false })).thread
      if (after.id !== thread || after.updatedAt !== before.updatedAt || after.status.type !== before.status.type) {
        snapshot.issues.push({ code: "changed", message: "The thread changed while history was being read" })
      }
      snapshot.complete = !snapshot.issues.length
    }

    await load().catch((err: unknown) => {
      opts.signal?.throwIfAborted()
      snapshot.issues.push({
        code: err instanceof Error && "code" in err && err.code === -32601 ? "unsupported" : "unavailable",
        message: err instanceof Error ? err.message : "Native history could not be read completely",
      })
    })
    return snapshot
  }

  export function project(...args: Parameters<typeof projection>) {
    return projection(...args)
  }
}
