import { describe, expect, test } from "bun:test"
import { OpenIntent } from "./open-intent"

describe("open intent", () => {
  test("consumes an explicit directory intent once", () => {
    OpenIntent.mark("once", "/project")
    expect(OpenIntent.consume("once", "/project")).toBe(true)
    expect(OpenIntent.consume("once", "/project")).toBe(false)
  })

  test("only authorizes the latest target on each server", () => {
    OpenIntent.mark("latest", "/previous")
    OpenIntent.mark("latest", "/next")
    expect(OpenIntent.consume("latest", "/next")).toBe(true)
    expect(OpenIntent.consume("latest", "/previous")).toBe(false)
  })

  test("discards an intent when the next directory navigation goes elsewhere", () => {
    OpenIntent.mark("changed", "/previous")
    expect(OpenIntent.consume("changed", "/next")).toBe(false)
    expect(OpenIntent.consume("changed", "/previous")).toBe(false)
  })

  test("keeps server intents isolated", () => {
    OpenIntent.mark("local", "/project")
    OpenIntent.mark("remote", "/project")
    expect(OpenIntent.consume("third", "/project")).toBe(false)
    expect(OpenIntent.consume("local", "/project")).toBe(true)
    expect(OpenIntent.consume("remote", "/project")).toBe(true)
  })

  test("clears only the departing server", () => {
    OpenIntent.mark("leaving", "/project")
    OpenIntent.mark("remaining", "/project")
    OpenIntent.clear("leaving")
    expect(OpenIntent.consume("leaving", "/project")).toBe(false)
    expect(OpenIntent.consume("remaining", "/project")).toBe(true)
  })
})
