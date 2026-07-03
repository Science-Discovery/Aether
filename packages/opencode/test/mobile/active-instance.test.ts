import { afterEach, describe, expect, test } from "bun:test"
import { ActiveInstance } from "../../src/project/active-instance"
import { MobileManagerBase } from "../../src/mobile/base"
import type { MobileAdapter } from "../../src/mobile/base"

const dirs: string[] = []

const dir = () => {
  const value = `/tmp/opencode-mobile-active-${Math.random().toString(36).slice(2)}`
  dirs.push(value)
  return value
}

const adapter: MobileAdapter = {
  platform: "wechat",
  replyText: async () => {},
  replyFile: async () => {},
  loadConfig: async () => null,
  clearAuth: async () => {},
  loadSession: async () => null,
}

class Manager extends MobileManagerBase {
  override platformDir() {
    return "wechat"
  }

  override platformName() {
    return "WeChat"
  }

  open(scope: string, directory: string) {
    this.activateScope(scope, directory)
  }

  close(scope: string) {
    this.deactivateScope(scope)
  }

  closeAll() {
    this.deactivateAllScopes()
  }
}

afterEach(() => {
  for (const item of dirs) ActiveInstance.forceDeactivate(item)
  dirs.length = 0
})

describe("mobile active instances", () => {
  test("uses a separate owner from browser leases", () => {
    const root = dir()
    const manager = new Manager(adapter)

    ActiveInstance.activateOwner("lease:web", root)
    manager.open("chat", root)

    manager.close("chat")
    expect(ActiveInstance.is(root)).toBe(true)

    ActiveInstance.deactivateOwner("lease:web")
    expect(ActiveInstance.is(root)).toBe(false)
  })

  test("moves a mobile scope between directories", () => {
    const first = dir()
    const second = dir()
    const manager = new Manager(adapter)

    manager.open("chat", first)
    expect(ActiveInstance.is(first)).toBe(true)

    manager.open("chat", second)
    expect(ActiveInstance.is(first)).toBe(false)
    expect(ActiveInstance.is(second)).toBe(true)

    manager.closeAll()
    expect(ActiveInstance.is(second)).toBe(false)
  })
})
