import { normalize } from "../src/provider/models-v2"

const root = process.env.OPENCODE_MODELS_URL || "https://models.dev/experimental/v2.0"
const fallback = process.env.OPENCODE_MODELS_URL ? undefined : "https://models.dev"

async function load(url: string) {
  const res = await fetch(`${url}/api.json`).catch(() => undefined)
  if (!res?.ok) return undefined
  return res
    .json()
    .then(normalize)
    .catch(() => undefined)
}

export async function models(opts?: { offline?: boolean }) {
  const file = process.env.MODELS_DEV_API_JSON
  if (file) return JSON.stringify(normalize(await Bun.file(file).json()))

  const data = (await load(root)) ?? (fallback ? await load(fallback) : undefined)
  if (data) return JSON.stringify(data)
  if (!opts?.offline && process.platform !== "win32") {
    throw new Error("Failed to fetch models.dev")
  }
  return "undefined"
}
