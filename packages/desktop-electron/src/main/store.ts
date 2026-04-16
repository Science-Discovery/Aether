import Store from "electron-store"
import { SETTINGS_STORE } from "./constants"
import { ensureDesktopPersist, ensureStoreFile } from "./persist"
import { userDataDir } from "./paths"

const cache = new Map<string, Store>()

export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  ensureDesktopPersist()
  const next = new Store({ name: ensureStoreFile(name), fileExtension: "", cwd: userDataDir() })
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
