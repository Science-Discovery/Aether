const root = process.env.OPENCODE_MODELS_URL || "https://models.dev"

export async function models(opts?: { offline?: boolean }) {
  const file = process.env.MODELS_DEV_API_JSON
  if (file) return JSON.stringify(await Bun.file(file).json())

  const res = await fetch(`${root}/api.json`).catch((err) => {
    if (!opts?.offline && process.platform !== "win32") throw err
    return undefined
  })
  if (!res) return "undefined"
  if (res.ok) return JSON.stringify(await res.json())
  if (!opts?.offline && process.platform !== "win32") {
    throw new Error(`Failed to fetch models.dev: ${res.status} ${res.statusText}`)
  }
  return "undefined"
}
