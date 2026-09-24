export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

export async function withRetry<T>(opts: {
  label: string
  attempts: number
  backoff: number
  run: () => Promise<T>
  next?: () => Promise<void>
}): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await opts.run()
    } catch (err) {
      if (n >= opts.attempts) throw err
      console.error(`Retrying ${opts.label} (attempt ${n} failed): ${err}`)
      await sleep(n * opts.backoff)
      await opts.next?.()
    }
  }
}
