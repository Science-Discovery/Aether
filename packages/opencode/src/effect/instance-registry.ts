import { Log } from "@/util/log"

const disposers = new Set<(directory: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  Log.Default.info("[DEBUG-instance-registry] disposer registered", { disposerCount: disposers.size + 1 })
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

export async function disposeInstance(directory: string) {
  Log.Default.info("[DEBUG-instance-registry] disposeInstance start", { directory, disposerCount: disposers.size })
  const start = Date.now()
  const results = await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
  Log.Default.info("[DEBUG-instance-registry] disposeInstance done", {
    directory,
    elapsedMs: Date.now() - start,
    resultCount: results.length,
    failedCount: results.filter((r) => r.status === "rejected").length,
  })
}
