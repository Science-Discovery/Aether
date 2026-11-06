import { expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { recover } from "../../../../src/cli/cmd/tui/component/prompt/recovery"
import type { PromptInfo } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { Provider } from "../../../../src/provider/provider"
import { ModelID, ProviderID } from "../../../../src/provider/schema"

const draft: PromptInfo = {
  input: "Keep this question [Image 1]",
  parts: [
    {
      type: "file",
      mime: "image/png",
      url: "data:image/png;base64,AAAA",
      source: { type: "file", path: "figure.png", text: { start: 19, end: 28, value: "[Image 1]" } },
    },
  ],
}

test.each(["prompt", "command"] as const)(
  "TUI %s handles real SDK model-rejection responses and preserves the draft",
  async (kind) => {
    for (const err of [
      new Provider.NoModelConfiguredError({ message: "No model configured" }),
      new Provider.ModelNotFoundError({
        providerID: ProviderID.opencode,
        modelID: ModelID.make("big-pickle"),
        suggestions: [],
      }),
    ]) {
      const paths: string[] = []
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          paths.push(new URL(req.url).pathname)
          return Response.json(err.toObject(), { status: 400 })
        },
      })
      try {
        const client = createOpencodeClient({ baseUrl: server.url.toString() })
        let current: PromptInfo = { input: "", parts: [] }
        const warnings: string[] = []
        const retained: PromptInfo[] = []
        const task =
          kind === "prompt"
            ? client.session.prompt(
                { sessionID: "ses_test", parts: [{ type: "text", text: draft.input }] },
                { throwOnError: true },
              )
            : client.session.command(
                { sessionID: "ses_test", command: "test", arguments: draft.input },
                { throwOnError: true },
              )
        await task.catch((err) => {
          expect(
            recover(err, {
              current: 1,
              expected: 1,
              active: true,
              empty: true,
              restore: () => {
                current = structuredClone(draft)
              },
              retain: () => {
                retained.push(draft)
              },
              warn: (message) => {
                warnings.push(message)
              },
            }),
          ).toBe(true)
        })

        expect(paths).toEqual([kind === "prompt" ? "/session/ses_test/message" : "/session/ses_test/command"])
        expect(current).toEqual(draft)
        expect(retained).toEqual([])
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toContain(
          err.name === "NoModelConfiguredError" ? "Connect a provider" : "selected model is unavailable",
        )
      } finally {
        server.stop(true)
      }
    }
  },
)

test.each([
  { current: 2, expected: 1, active: true, empty: true },
  { current: 1, expected: 1, active: true, empty: false },
  { current: 1, expected: 1, active: false, empty: true },
])("TUI retains rejected drafts without touching edited or destroyed inputs: %j", (state) => {
  let restored = false
  const retained: PromptInfo[] = []
  const warnings: string[] = []
  expect(
    recover(new Provider.NoModelConfiguredError({ message: "No model configured" }), {
      ...state,
      restore: () => {
        restored = true
      },
      retain: () => {
        retained.push(draft)
      },
      warn: (message) => {
        warnings.push(message)
      },
    }),
  ).toBe(true)
  expect(restored).toBe(false)
  expect(retained).toEqual([draft])
  expect(warnings[0]).toContain("prompt stash")
})

test("TUI leaves unrelated errors to the existing submit handler", () => {
  let calls = 0
  expect(
    recover(
      { name: "BusyError" },
      {
        current: 1,
        expected: 1,
        active: true,
        empty: true,
        restore: () => {
          calls += 1
        },
        retain: () => {
          calls += 1
        },
        warn: () => {
          calls += 1
        },
      },
    ),
  ).toBe(false)
  expect(calls).toBe(0)
})
