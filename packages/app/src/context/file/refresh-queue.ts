export function createRefreshQueue(flush: (dirs: string[]) => void, delay = 150) {
  const set = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  return {
    push(dir: string) {
      set.add(dir)
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        const dirs = [...set]
        set.clear()
        flush(dirs)
      }, delay)
    },
    stop() {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      set.clear()
    },
  }
}
