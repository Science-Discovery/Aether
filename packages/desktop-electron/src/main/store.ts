import Store from "electron-store"
import { SETTINGS_STORE } from "./constants"
import { ensureDesktopPersist, ensureStoreFile } from "./persist"
import { shared } from "./persist-names"
import { userDataDir, aetherDataDir } from "./paths"

const cache = new Map<string, Store>()

export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  ensureDesktopPersist()
  const nextName = ensureStoreFile(name)
  const cwd = shared(nextName) ? aetherDataDir() : userDataDir()
  const next = new Store({ name: nextName, fileExtension: "", cwd, accessPropertiesByDotNotation: false })
  cache.set(name, next)
  return next
}

export const store = new Proxy({} as Store, {
  get(_obj, key) {
    const base = getStore(SETTINGS_STORE)
    const value = Reflect.get(base as object, key)
    if (typeof value !== "function") return value
    return value.bind(base)
  },
})
