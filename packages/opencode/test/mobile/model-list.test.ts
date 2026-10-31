import { afterEach, expect, test } from "bun:test"
import { MobileManagerBase } from "../../src/mobile/base"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

class Manager extends MobileManagerBase {
  platformDir() {
    return ""
  }
  platformName() {
    return "Test"
  }
  list(dir: string) {
    this._initialDir = dir
    return this.buildModelList()
  }
}

afterEach(() => Instance.disposeAll())

test("mobile model selection lists only connected, enabled chat models", async () => {
  await using tmp = await tmpdir({
    config: {
      enabled_providers: ["local", "offline"],
      disabled_models: ["local/disabled"],
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "local-test-key", baseURL: "http://127.0.0.1:1/v1" },
          models: {
            chat: { name: "Chat" },
            disabled: { name: "Disabled" },
            voice: { name: "Voice", modalities: { input: ["text"], output: ["audio"] } },
          },
        },
        offline: { models: { chat: { name: "Offline Chat" } } },
      },
    },
  })
  const manager = new Manager({
    platform: "qq",
    replyText: async () => {},
    replyFile: async () => {},
    clearAuth: async () => {},
    loadConfig: async () => null,
    loadSession: async () => null,
  })
  const entries = await manager.list(tmp.path)
  expect(entries.map((entry) => `${entry.providerID}/${entry.modelID}`)).toEqual(["local/chat"])
  expect(entries[0]?.isDefault).toBe(true)
})
