export const APP = "aether"
export const LEGACY_APP = "opencode"

export const SETTINGS_STORE = "aether.settings"
export const LEGACY_SETTINGS_STORE = "opencode.settings"

function scoped(name: string, from: string, to: string) {
  if (!name.startsWith(`${from}.`)) return name
  return `${to}${name.slice(from.length)}`
}

export function storeName(name: string) {
  if (name === LEGACY_SETTINGS_STORE) return SETTINGS_STORE
  if (name === SETTINGS_STORE) return SETTINGS_STORE
  if (name.endsWith(".dat")) return scoped(name, LEGACY_APP, APP)
  return name
}

export function shared(name: string) {
  const next = storeName(name)
  if (next === "aether.global.dat") return true
  if (next === SETTINGS_STORE) return true
  if (next === "default.dat") return true
  return next.startsWith(`${APP}.workspace.`) && next.endsWith(".dat")
}

export function legacyStoreName(name: string) {
  if (name === SETTINGS_STORE || name === LEGACY_SETTINGS_STORE) return LEGACY_SETTINGS_STORE
  if (!name.endsWith(".dat")) return
  if (name.startsWith(`${APP}.`)) return scoped(name, APP, LEGACY_APP)
  if (name.startsWith(`${LEGACY_APP}.`)) return name
}
