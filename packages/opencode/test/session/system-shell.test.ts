import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { tmpdir } from "../fixture/fixture"

describe("session.system shell", () => {
  test("environment identifies the actual command shell", async () => {
    await using tmp = await tmpdir({
      config: { provider: { anthropic: { options: { apiKey: "test" } } } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel(ProviderID.anthropic, ModelID.make("claude-sonnet-4-20250514"))
        const prompt = await SystemPrompt.environment(model)
        expect(prompt.join("\n")).toContain(`  Shell: ${Shell.acceptable()}`)
      },
    })
  })
})
