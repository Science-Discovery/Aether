import { afterEach, describe, expect, test } from "bun:test"
import { ActiveInstance } from "../../src/project/active-instance"
import { MobileManagerBase } from "../../src/mobile/base"
import type { MobileAdapter } from "../../src/mobile/base"
import { tmpdir } from "../fixture/fixture"

const dirs: string[] = []

const dir = async () => {
  const tmp = await tmpdir()
  dirs.push(tmp.path)
  return tmp
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
  test("uses a separate owner from browser leases", async () => {
    await using root = await dir()
    const manager = new Manager(adapter)

    ActiveInstance.activateOwner("lease:web", root.path)
    manager.open("chat", root.path)

    manager.close("chat")
    expect(ActiveInstance.is(root.path)).toBe(true)

    ActiveInstance.deactivateOwner("lease:web")
    expect(ActiveInstance.is(root.path)).toBe(false)
  })

  test("moves a mobile scope between directories", async () => {
    await using first = await dir()
    await using second = await dir()
    const manager = new Manager(adapter)

    manager.open("chat", first.path)
    expect(ActiveInstance.is(first.path)).toBe(true)

    manager.open("chat", second.path)
    expect(ActiveInstance.is(first.path)).toBe(false)
    expect(ActiveInstance.is(second.path)).toBe(true)

    manager.closeAll()
    expect(ActiveInstance.is(second.path)).toBe(false)
  })
})
