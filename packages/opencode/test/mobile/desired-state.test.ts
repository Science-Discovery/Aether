import { describe, expect, test } from "bun:test"
import { join } from "path"
import { MobileManagerBase } from "../../src/mobile/base"
import type { MobileAdapter } from "../../src/mobile/base"
import { tmpdir } from "../fixture/fixture"

const adapter: MobileAdapter = {
  platform: "wechat",
  replyText: async () => {},
  replyFile: async () => {},
  loadConfig: async () => null,
  clearAuth: async () => {},
  loadSession: async () => null,
}

class Manager extends MobileManagerBase {
  constructor(
    private root: string,
    cfg?: unknown,
  ) {
    super({ ...adapter, loadConfig: async () => cfg ?? null })
  }

  override platformDir() {
    return "wechat"
  }

  override platformName() {
    return "WeChat"
  }

  override dir() {
    return this.root
  }

  override file(name: string) {
    return join(this.root, name)
  }

  busUnsubCount() {
    return this._busUnsubs.length
  }

  hasGlobalListener() {
    return this._globalBusListener !== null
  }

  subscribeBus() {
    this.subscribeBusEvents()
  }

  unsubscribeBus() {
    this.unsubscribeBusEvents()
  }
}

describe("mobile desired state", () => {
  test("defaults to disabled when no state file exists", async () => {
    await using tmp = await tmpdir()
    const manager = new Manager(tmp.path)
    expect(await manager.desired()).toBe(false)
    expect(await manager.hasCredentials()).toBe(false)
  })

  test("persists enable and disable across instances", async () => {
    await using tmp = await tmpdir()
    await new Manager(tmp.path).setDesired(true)
    expect(await new Manager(tmp.path).desired()).toBe(true)
    await new Manager(tmp.path).setDesired(false)
    expect(await new Manager(tmp.path).desired()).toBe(false)
  })

  test("hasCredentials follows adapter config", async () => {
    await using tmp = await tmpdir()
    expect(await new Manager(tmp.path).hasCredentials()).toBe(false)
    expect(await new Manager(tmp.path, { appId: "a" }).hasCredentials()).toBe(true)
  })

  test("subscribeBusEvents is idempotent and cleans up fully", () => {
    const manager = new Manager("/tmp/unused")
    manager.subscribeBus()
    manager.subscribeBus()
    manager.subscribeBus()
    expect(manager.busUnsubCount()).toBe(2)
    expect(manager.hasGlobalListener()).toBe(true)
    manager.unsubscribeBus()
    expect(manager.busUnsubCount()).toBe(0)
    expect(manager.hasGlobalListener()).toBe(false)
  })
})
