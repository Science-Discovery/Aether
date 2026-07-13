import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"
import type { PluginInput } from "@opencode-ai/plugin"
import { Provider } from "../../src/provider/provider"
import type { ModelsDev } from "../../src/provider/models"
import { CodexModels } from "../../src/plugin/codex-models"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

const base: ModelsDev.Model = {
  id: "gpt-5",
  name: "GPT-5",
  release_date: "2026-01-01",
  attachment: true,
  reasoning: true,
  temperature: false,
  tool_call: true,
  limit: {
    context: 128000,
    output: 8192,
  },
  modalities: {
    input: ["text"],
    output: ["text"],
  },
  cost: {
    input: 1,
    output: 2,
  },
  options: {},
}

function model(id: string): ModelsDev.Model {
  return {
    ...base,
    id,
    name: id,
  }
}

describe("plugin.codex", () => {
  afterEach(() => CodexModels.Test.reset())

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  describe("auth loader", () => {
    test("uses the built-in fallback before the first valid remote catalog", async () => {
      const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("offline", { status: 503 }))
      const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
      const load = hooks.auth?.loader
      if (!load) throw new Error("missing codex auth loader")

      const prov = Provider.fromModelsDevProvider({
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          "gpt-5": model("gpt-5"),
          "gpt-5.4": model("gpt-5.4"),
          "gpt-5.5": model("gpt-5.5"),
          "gpt-5.5-pro": model("gpt-5.5-pro"),
          "gpt-5.6-codex": model("gpt-5.6-codex"),
        },
      })

      try {
        await load(
          async () => ({
            type: "oauth",
            refresh: "refresh",
            access: "access",
            expires: Date.now() + 60_000,
          }),
          prov as unknown as Parameters<typeof load>[1],
        )
        await CodexModels.refresh({ force: true })

        expect(Object.keys(prov.models).sort()).toEqual([
          "gpt-5.3-codex",
          "gpt-5.4",
          "gpt-5.5",
          "gpt-5.5-pro",
          "gpt-5.6-codex",
        ])
        expect(prov.models["gpt-5.5"].cost.input).toBe(0)
        expect(prov.models["gpt-5.5-pro"].cost.output).toBe(0)
      } finally {
        request.mockRestore()
      }
    })

    test("uses remote slugs as the sole allowlist and matches model api ids", async () => {
      CodexModels.Test.prime({
        identity: "account",
        seed: "refresh",
        models: ["gpt-5.5", "gpt-5.6-sol"],
      })
      const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
      const load = hooks.auth?.loader
      if (!load) throw new Error("missing codex auth loader")

      const prov = Provider.fromModelsDevProvider({
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: {
          "gpt-5.5": model("gpt-5.5"),
          "gpt-5.6-codex": model("gpt-5.6-codex"),
          "aether-alias": model("aether-alias"),
        },
      })
      prov.models["aether-alias"].api.id = "gpt-5.6-sol"

      await load(
        async () =>
          ({
            type: "oauth",
            refresh: "refresh",
            access: "access",
            expires: Date.now() + 60_000,
            accountId: "account",
          }) as Awaited<ReturnType<Parameters<typeof load>[0]>>,
        prov as unknown as Parameters<typeof load>[1],
      )

      expect(Object.keys(prov.models).sort()).toEqual(["aether-alias", "gpt-5.5"])
      expect(prov.models["aether-alias"].cost.input).toBe(0)
    })

    test("authenticates catalog requests with the current subscription account", async () => {
      const request = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            models: [{ slug: "gpt-5.5", visibility: "list", minimal_client_version: "0.144.0" }],
          }),
        ),
      )
      const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
      const load = hooks.auth?.loader
      if (!load) throw new Error("missing codex auth loader")
      const prov = Provider.fromModelsDevProvider({
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: { "gpt-5.5": model("gpt-5.5") },
      })

      try {
        await load(
          async () =>
            ({
              type: "oauth",
              refresh: "refresh",
              access: "access",
              expires: Date.now() + 60_000,
              accountId: "account",
            }) as Awaited<ReturnType<Parameters<typeof load>[0]>>,
          prov as unknown as Parameters<typeof load>[1],
        )
        await CodexModels.refresh({ force: true })

        const call = request.mock.calls.at(-1)
        const url = call?.[0]
        const headers = new Headers(call?.[1]?.headers)
        expect(url instanceof Request ? url.url : url?.toString()).toBe(CodexModels.URL)
        expect(headers.get("authorization")).toBe("Bearer access")
        expect(headers.get("chatgpt-account-id")).toBe("account")
      } finally {
        request.mockRestore()
      }
    })

    test("does not activate the subscription catalog for API keys", async () => {
      const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexpected"))
      const hooks = await CodexAuthPlugin({} as unknown as PluginInput)
      const load = hooks.auth?.loader
      if (!load) throw new Error("missing codex auth loader")
      const prov = Provider.fromModelsDevProvider({
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        npm: "@ai-sdk/openai",
        api: "https://api.openai.com/v1",
        models: { "gpt-5.5": model("gpt-5.5") },
      })

      try {
        await load(async () => ({ type: "api", key: "key" }), prov as unknown as Parameters<typeof load>[1])
        expect(request).not.toHaveBeenCalled()
        expect(CodexModels.status().enabled).toBe(false)
      } finally {
        request.mockRestore()
      }
    })
  })
})
