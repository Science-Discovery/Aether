import { expect, test } from "bun:test"
import { first, select, valid } from "../../../src/cli/cmd/tui/context/model"

const providers: Parameters<typeof first>[0] = [
  {
    id: "opencode",
    models: {
      disabled: { id: "disabled", disabled: true },
      audio: { id: "audio", capabilities: { input: { text: true }, output: { text: false } } },
    },
  },
  {
    id: "metadata",
    models: { model: { id: "model" } },
  },
  {
    id: "local",
    models: {
      disabled: { id: "disabled", disabled: true },
      audio: { id: "audio", modalities: { input: ["audio"], output: ["text"] } },
      chat: { id: "chat", capabilities: { input: { text: true }, output: { text: true } } },
      custom: { id: "custom" },
    },
  },
]

test("TUI model validity requires a connected enabled chat model", () => {
  const connected = ["opencode", "local"]
  expect(valid(providers, connected, { providerID: "opencode", modelID: "disabled" })).toBe(false)
  expect(valid(providers, connected, { providerID: "opencode", modelID: "audio" })).toBe(false)
  expect(valid(providers, connected, { providerID: "metadata", modelID: "model" })).toBe(false)
  expect(valid(providers, connected, { providerID: "local", modelID: "audio" })).toBe(false)
  expect(valid(providers, connected, { providerID: "local", modelID: "chat" })).toBe(true)
  expect(valid(providers, connected, { providerID: "local", modelID: "custom" })).toBe(true)
})

test("TUI fallback skips empty, non-chat and disconnected providers and invalid defaults", () => {
  expect(first(providers, ["opencode", "local"], { local: "disabled" }, true)).toEqual({
    providerID: "local",
    modelID: "chat",
  })
  expect(first(providers, ["opencode", "local"], { local: "custom" }, true)).toEqual({
    providerID: "local",
    modelID: "custom",
  })
  expect(first(providers, [], {}, true)).toBeUndefined()
  expect(first(providers, ["opencode"], {}, true)).toBeUndefined()
})

test("TUI waits for recent preferences before choosing any automatic paid fallback", () => {
  const connected = ["opencode", "local"]
  expect(first(providers, connected, {}, false)).toBeUndefined()
  expect(
    select(providers, connected, [
      () => ({ providerID: "local", modelID: "custom" }),
      () => first(providers, connected, {}, false),
    ]),
  ).toEqual({ providerID: "local", modelID: "custom" })
  expect(
    select(providers, connected, [
      () => ({ providerID: "opencode", modelID: "missing" }),
      () => first(providers, connected, {}, true),
    ]),
  ).toBeUndefined()
  expect(first(providers, connected, {}, true)).toEqual({ providerID: "local", modelID: "chat" })
})

test.each(["missing", "disabled", "audio"])("TUI old OpenCode %s choices block a paid fallback", (id) => {
  let calls = 0
  expect(
    select(
      providers,
      ["opencode", "local"],
      [
        () => ({ providerID: "opencode", modelID: id }),
        () => {
          calls += 1
          return { providerID: "local", modelID: "chat" }
        },
      ],
    ),
  ).toBeUndefined()
  expect(calls).toBe(0)
})

test("TUI explicit valid choices keep priority and other unavailable choices can be skipped", () => {
  expect(
    select(
      providers,
      ["local"],
      [
        () => ({ providerID: "metadata", modelID: "model" }),
        () => ({ providerID: "local", modelID: "custom" }),
        () => ({ providerID: "local", modelID: "chat" }),
      ],
    ),
  ).toEqual({ providerID: "local", modelID: "custom" })
})
