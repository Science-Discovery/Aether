import { Instance } from "@/project/instance"

/** Serializes local history projection and input dispatch; not a cross-client lock. */
export namespace NativeLock {
  const state = Instance.state(() => new Map<string, Promise<void>>())

  export function busy(id: string) {
    return state().has(id)
  }

  export async function run<T>(id: string, work: () => Promise<T>, signal?: AbortSignal) {
    const pending = state()
    signal?.throwIfAborted()
    while (pending.has(id)) {
      const current = pending.get(id)!
      if (!signal) {
        await current
        continue
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        void current.then(() => {
          signal.removeEventListener("abort", abort)
          resolve()
        })
      })
      signal.throwIfAborted()
    }
    const done = Promise.withResolvers<void>()
    pending.set(id, done.promise)
    try {
      return await work()
    } finally {
      pending.delete(id)
      done.resolve()
    }
  }
}
