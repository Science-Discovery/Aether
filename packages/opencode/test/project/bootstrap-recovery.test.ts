import { afterAll, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const real = await import("../../src/session/recovery")
const realRepair = real.SessionRecovery.repairInterrupted
const realRepairSession = real.SessionRecovery.repairSession

let blocked: Promise<void> | undefined
const repair = mock(() => blocked ?? realRepair())

mock.module("../../src/session/recovery", () => ({
  SessionRecovery: {
    repairInterrupted: repair,
    repairSession: realRepairSession,
  },
}))

const { InstanceBootstrap } = await import("../../src/project/bootstrap")

afterAll(() => {
  blocked = undefined
})

describe("InstanceBootstrap crash repair", () => {
  test("starts repair in the background without blocking boot", async () => {
    repair.mockClear()
    await using tmp = await tmpdir({ git: true })
    let release = () => {}
    blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      let done = false
      await Instance.provide({
        directory: tmp.path,
        init: InstanceBootstrap,
        fn: async () => {
          done = true
        },
      })
      expect(done).toBe(true)
      expect(repair).toHaveBeenCalledTimes(1)
    } finally {
      release()
      blocked = undefined
    }
  })
})
