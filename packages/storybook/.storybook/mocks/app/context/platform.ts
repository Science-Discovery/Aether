import type { Platform } from "../../../../../app/src/context/platform"

const value: Platform = {
  platform: "web",
  openLink() {},
  restart: async () => {},
  back() {},
  forward() {},
  notify: async () => {},
  fetch: globalThis.fetch.bind(globalThis),
}

export function usePlatform() {
  return value
}
