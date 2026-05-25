import { describe, expect, test } from "bun:test"
import { dismissKeys, shouldNotify } from "./request-alert"

describe("shouldNotify", () => {
  test("skips the current session request", () => {
    expect(
      shouldNotify({
        current_dir: "/tmp/project",
        current_session: "root",
        dir: "/tmp/project",
        session_id: "root",
      }),
    ).toBe(false)
  })

  test("notifies for a child session request", () => {
    expect(
      shouldNotify({
        current_dir: "/tmp/project",
        current_session: "root",
        dir: "/tmp/project",
        session_id: "child",
      }),
    ).toBe(true)
  })

  test("notifies for a parent session request", () => {
    expect(
      shouldNotify({
        current_dir: "/tmp/project",
        current_session: "child",
        dir: "/tmp/project",
        session_id: "root",
      }),
    ).toBe(true)
  })
})

describe("dismissKeys", () => {
  test("only clears the current session alert", () => {
    expect(
      dismissKeys({
        current_dir: "/tmp/project",
        current_session: "root",
      }),
    ).toEqual(["/tmp/project:root"])
  })

  test("returns no keys without a current session", () => {
    expect(
      dismissKeys({
        current_dir: "/tmp/project",
      }),
    ).toEqual([])
  })
})
