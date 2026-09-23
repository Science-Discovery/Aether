import { createSignal } from "solid-js"

export function createReconnectTracker() {
  const [count, setCount] = createSignal(0)
  const hooks = new Set<() => void>()
  return {
    listen(hook: () => void) {
      hooks.add(hook)
      return () => {
        hooks.delete(hook)
      }
    },
    fire() {
      for (const hook of hooks) hook()
      setCount((x) => x + 1)
    },
    get count() {
      return count()
    },
  }
}
