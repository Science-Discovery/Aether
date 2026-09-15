import { expect, test } from "bun:test"
import path from "node:path"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"

test("subscription metadata refresh reaches provider models and Responses requests", async () => {
  await using tmp = await tmpdir()
  const state = {
    stage: 0,
    requests: [] as { body: Record<string, unknown>; authorization: string | null; account: string | null }[],
    catalogs: [] as { authorization: string | null; account: string | null; version: string | null }[],
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      if (url.pathname === "/registry") return Response.json({ version: "0.154.0" })
      if (url.pathname === "/next") {
        state.stage++
        return Response.json({ stage: state.stage })
      }
      if (url.pathname === "/models") {
        state.catalogs.push({
          authorization: req.headers.get("authorization"),
          account: req.headers.get("chatgpt-account-id"),
          version: url.searchParams.get("client_version"),
        })
        const model = (slug: string) => ({
          slug,
          visibility: "list",
          display_name: state.stage ? "Subscription updated" : "Subscription initial",
          context_window: state.stage ? 256000 : 96000,
          input_modalities: state.stage ? ["text"] : ["text", "image"],
          default_reasoning_level:
            state.stage === 4 ? "medium" : state.stage === 5 ? undefined : state.stage ? "ultra" : "high",
          supported_reasoning_levels: (state.stage === 0
            ? ["low", "high"]
            : state.stage < 3
              ? ["high", "ultra", "future"]
              : ["ultra", "future"]
          ).map((effort) => ({ effort })),
        })
        return Response.json({
          models: [
            model("gpt-5"),
            ...(state.stage < 3 ? [model("gpt-subscription-removed")] : []),
            ...(state.stage === 2 ? [model("gpt-subscription-only")] : []),
            { ...model("gpt-subscription-hidden"), visibility: "hide" },
          ],
        })
      }
      if (url.pathname === "/api.json") {
        const model = (id: string) => ({
          id,
          name: "Catalog name",
          description: "Subscription metadata integration fixture",
          release_date: "2026-09-15",
          last_updated: "2026-09-15",
          open_weights: false,
          attachment: false,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          temperature: false,
          tool_call: true,
          limit: { context: 128000, input: 120000, output: 8192 },
          modalities: { input: ["text"], output: ["text"] },
          cost: { input: 1, output: 2 },
        })
        return Response.json({
          openai: {
            id: "openai",
            name: "OpenAI",
            doc: "https://example.com/docs",
            env: ["OPENAI_API_KEY"],
            npm: "@ai-sdk/openai",
            api: `${url.origin}/api`,
            models: Object.fromEntries(
              ["gpt-5", "gpt-subscription-removed", "gpt-api-only"].map((id) => [id, model(id)]),
            ),
          },
        })
      }
      if (url.pathname !== "/api/responses") return new Response("not found", { status: 404 })
      const body = await req.json()
      state.requests.push({
        body,
        authorization: req.headers.get("authorization"),
        account: req.headers.get("chatgpt-account-id"),
      })
      return new Response(
        [
          {
            type: "response.created",
            response: { id: "resp-1", created_at: 1, model: body.model, service_tier: null },
          },
          { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-1" } },
          { type: "response.output_text.delta", item_id: "item-1", delta: "Hello", logprobs: null },
          { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "item-1" } },
          {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null },
              service_tier: null,
            },
          },
        ]
          .map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    },
  })
  try {
    const result = await Process.run(
      [process.execPath, "run", path.join(import.meta.dir, "fixtures/codex-reasoning.ts"), tmp.path],
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
          OPENAI_API_KEY: undefined,
        },
        abort: AbortSignal.timeout(30_000),
        nothrow: true,
      },
    )
    expect({ code: result.code, stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toMatchObject({
      code: 0,
      stdout: expect.stringContaining("subscription metadata refresh verified"),
    })
    expect(state.catalogs.length).toBeGreaterThanOrEqual(4)
    expect(state.catalogs.every((item) => item.authorization === "Bearer subscription-access")).toBe(true)
    expect(state.catalogs.every((item) => item.account === "subscription-account")).toBe(true)
    expect(state.catalogs.every((item) => item.version === "0.154.0")).toBe(true)
    expect(state.requests.map((item) => (item.body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
      "ultra",
      "future",
      "ultra",
      undefined,
      undefined,
    ])
    expect(state.requests.map((item) => item.body.model)).toEqual([
      "gpt-5",
      "gpt-5",
      "gpt-subscription-only",
      "gpt-5",
      "gpt-5",
    ])
    expect(state.requests.every((item) => item.authorization === "Bearer subscription-access")).toBe(true)
    expect(state.requests.every((item) => item.account === "subscription-account")).toBe(true)
  } finally {
    server.stop(true)
  }
}, 35_000)
