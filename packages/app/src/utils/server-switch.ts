type Note = unknown | (() => unknown)

type Input = {
  done: VoidFunction
  later: VoidFunction
  note?: Note
  schedule?: (run: VoidFunction) => void
  path?: () => string
  timeoutMs?: number
}

function detail(note?: Note) {
  if (typeof note === "function") return note()
  return note
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
