type Input = {
  done: VoidFunction
  later: VoidFunction
  schedule?: (run: VoidFunction) => void
  path?: () => string
  timeoutMs?: number
}

function nextFrame(run: VoidFunction) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(run)
    return
  }
  setTimeout(run, 0)
}

export function switchServer(input: Input) {
  const start = input.path?.()
  input.done()
  if (!start || start === "/") {
    input.later()
    return
  }
  const schedule = input.schedule ?? nextFrame
  const timeoutMs = input.timeoutMs ?? 500
  const started = Date.now()

  const run = () => {
    input.later()
  }

  const check = () => {
    const current = input.path?.()
    if (!start || !current || current !== start) {
      run()
      return
    }
    if (Date.now() - started >= timeoutMs) {
      run()
      return
    }
    schedule(check)
  }

  schedule(check)
}
