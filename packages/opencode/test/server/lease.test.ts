import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { ActiveInstance } from "../../src/project/active-instance"
import { Lease } from "../../src/server/lease"

const ids: string[] = []
const dirs: string[] = []

const id = () => {
  const value = `lease-${Math.random().toString(36).slice(2)}`
  ids.push(value)
  return value
}

const dir = () => {
  const value = `/tmp/opencode-lease-${Math.random().toString(36).slice(2)}`
  dirs.push(value)
  return value
}

afterEach(() => {
  for (const item of ids) Lease.drop(item)
  for (const item of dirs) ActiveInstance.forceDeactivate(item)
  ids.length = 0
  dirs.length = 0
})

describe("Lease", () => {
  test("does not double activate the same directory for one lease", () => {
    const lease = id()
    const root = dir()
    let activations = 0
    const off = ActiveInstance.subscribe((directory) => {
      if (directory === root) activations++
    })

    try {
      expect(Lease.touch(lease, root)).toBe(true)
      expect(Lease.touch(lease, root)).toBe(true)
      expect(ActiveInstance.is(root)).toBe(true)
      expect(activations).toBe(1)

      Lease.drop(lease)
      expect(ActiveInstance.is(root)).toBe(false)
    } finally {
      off()
    }
  })

  test("moves active ownership when a lease changes directory", () => {
    const lease = id()
    const first = dir()
    const second = dir()

    Lease.touch(lease, first)
    expect(ActiveInstance.is(first)).toBe(true)

    Lease.touch(lease, second)
    expect(ActiveInstance.is(first)).toBe(false)
    expect(ActiveInstance.is(second)).toBe(true)

    Lease.drop(lease)
    expect(ActiveInstance.is(second)).toBe(false)
  })

  test("expires directory ownership and can reactivate on a later ping", () => {
    const lease = id()
    const root = dir()
    const now = spyOn(Date, "now")

    try {
      now.mockReturnValue(1_000)
      Lease.touch(lease, root)
      expect(ActiveInstance.is(root)).toBe(true)

      now.mockReturnValue(32_000)
      expect(Lease.count()).toBe(0)
      expect(ActiveInstance.is(root)).toBe(false)

      now.mockReturnValue(33_000)
      Lease.touch(lease, root)
      expect(ActiveInstance.is(root)).toBe(true)
    } finally {
      now.mockRestore()
    }
  })
})
