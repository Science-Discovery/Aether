import { expect, test } from "bun:test"
import { NativeCompact } from "../../src/native/compact"

test("compaction completion requires a new matching compaction turn, not an acknowledgement or old event", async () => {
  const tracker = NativeCompact.track("thread", ["old"])
  let complete = false
  void tracker.promise.then(() => {
    complete = true
  })
  tracker.notify("turn/completed", {
    threadId: "thread",
    turn: { id: "new", status: "completed", items: [{ id: "compact", type: "contextCompaction" }] },
  })
  await Promise.resolve()
  expect(complete).toBe(false)
  tracker.arm()
  tracker.notify("turn/completed", {
    threadId: "other",
    turn: { id: "new", status: "completed", items: [{ id: "compact", type: "contextCompaction" }] },
  })
  tracker.notify("turn/completed", {
    threadId: "thread",
    turn: { id: "old", status: "completed", items: [{ id: "compact", type: "contextCompaction" }] },
  })
  tracker.notify("item/completed", {
    threadId: "thread",
    turnId: "new",
    item: { id: "compact", type: "contextCompaction" },
  })
  await Promise.resolve()
  expect(complete).toBe(false)
  tracker.notify("turn/completed", { threadId: "thread", turn: { id: "new", status: "completed" } })
  await tracker.promise
  expect(complete).toBe(true)
})

test("compaction tracks terminal turn payloads even when item notifications are absent", async () => {
  const tracker = NativeCompact.track("thread", [])
  tracker.arm()
  tracker.notify("turn/completed", {
    threadId: "thread",
    turn: { id: "compact-turn", status: "completed", items: [{ id: "item", type: "contextCompaction" }] },
  })
  await tracker.promise
})

test("a different turn or failed compaction cannot be reported as success", async () => {
  const other = NativeCompact.track("thread", [])
  other.arm()
  other.notify("turn/completed", { threadId: "thread", turn: { id: "chat", status: "completed", items: [] } })
  await expect(other.promise).rejects.toThrow("another operation")
  const failed = NativeCompact.track("thread", [])
  failed.arm()
  failed.notify("item/started", {
    threadId: "thread",
    turnId: "compact",
    item: { id: "item", type: "contextCompaction" },
  })
  failed.notify("turn/completed", { threadId: "thread", turn: { id: "compact", status: "failed" } })
  await expect(failed.promise).rejects.toThrow("did not complete")
})

test("a disconnected compaction rejects without inventing completion", async () => {
  const tracker = NativeCompact.track("thread", [])
  tracker.arm()
  tracker.reject(new Error("disconnected"))
  tracker.notify("turn/completed", {
    threadId: "thread",
    turn: { id: "new", status: "completed", items: [{ id: "item", type: "contextCompaction" }] },
  })
  await expect(tracker.promise).rejects.toThrow("disconnected")
})
