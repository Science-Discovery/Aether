type Input = {
  leave: VoidFunction
  activate: VoidFunction
  schedule?: (run: VoidFunction) => void
}

function defer(run: VoidFunction) {
  queueMicrotask(run)
}

// Leave routes bound to the old server before activating the new one, so the remounted
// tree never renders an old session against a new backend.
export function switchServer(input: Input) {
  const schedule = input.schedule ?? defer
  input.leave()
  schedule(input.activate)
}
