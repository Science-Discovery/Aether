export function recover(
  err: unknown,
  opts: {
    current: number
    expected: number
    active: boolean
    empty: boolean
    restore: () => void
    retain: () => void
    warn: (message: string) => void
  },
) {
  const name = err && typeof err === "object" && "name" in err ? err.name : undefined
  const message =
    name === "NoModelConfiguredError"
      ? "Connect a provider and select a model before sending."
      : name === "ProviderModelNotFoundError"
        ? "The selected model is unavailable. Connect its provider or choose another model."
        : undefined
  if (!message) return false

  const restore = opts.active && opts.empty && opts.current === opts.expected
  if (restore) opts.restore()
  if (!restore) opts.retain()
  opts.warn(restore ? message : `${message} Your unsent prompt was saved to the prompt stash.`)
  return true
}
