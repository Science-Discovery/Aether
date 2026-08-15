import { describe, expect, test } from "bun:test"
import { MessageOrder } from "./message-order"

const item = (id: string, created: number) => ({ id, time: { created } })

describe("MessageOrder", () => {
  test("orders messages by creation time across an ID rollover", () => {
    const old = item("msg_fe000000000000000000000000", 1)
    const next = item("msg_00000000000000000000000000", 2)

    expect(MessageOrder.sort([next, old])).toEqual([old, next])
    expect(MessageOrder.insert([old], next)).toBe(1)
  })

  test("uses array position for message boundaries", () => {
    const items = [item("msg_fe", 1), item("msg_00", 2), item("msg_01", 3)]

    expect(MessageOrder.before(items, "msg_00").map((x) => x.id)).toEqual(["msg_fe"])
    expect(MessageOrder.from(items, "msg_00").map((x) => x.id)).toEqual(["msg_00", "msg_01"])
    expect(MessageOrder.prev(items, "msg_00")?.id).toBe("msg_fe")
    expect(MessageOrder.next(items, "msg_00")?.id).toBe("msg_01")
  })
})
