import { expect, test } from "bun:test"
import path from "path"
import { Provider } from "../../src/provider/provider"
import type { ModelsDev } from "../../src/provider/models"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { reply } from "../lib/llm"

test.each([
  { name: "missing metadata falls back to legacy variants", options: undefined, expected: ["high", "max"] },
  { name: "empty metadata disables legacy variants", options: [], expected: [] },
  {
    name: "metadata replaces legacy variants",
    options: [{ type: "effort", values: ["low"] }],
    expected: ["low"],
  },
] satisfies { name: string; options: ModelsDev.Model["reasoning_options"]; expected: string[] }[])(
  "$name",
  ({ options, expected }) => {
    const provider = Provider.fromModelsDevProvider({
      id: "deepseek",
      name: "DeepSeek",
      env: ["DEEPSEEK_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.deepseek.com",
      models: {
        "deepseek-v4-pro": {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          attachment: false,
          reasoning: true,
          reasoning_options: options,
          temperature: true,
          tool_call: true,
          release_date: "2026-07-13",
          limit: { context: 128000, output: 8192 },
          options: {},
        },
      },
    })

    expect(Object.keys(provider.models["deepseek-v4-pro"].variants ?? {})).toEqual(expected)
  },
)

test("catalog refresh updates reasoning variants and SDK requests without restarting the instance", async () => {
  await using tmp = await tmpdir()
  const state = { values: ["low", "high"], requests: [] as Record<string, unknown>[] }
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      if (url.pathname === "/api.json") {
        return Response.json({
          deepseek: {
            id: "deepseek",
            name: "DeepSeek",
            doc: "https://example.com/docs",
            env: ["DEEPSEEK_API_KEY"],
            npm: "@ai-sdk/openai-compatible",
            api: `${url.origin}/v1`,
            models: {
              "deepseek-future": {
                id: "deepseek-future",
                name: "Future model unknown to Aether",
                description: "Catalog-driven reasoning fixture",
                release_date: "2026-09-15",
                last_updated: "2026-09-15",
                attachment: false,
                reasoning: true,
                reasoning_options: [{ type: "toggle" }, { type: "effort", values: state.values }],
                temperature: true,
                tool_call: true,
                limit: { context: 128000, output: 8192 },
                modalities: { input: ["text"], output: ["text"] },
                open_weights: false,
              },
            },
          },
        })
      }
      if (url.pathname === "/next") {
        state.values.splice(0, state.values.length, "high", "max")
        return new Response("updated")
      }
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      state.requests.push(await req.json())
      return reply("chat")
    },
  })
  try {
    // Flags and catalog caches are process-scoped. Keep the normal test fixture and
    // the user's configuration isolated while exercising the real refresh path.
    const result = await Process.run(
      [process.execPath, "run", path.join(import.meta.dir, "fixtures/reasoning.ts"), tmp.path],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
          OPENCODE_TEST_HOME: path.join(tmp.path, "home"),
          OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(tmp.path, "managed"),
          OPENCODE_MODELS_PATH: undefined,
          OPENCODE_MODELS_URL: server.url.origin,
          OPENCODE_CONFIG: undefined,
          OPENCODE_CONFIG_CONTENT: undefined,
          OPENCODE_CONFIG_DIR: undefined,
          OPENCODE_DISABLE_MODELS_FETCH: "true",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          OPENCODE_DISABLE_CLAUDE_CODE: "true",
          OPENCODE_DB: ":memory:",
        },
        abort: AbortSignal.timeout(30_000),
      },
    )

    expect({ code: result.code, stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("reasoning catalog refresh verified"),
    })
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].model).toBe("deepseek-future")
    expect(state.requests[0].reasoning_effort).toBe("max")
    expect(state.requests[0].reasoningEffort).toBeUndefined()
    expect(state.requests[0].thinking).toEqual({ type: "enabled" })
  } finally {
    server.stop(true)
  }
}, 35_000)
