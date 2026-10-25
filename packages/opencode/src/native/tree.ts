import z from "zod"
import { Protocol } from "./protocol"

/** One native turn owns its verified descendants until their work has drained. */
export namespace NativeTree {
  const object = z.record(z.string(), z.unknown())
  const thread = z.object({
    id: z.string().min(1),
    sessionId: z.string().optional(),
    parentThreadId: z.string().nullable().optional(),
    agentNickname: z.string().nullable().optional(),
    agentRole: z.string().nullable().optional(),
    source: z.unknown().optional(),
    status: z.object({ type: z.string() }).optional(),
    turns: z.array(z.unknown()).optional(),
  })
  type Branch = {
    id: string
    parent?: string
    session?: string
    name: string
    turn: string
    live: boolean
    done: boolean
    version: number
    retired: Set<string>
    items: Map<string, Record<string, unknown>>
  }
  export type Options = {
    request: (method: string, params: unknown) => Promise<unknown>
    emit: (method: string, params: unknown) => void | Promise<void>
    fail: (error: Error) => void | Promise<void>
    drain?: () => Promise<void>
  }

  function record(value: unknown) {
    const result = object.safeParse(value)
    return result.success ? result.data : undefined
  }

  function text(value: unknown) {
    return typeof value === "string" ? value : ""
  }

  function parent(value: z.infer<typeof thread>) {
    const source = record(value.source)
    const legacy = text(record(record(source?.subAgent)?.thread_spawn)?.parent_thread_id)
    if (value.parentThreadId && legacy && value.parentThreadId !== legacy)
      throw new Error("Codex reported inconsistent sub-agent parent identifiers.")
    return value.parentThreadId ?? legacy
  }

  export function create(opts: Options) {
    const branches = new Map<string, Branch>()
    const reads = new Map<string, Promise<Branch | undefined>>()
    const driven = new Set<string>()
    const state = {
      root: "",
      active: false,
      stopped: false,
      failed: false,
      completed: false,
      scanned: false,
      pending: 0,
      ending: undefined as Record<string, unknown> | undefined,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      checking: undefined as Promise<void> | undefined,
    }

    function close() {
      state.stopped = true
      clearTimeout(state.timer)
    }

    async function fail(error: unknown) {
      if (state.failed || state.stopped) return
      state.failed = true
      clearTimeout(state.timer)
      await opts.fail(error instanceof Error ? error : new Error(String(error)))
    }

    async function emit(method: string, params: unknown) {
      if (!state.stopped && !state.failed) await opts.emit(method, params)
    }

    function registerRoot(value: unknown) {
      const info = thread.parse(value)
      if (state.root && state.root !== info.id) throw new Error("The native root thread cannot change during a turn.")
      state.root = info.id
      branches.set(info.id, {
        id: info.id,
        session: info.sessionId,
        name: "Codex",
        turn: "",
        live: false,
        done: false,
        version: 0,
        retired: new Set(),
        items: new Map(),
      })
    }

    function bindTurn(id: string) {
      const root = branches.get(state.root)
      if (!root) throw new Error("Register the Codex root thread before starting its turn.")
      if (root.turn && root.turn !== id) throw new Error("Codex started an unexpected root turn.")
      root.turn = id
      root.live = !state.ending
      root.done = false
    }

    function belongs(info: z.infer<typeof thread>, owner: Branch) {
      const root = branches.get(state.root)
      const session = root?.session ?? owner.session
      // Loaded descendants can share the root's session ID, then report their
      // own ID after unloading. Their verified parent chain remains required.
      return (
        !info.sessionId ||
        !session ||
        info.sessionId === session ||
        (root?.session === root?.id && info.sessionId === info.id)
      )
    }

    async function ensure(id: string, chain: string[] = []): Promise<Branch | undefined> {
      if (branches.has(id)) return branches.get(id)
      if (chain.includes(id) || chain.length >= 32) throw new Error("Codex reported an invalid sub-agent parent chain.")
      if (branches.size + reads.size >= 256) throw new Error("The native sub-agent tree exceeds the supported limit.")
      if (!chain.length && reads.has(id)) return reads.get(id)
      const pending = (async () => {
        const result = record(await opts.request("thread/read", { threadId: id, includeTurns: false }))?.thread
        const info = thread.parse(result)
        if (info.id !== id) throw new Error("Codex returned metadata for a different sub-agent thread.")
        const ancestor = parent(info)
        if (!ancestor || ancestor === id) return
        const owner = await ensure(ancestor, [...chain, id])
        if (!owner) return
        if (!belongs(info, owner)) return
        const branch: Branch = {
          id,
          parent: owner.id,
          session: info.sessionId ?? owner.session,
          name: info.agentNickname || info.agentRole || `Codex agent ${id.slice(0, 8)}`,
          turn: "",
          live: info.status?.type === "active",
          done: false,
          version: 0,
          retired: new Set(),
          items: new Map(),
        }
        branches.set(id, branch)
        return branch
      })()
      if (chain.length) return pending
      reads.set(id, pending)
      return pending.finally(() => reads.delete(id))
    }

    function namespace(branch: Branch, id: string) {
      return `codex:${encodeURIComponent(branch.id)}:${encodeURIComponent(branch.turn)}:${encodeURIComponent(id)}`
    }

    function mapped(branch: Branch, data: Record<string, unknown>) {
      if (branch.id === state.root) return data
      const root = branches.get(state.root)!
      const item = record(data.item)
      return {
        ...data,
        threadId: root.id,
        turnId: root.turn,
        ...(typeof data.itemId === "string" ? { itemId: namespace(branch, data.itemId) } : {}),
        ...(item ? { item: { ...item, id: namespace(branch, text(item.id)) } } : {}),
        nativeAgent: { threadId: branch.id, turnId: branch.turn, parentThreadId: branch.parent, name: branch.name },
      }
    }

    async function badge(branch: Branch, status: string, error?: string) {
      await emit(
        status === "inProgress" ? "item/started" : "item/completed",
        mapped(branch, {
          item: {
            id: "__agent__",
            type: "nativeAgent",
            tool: branch.name,
            status,
            ...(error ? { error } : {}),
            result: error ?? `${branch.name}: ${status}`,
          },
        }),
      )
    }

    async function end(branch: Branch, turn: Record<string, unknown>) {
      if (branch.turn && turn.id !== branch.turn) return
      if (branch.retired.has(text(turn.id))) return
      if (!branch.turn) branch.turn = text(turn.id)
      if (!branch.turn) throw new Error("A sub-agent completed without a turn identifier.")
      branch.live = false
      branch.done = true
      branch.version++
      branch.retired.add(branch.turn)
      const ending = { ...branch }
      const unfinished = new Map(branch.items)
      branch.items.clear()
      const items = Array.isArray(turn.items) ? turn.items : []
      for (const value of items) {
        const item = record(value)
        if (!item || !text(item.id)) continue
        unfinished.delete(text(item.id))
        await emit("item/completed", mapped(ending, { item }))
      }
      for (const item of unfinished.values()) {
        await emit(
          "item/completed",
          mapped(ending, {
            item: {
              ...item,
              status: "failed",
              error: "The sub-agent ended before this item returned a final result.",
            },
          }),
        )
      }
      const error = record(turn.error)
      await badge(ending, turn.status === "completed" ? "completed" : "failed", text(error?.message) || undefined)
    }

    async function reconcile(branch: Branch, loading = false) {
      const version = branch.version
      const query = async (method: string, params: unknown) =>
        record(
          await opts.request(method, params).catch((error: unknown) => {
            if (version !== branch.version) return
            throw error
          }),
        )
      const validate = (value: unknown) => {
        const info = thread.parse(value)
        if (info.id !== branch.id || parent(info) !== branch.parent)
          throw new Error("The native sub-agent's ownership changed while it was running.")
        if (!belongs(info, branch)) throw new Error("The native sub-agent moved to a different session.")
        return info
      }
      const metadata = await query("thread/read", { threadId: branch.id, includeTurns: false })
      if (version !== branch.version) return
      const status = validate(metadata?.thread).status?.type
      if (loading && status !== "active") return
      if (status === "active" && branch.turn && !branch.done) {
        branch.live = true
        return
      }
      if (status === "systemError") throw new Error(`${branch.name} entered a native system error.`)
      const result = await query("thread/read", { threadId: branch.id, includeTurns: true })
      if (version !== branch.version) return
      const info = validate(result?.thread)
      const history = (info.turns ?? []).flatMap((value) => (record(value) ? [record(value)!] : []))
      const cutoff = history.findLastIndex((turn) => branch.retired.has(text(turn.id)))
      const turns = history.slice(cutoff + 1).filter((turn) => !branch.retired.has(text(turn.id)))
      const running = turns.findLast((turn) => turn.status === "inProgress")
      if (info.status?.type === "active") {
        branch.live = true
        // A newly spawned thread can become active before its first turn is
        // materialized. Keep it alive until a later event/read proves its ID.
        if (!running || !text(running.id)) return
        branch.turn = text(running.id)
        branch.done = false
        branch.version++
        await badge(branch, "inProgress")
        return
      }
      const current = (turn: Record<string, unknown>) =>
        branch.turn
          ? turn.id === branch.turn
          : Boolean(branches.get(state.root)?.turn && turn.rootTurnId === branches.get(state.root)?.turn)
      const terminal = turns.findLast(current)
      if (terminal && ["completed", "failed", "interrupted"].includes(text(terminal.status))) {
        await end(branch, terminal)
        return
      }
      throw new Error(`Cannot confirm that ${branch.name} completed; its native turn history is unavailable.`)
    }

    async function settle() {
      if (!state.ending || state.stopped || state.failed || state.completed || reads.size || state.pending) return
      if (!state.scanned) {
        state.scanned = true
        const cursors = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < 20; page++) {
          const result = object.parse(await opts.request("thread/loaded/list", { cursor, limit: 100 }))
          const ids = z.array(z.string()).parse(result.data)
          for (const id of ids) await ensure(id)
          const next = text(result.nextCursor)
          if (!next) break
          if (cursors.has(next) || page === 19)
            throw new Error("Codex returned an invalid loaded-thread page sequence.")
          cursors.add(next)
          cursor = next
        }
      }
      if (state.checking) return
      if ([...branches.values()].some((branch) => branch.id !== state.root && branch.live)) {
        if (!state.timer) {
          state.timer = setTimeout(() => {
            state.timer = undefined
            state.checking = Promise.all(
              [...branches.values()]
                .filter((branch) => branch.id !== state.root && branch.live)
                .map((branch) => reconcile(branch)),
            )
              .then(() => undefined)
              .catch(fail)
              .finally(async () => {
                state.checking = undefined
                await settle().catch(fail)
              })
          }, 2_000)
        }
        return
      }
      clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = undefined
        void (async () => {
          await opts.drain?.()
          if (state.stopped || state.failed || state.completed) return
          if (
            state.pending ||
            reads.size ||
            [...branches.values()].some((branch) => branch.id !== state.root && branch.live)
          ) {
            await settle()
            return
          }
          state.completed = true
          await emit("turn/completed", state.ending)
        })().catch(fail)
      }, 0)
    }

    async function discover(branch: Branch, item: Record<string, unknown>) {
      if (!["collabAgentToolCall", "subAgentActivity"].includes(text(item.type))) return
      if (item.senderThreadId && item.senderThreadId !== branch.id)
        throw new Error("Codex reported a collaboration item from an unrelated sender.")
      const ids = Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter((value): value is string => typeof value === "string")
        : typeof item.agentThreadId === "string"
          ? [item.agentThreadId]
          : []
      const drives = ["spawnAgent", "sendInput", "followupTask"].includes(text(item.tool)) || item.kind === "started"
      for (const id of ids) {
        if (id === state.root) continue
        const child = await ensure(id)
        if (!child) {
          if (drives) throw new Error("Codex could not verify ownership of a running sub-agent.")
          continue
        }
        // Restoring an agent's context alone does not start a new turn.
        if (item.tool === "resumeAgent") await reconcile(child, true)
        // A completed launch is not a completed agent. Its own turn must retire it.
        const key = `${namespace(branch, text(item.id))}:${id}`
        if (drives && item.status !== "failed" && item.status !== "interrupted" && !driven.has(key)) {
          driven.add(key)
          child.version++
          if (child.done) {
            child.turn = ""
            child.done = false
          }
          child.live = true
        }
      }
    }

    async function notification(method: string, value: unknown) {
      if (!state.active || state.stopped || state.failed || state.completed) return
      try {
        const data = record(value)
        if (!data) return
        if (method === "thread/started") {
          const info = thread.parse(data.thread)
          if (info.id === state.root) return
          await ensure(info.id).catch(() => undefined)
          return
        }
        const id = text(data.threadId)
        if (!id) return
        const branch = branches.get(id) ?? (await ensure(id).catch(() => undefined))
        if (!branch) return
        const root = branch.id === state.root
        if (method === "turn/started") {
          const turn = record(data.turn)
          const id = text(turn?.id)
          if (!id) throw new Error("Codex started a turn without its identifier.")
          if (root) {
            bindTurn(id)
            await emit(method, data)
            return
          }
          if (branch.retired.has(id)) return
          if (branch.live && !branch.done && branch.turn && branch.turn !== id)
            throw new Error("Codex started overlapping turns on one sub-agent.")
          branch.turn = id
          branch.live = true
          branch.done = false
          branch.version++
          await badge(branch, "inProgress")
          return
        }
        if (method === "thread/status/changed" || method === "thread/closed") {
          if (!root && record(data.status)?.type === "active") {
            if (branch.done) {
              branch.turn = ""
              branch.done = false
              branch.version++
            }
            branch.live = true
          }
          // Idle status can precede the terminal turn event. Let the queued
          // event arrive before the existing settlement timer reads history.
          await settle()
          return
        }
        if (!root && !branch.live) return
        // Thread metadata can arrive before a newborn agent's turn exists.
        // Only turn-scoped content needs missing-turn history recovery.
        if (!root && method === "thread/tokenUsage/updated") return
        if (!root && !branch.turn && typeof data.turnId !== "string" && method !== "turn/completed") return
        if (!root && !branch.turn) await reconcile(branch)
        if (!branch.turn || (typeof data.turnId === "string" && data.turnId !== branch.turn)) return
        if (method === "turn/completed") {
          const turn = record(data.turn)
          if (!turn || turn.id !== branch.turn) return
          if (!root) await end(branch, turn)
          if (root) {
            branch.live = false
            state.ending = data
          }
          await settle()
          return
        }
        if (method === "item/started" || method === "item/completed") {
          const item = record(data.item)
          if (item) {
            await discover(branch, item)
            if (!root) {
              if (method === "item/started") branch.items.set(text(item.id), item)
              if (method === "item/completed") branch.items.delete(text(item.id))
            }
          }
        }
        if (!root && method === "error") {
          if (data.willRetry === false) {
            await end(branch, { id: branch.turn, status: "failed", error: data.error })
            await settle()
          }
          return
        }
        await emit(method, mapped(branch, data))
        await settle()
      } catch (error) {
        await fail(error)
      }
    }

    async function request(
      method: string,
      value: unknown,
      handler: (method: string, params: unknown) => Promise<unknown>,
    ) {
      if (!state.active || state.stopped || state.failed || state.completed)
        throw new Protocol.RpcError(-32602, "The Codex turn is no longer active.")
      state.pending++
      try {
        const data = object.parse(value)
        const branch = await ensure(text(data.threadId))
        if (branch && branch.id !== state.root && branch.live && !branch.turn) await reconcile(branch)
        if (!branch || !branch.turn || !branch.live || data.turnId !== branch.turn)
          throw new Protocol.RpcError(-32602, "The request does not belong to an active, verified Codex agent.")
        return await handler(method, mapped(branch, data))
      } finally {
        state.pending--
        await settle()
      }
    }

    function active() {
      return [...branches.values()]
        .filter((branch) => branch.live && branch.turn)
        .map((branch) => ({ threadId: branch.id, turnId: branch.turn }))
    }

    async function interrupt() {
      close()
      await Promise.allSettled(
        [...branches.values()]
          .filter((branch) => branch.id !== state.root && branch.live && !branch.turn)
          .map((branch) => reconcile(branch)),
      )
      await Promise.allSettled(active().map((turn) => opts.request("turn/interrupt", turn)))
    }

    return {
      registerRoot,
      activate: () => {
        state.active = true
      },
      bindTurn,
      notification,
      request,
      interrupt,
      active,
      close,
    }
  }
}
