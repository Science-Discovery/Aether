let hook: (() => void) | undefined
let done = false

export function onShutdown(fn: () => void) {
  hook = fn
}

export function requestShutdown() {
  if (done) return
  done = true
  if (hook) return hook()
  process.kill(process.pid, "SIGTERM")
}
