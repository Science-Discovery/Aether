import { test, expect } from "bun:test"
import { Journal } from "../integration/app/journal"

const storage = () => {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}
test("lost A reply, successful B, reload and retry A retain its original request key", () => {
  const disk = storage()
  const queue = new Journal("test", disk)
  const a = queue.claim("A", "first task")
  const b = queue.claim("B", "second task")
  queue.accepted("B", b.key)
  const reload = new Journal("test", disk)
  expect(reload.claim("A", "first task").key).toBe(a.key)
  expect(reload.get("B")).toBeUndefined()
  expect(() => reload.claim("A", "changed task")).toThrow("尚未确认")
  reload.accepted("A", "stale-response-key")
  expect(reload.get("A")?.key).toBe(a.key)
  reload.accepted("A", a.key)
  expect(reload.claim("A", "changed task").key).not.toBe(a.key)
})

test("storage failure never permits an unpersisted request, including retries", () => {
  let failing = true
  const disk = storage()
  const queue = new Journal("test", { getItem: disk.getItem, setItem: (key, value) => {
    if (failing) throw new Error("QuotaExceededError")
    disk.setItem(key, value)
  } })
  expect(() => queue.claim("A", "text")).toThrow("QuotaExceededError")
  expect(() => queue.claim("A", "text")).toThrow("QuotaExceededError")
  expect(queue.get("A")).toBeUndefined()
  failing = false
  const request = queue.claim("A", "text")
  failing = true
  expect(() => queue.accepted("A", request.key)).toThrow("QuotaExceededError")
  expect(queue.get("A")?.key).toBe(request.key)
  expect(new Journal("test", disk).get("A")?.key).toBe(request.key)
})
