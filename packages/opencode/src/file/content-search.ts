import z from "zod"
import { Ripgrep } from "./ripgrep"

const TTL = 2 * 60 * 1000

type Input = {
  cwd: string
  pattern: string
  include?: string[]
  exclude?: string[]
  case?: boolean
  word?: boolean
  regex?: boolean
  signal?: AbortSignal
}

type State = {
  id: string
  at: number
  abort: AbortController
  iter: AsyncGenerator<Ripgrep.Group[]>
  items: Ripgrep.Group[]
  read: number
  done: boolean
  wait: Promise<void>
}

const store = new Map<string, State>()

const touch = (state: State) => {
  state.at = Date.now()
}

const drop = (id: string) => {
  const state = store.get(id)
  if (!state) return
  store.delete(id)
  state.abort.abort()
}

const prune = (now = Date.now()) => {
  for (const [id, state] of store.entries()) {
    if (now - state.at <= TTL) continue
    drop(id)
  }
}

const run = async <T>(state: State, fn: () => Promise<T>) => {
  const prev = state.wait
  let done = () => {}
  state.wait = new Promise<void>((resolve) => {
    done = resolve
  })
  await prev
  try {
    return await fn()
  } finally {
    done()
  }
}

const fill = async (state: State, limit: number) => {
  while (!state.done && state.items.length < limit) {
    const next = await state.iter.next()
    if (next.done) {
      state.done = true
      return
    }
    state.items.push(...next.value)
  }
}

const page = async (state: State, limit: number) => {
  await fill(state, limit)
  const items = state.items.splice(0, limit)
  state.read += items.length
  touch(state)
  return {
    session_id: state.id,
    cursor: state.read,
    done: state.done && state.items.length === 0,
    items,
  }
}

export namespace ContentSearch {
  export const Query = z.object({
    pattern: z.string(),
    include: z.string().optional(),
    exclude: z.string().optional(),
    case: z.boolean().optional(),
    word: z.boolean().optional(),
    regex: z.boolean().optional(),
  })

  export const Page = z.object({
    session_id: z.string(),
    cursor: z.number().int().nonnegative(),
    done: z.boolean(),
    items: Ripgrep.Group.array(),
  })

  export async function create(input: Input & { limit: number }) {
    prune()
    const abort = new AbortController()
    const stop = () => abort.abort()
    input.signal?.addEventListener("abort", stop, { once: true })
    if (input.signal?.aborted) stop()
    const id = crypto.randomUUID()
    const state: State = {
      id,
      at: Date.now(),
      abort,
      iter: Ripgrep.stream({
        cwd: input.cwd,
        pattern: input.pattern,
        include: input.include,
        exclude: input.exclude,
        case: input.case,
        word: input.word,
        regex: input.regex,
        batch: input.limit,
        signal: abort.signal,
      }),
      items: [],
      read: 0,
      done: false,
      wait: Promise.resolve(),
    }
    store.set(id, state)
    try {
      return await page(state, input.limit)
    } catch (err) {
      drop(id)
      throw err
    } finally {
      input.signal?.removeEventListener("abort", stop)
    }
  }

  export async function next(input: { sessionID: string; cursor?: number; limit: number }) {
    prune()
    const state = store.get(input.sessionID)
    if (!state) throw new Error(`Search session not found: ${input.sessionID}`)
    return run(state, async () => {
      touch(state)
      const cursor = input.cursor ?? 0
      if (cursor !== state.read) throw new Error(`Search cursor is stale: expected ${state.read}, got ${cursor}`)
      try {
        return await page(state, input.limit)
      } catch (err) {
        drop(input.sessionID)
        throw err
      }
    })
  }

  export function remove(sessionID: string) {
    prune()
    drop(sessionID)
  }
}
