import { describe, expect, test } from "bun:test"
import { hasPendingRequest } from "./session-pending"

function session(id: string, parentID?: string) {
  return { id, parentID } as any
}

type Getter = (sid: string) => unknown[] | undefined

const undef = () => undefined
const empty = () => [] as unknown[]
const filled = () => [{}] as unknown[]

describe("hasPendingRequest", () => {
  test("no children, rootID has no request", () => {
    expect(hasPendingRequest([session("root")], "root", undef, undef)).toBe(false)
  })

  test("direct child has pending permission", () => {
    expect(
      hasPendingRequest(
        [session("root"), session("child", "root")],
        "root",
        (sid) => (sid === "child" ? filled() : undef()),
        undef,
      ),
    ).toBe(true)
  })

  test("direct child has pending question", () => {
    expect(
      hasPendingRequest([session("root"), session("child", "root")], "root", undef, (sid) =>
        sid === "child" ? filled() : undef(),
      ),
    ).toBe(true)
  })

  test("nested grandchild has pending request", () => {
    expect(
      hasPendingRequest(
        [session("root"), session("child", "root"), session("grand", "child")],
        "root",
        (sid) => (sid === "grand" ? filled() : undef()),
        undef,
      ),
    ).toBe(true)
  })

  test("child request resolved (empty array)", () => {
    expect(
      hasPendingRequest(
        [session("root"), session("child", "root")],
        "root",
        (sid) => (sid === "child" ? empty() : undef()),
        undef,
      ),
    ).toBe(false)
  })

  test("empty rootID", () => {
    expect(hasPendingRequest([session("root")], "", undef, undef)).toBe(false)
  })

  test("non-global-sync DataProvider (undefined getters)", () => {
    expect(hasPendingRequest([session("root"), session("child", "root")], "root", undef, undef)).toBe(false)
  })

  test("multiple children, only one has request", () => {
    expect(
      hasPendingRequest(
        [session("root"), session("a", "root"), session("b", "root")],
        "root",
        (sid) => (sid === "b" ? filled() : undef()),
        undef,
      ),
    ).toBe(true)
  })

  test("rootID itself has request", () => {
    expect(hasPendingRequest([session("root")], "root", (sid) => (sid === "root" ? filled() : undef()), undef)).toBe(
      true,
    )
  })
})
