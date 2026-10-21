import { describe, expect, test } from "bun:test"
import { ModelsDev } from "../../src/provider/models"
import { normalize } from "../../src/provider/models-v2"

type Db = Record<string, { models: Record<string, Record<string, unknown>> }>

const fixture = await Bun.file(new URL("./fixtures/models-v2.json", import.meta.url)).json()
const text = await Bun.file(new URL("./fixtures/models-v2.json", import.meta.url)).text()

describe("models.dev v2 normalization", () => {
  test("maps the DeepSeek catalog to the v1 contract", () => {
    const db = normalize(fixture) as Db

    expect(db.deepseek.models["deepseek-flash"]).toMatchObject({
      id: "deepseek-flash",
      name: "DeepSeek V4.1 Flash 1017",
      attachment: true,
      reasoning: true,
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      tool_call: true,
      limit: { context: 1_048_576, output: 393_216 },
      cost: {
        input: 0.15,
        output: 0.6,
        reasoning: 0.6,
        cache_read: 0.003,
      },
      provider: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.deepseek.com",
      },
    })
    expect(db.deepseek.models["deepseek-flash"].future_field).toBeUndefined()
  })

  test("maps the Alibaba v2-only model", () => {
    const db = normalize(fixture) as Db
    const model = db["alibaba-cn"].models["deepseek-v4.1-flash-1017"]

    expect(model).toMatchObject({
      id: "deepseek-v4.1-flash-1017",
      name: "DeepSeek V4.1 Flash 1017",
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      limit: { context: 1_000_000, output: 384_000 },
      cost: {
        input: 0.283,
        output: 1.131,
        cache_read: 0.0283,
      },
      provider: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
    })
  })

  test("drops non-chat models and providers without a usable limit", () => {
    const db = normalize(fixture) as Db

    expect(db.images).toBeUndefined()
    expect(db.broken).toBeUndefined()
  })

  test("filters the v2 default effort value", () => {
    const model = structuredClone(fixture.deepseek.models["deepseek-flash"])
    model.capabilities.reasoning.effort = ["default", "low"]
    const db = normalize({
      deepseek: {
        ...fixture.deepseek,
        models: { "deepseek-flash": model },
      },
    }) as Db

    expect(db.deepseek.models["deepseek-flash"].reasoning_options).toEqual([
      { type: "toggle" },
      { type: "effort", values: ["low"] },
    ])
  })

  test("parses v2 through the remote schema", () => {
    const db = ModelsDev.Test.parse(text)

    expect(db["alibaba-cn"].models["deepseek-v4.1-flash-1017"]?.name).toBe("DeepSeek V4.1 Flash 1017")
    expect(db.deepseek.models["deepseek-flash"]?.cost?.input).toBe(0.15)
  })

  test("accepts additive v1 fields and drops non-chat entries", () => {
    const model = {
      id: "chat",
      name: "Chat",
      description: "A chat model",
      attachment: false,
      reasoning: false,
      tool_call: true,
      release_date: "2026-10-01",
      last_updated: "2026-10-01",
      modalities: { input: ["text"], output: ["text"] },
      open_weights: false,
      limit: { context: 128_000, output: 8_192 },
      canonical_model_id: "lab/chat",
      type: "chat",
    }
    const db = ModelsDev.Test.parse(
      JSON.stringify({
        demo: {
          id: "demo",
          name: "Demo",
          doc: "https://example.com/docs",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          api: "https://example.com/v1",
          models: {
            chat: model,
            image: { ...model, id: "image", name: "Image", type: "image" },
          },
        },
      }),
    )

    expect(db.demo.models.chat).toBeDefined()
    expect(db.demo.models.image).toBeUndefined()
  })
})
