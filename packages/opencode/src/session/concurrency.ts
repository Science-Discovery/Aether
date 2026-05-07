import { Instance } from "../project/instance"

type Slot = {
  resolve: () => void
  model: string
  startedAt: number
}

type State = {
  active: number
  queue: Slot[]
}

export namespace Concurrency {
  const state = Instance.state(
    (): State => ({
      active: 0,
      queue: [],
    }),
    async (current) => {
      current.active = 0
      for (const slot of current.queue) slot.resolve()
      current.queue = []
    },
  )

  export function canSpawn(maxConcurrent: number): boolean {
    const st = state()
    return st.active < maxConcurrent
  }

  export async function awaitSlot(maxConcurrent: number, model: string): Promise<void> {
    const st = state()
    if (st.active < maxConcurrent) {
      st.active++
      return
    }
    return new Promise<void>((resolve) => {
      st.queue.push({ resolve, model, startedAt: Date.now() })
    })
  }

  export function release(): void {
    const st = state()
    st.active--
    const next = st.queue.shift()
    if (next) {
      st.active++
      next.resolve()
    }
  }

  export function activeCount(): number {
    return state().active
  }

  export function pendingCount(): number {
    return state().queue.length
  }
}
