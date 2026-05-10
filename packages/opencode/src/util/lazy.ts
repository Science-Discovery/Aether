export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = (): T => {
    if (loaded) return value as T
    try {
      value = fn()
      loaded = true
      return value as T
    } catch (e) {
      throw e
    }
  }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  result.isLoaded = () => loaded

  return result
}
