import { describe, expect, test } from "bun:test"
import { createMobileRoutes } from "../../src/mobile/route"

describe("mobile route schemas", () => {
  test("wechat status response carries no lock fields", async () => {
    const res = await createMobileRoutes("wechat").request("/status")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect("locked" in data).toBe(false)
    expect("lockHolder" in data).toBe(false)
    expect("status" in data).toBe(true)
    expect("enabled" in data).toBe(true)
  })

  test("qq status response stays intact", async () => {
    const res = await createMobileRoutes("qq").request("/status")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect("appId" in data).toBe(true)
    expect("hasConfig" in data).toBe(true)
    expect("status" in data).toBe(true)
  })
})
