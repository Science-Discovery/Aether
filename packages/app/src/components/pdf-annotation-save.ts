export function queue<T>() {
  let data: T | undefined
  let revision = 0
  let error: Error | undefined
  let pending = Promise.resolve()

  return {
    get data() {
      return data
    },
    get error() {
      return error
    },
    load(value: T) {
      if (!revision) data = value
      return data
    },
    save(value: T, write: (value: T) => Promise<T>) {
      data = value
      error = undefined
      const version = ++revision
      pending = pending.then(async () => {
        await Promise.resolve()
          .then(() => write(value))
          .then(
            (saved) => {
              if (version === revision) data = saved
            },
            (err: unknown) => {
              if (version === revision) error = err instanceof Error ? err : new Error(String(err))
            },
          )
      })
      return pending
    },
    async flush() {
      while (true) {
        const task = pending
        await task
        if (task !== pending) continue
        if (error) throw error
        return data
      }
    },
  }
}
