const fallback = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

export const lease = (() => {
  const c = globalThis.crypto
  if (!c || typeof c.randomUUID !== "function") return fallback()
  try {
    return c.randomUUID()
  } catch {
    return fallback()
  }
})()
