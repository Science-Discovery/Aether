import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { remoteHref } from "./remote-landing"

describe("remoteHref", () => {
  test("prefers landing session when present", () => {
    expect(
      remoteHref({
        rootDirectory: "/remote",
        directory: "/remote",
        sessionID: "sess_1",
        workspaceID: null,
      }),
    ).toBe(`/${base64Encode("/remote")}/session/sess_1`)
  })

  test("falls back to directory session root", () => {
    expect(
      remoteHref({
        rootDirectory: "/remote",
        directory: "/remote/project",
        sessionID: null,
        workspaceID: null,
      }),
    ).toBe(`/${base64Encode("/remote/project")}/session`)
  })
})
