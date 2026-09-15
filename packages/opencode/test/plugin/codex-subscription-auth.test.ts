import { afterEach, expect, spyOn, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { CodexAuthPlugin } from "../../src/plugin/codex"
import { CodexModels } from "../../src/plugin/codex-models"
import { Provider } from "../../src/provider/provider"

type Credential = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  accountId?: string
}

const cleanup = new Set<() => void>()

afterEach(() => {
  CodexModels.Test.reset()
  for (const stop of cleanup) stop()
  cleanup.clear()
})

function token(sub: string, account?: string) {
  return `header.${Buffer.from(JSON.stringify({ sub, chatgpt_account_id: account })).toString("base64url")}.signature`
}

async function setup(initial: Credential, access = initial.access) {
  let auth: Credential | { type: "api"; key: string } | undefined = initial
  const calls: { authorization: string | null; account: string | null }[] = []
  let rotations = 0
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/token") {
        rotations++
        return Response.json({
          access_token: access,
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        })
      }
      calls.push({
        authorization: request.headers.get("authorization"),
        account: request.headers.get("chatgpt-account-id"),
      })
      return Response.json({ models: [{ slug: "future", visibility: "list", display_name: "Account model" }] })
    },
  })
  cleanup.add(() => server.stop(true))
  const fetcher = globalThis.fetch
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString()
        if (url === CodexModels.REGISTRY) return Promise.resolve(Response.json({ version: "0.154.0" }))
        if (url.startsWith(CodexModels.URL)) return fetcher(new URL("/models", server.url), init)
        if (url === "https://auth.openai.com/oauth/token") return fetcher(new URL("/token", server.url), init)
        throw new Error(`Unexpected test request: ${url}`)
      },
      { preconnect: fetcher.preconnect },
    ),
  )
  cleanup.add(() => request.mockRestore())
  const hooks = await CodexAuthPlugin({
    client: {
      auth: {
        async set(input: { body: Credential }) {
          auth = input.body
        },
      },
    },
  } as unknown as PluginInput)
  const load = hooks.auth?.loader
  if (!load) throw new Error("missing codex auth loader")
  await load(
    async () => auth as Awaited<ReturnType<Parameters<typeof load>[0]>>,
    Provider.fromModelsDevProvider({
      id: "openai",
      name: "OpenAI",
      env: [],
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      models: {},
    }) as unknown as Parameters<typeof load>[1],
  )
  await CodexModels.refresh({ force: true })
  return {
    calls,
    rotations: () => rotations,
    auth: () => auth,
    set(value: typeof auth) {
      auth = value
    },
  }
}

test.each(["account", "subject"])(
  "rejects a different subscription %s before sending its credentials",
  async (kind) => {
    const initial: Credential = {
      type: "oauth",
      access: kind === "subject" ? token(crypto.randomUUID()) : "access",
      refresh: crypto.randomUUID(),
      expires: Date.now() + 60_000,
      ...(kind === "account" ? { accountId: crypto.randomUUID() } : {}),
    }
    const state = await setup(initial)
    expect(state.calls).toHaveLength(1)
    state.set({
      ...initial,
      access: kind === "subject" ? token("new-subject") : "new-access",
      ...(kind === "account" ? { accountId: "new-account" } : {}),
    })
    const result = await CodexModels.refresh({ force: true })
    expect(result.error).toContain("subscription account changed")
    expect(state.calls).toHaveLength(1)
    expect(CodexModels.metadata("future")).toEqual({ display_name: "Account model" })
  },
)

test.each([true, false])("allows token rotation with stable identity present=%s", async (known) => {
  const state = await setup({
    type: "oauth",
    access: "access",
    refresh: crypto.randomUUID(),
    expires: 0,
    ...(known ? { accountId: crypto.randomUUID() } : {}),
  })
  expect(CodexModels.status().error).toBeNull()
  expect(state.rotations()).toBe(1)
  expect(state.auth()).toMatchObject({ refresh: "rotated-refresh" })
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0].authorization).toBe("Bearer access")
  await CodexModels.refresh({ force: true })
  expect(CodexModels.status().error).toBeNull()
  expect(state.rotations()).toBe(1)
  expect(state.calls).toHaveLength(2)
})

test("keeps comparing the subject when rotation first discovers an account ID", async () => {
  const subject = crypto.randomUUID()
  const account = crypto.randomUUID()
  const state = await setup(
    { type: "oauth", access: token(subject), refresh: crypto.randomUUID(), expires: 0 },
    token(subject, account),
  )
  expect(state.rotations()).toBe(1)
  expect(state.auth()).toMatchObject({ accountId: account, refresh: "rotated-refresh" })
  expect(CodexModels.status().error).toBeNull()
  expect(state.calls).toHaveLength(1)
  expect(state.calls[0].account).toBe(account)
  await CodexModels.refresh({ force: true })
  expect(CodexModels.status().error).toBeNull()
  expect(state.calls).toHaveLength(2)
})

test("uses a JWT account ID for cache identity before it is stored in auth", async () => {
  const subject = crypto.randomUUID()
  const account = crypto.randomUUID()
  const initial: Credential = {
    type: "oauth",
    access: token(subject, account),
    refresh: crypto.randomUUID(),
    expires: Date.now() + 60_000,
  }
  const state = await setup(initial)
  expect(CodexModels.status().error).toBeNull()
  expect(await Bun.file(CodexModels.Test.filepath(CodexModels.Test.key(account))).exists()).toBe(true)
  expect(await Bun.file(CodexModels.Test.filepath(CodexModels.Test.key(subject))).exists()).toBe(false)
  state.set({ ...initial, accountId: account })
  await CodexModels.refresh({ force: true })
  expect(CodexModels.status().error).toBeNull()
  expect(state.calls).toHaveLength(2)
  state.set({ ...initial, access: token(subject, "different-account") })
  const result = await CodexModels.refresh({ force: true })
  expect(result.error).toContain("subscription account changed")
  expect(state.calls).toHaveLength(2)
})

test.each(["logout", "api"])("stops subscription refresh after %s without sending credentials", async (mode) => {
  const state = await setup({
    type: "oauth",
    access: "access",
    refresh: crypto.randomUUID(),
    expires: Date.now() + 60_000,
    accountId: crypto.randomUUID(),
  })
  state.set(mode === "api" ? { type: "api", key: "api-key" } : undefined)
  const result = await CodexModels.refresh({ force: true })
  expect(result.error).toContain("OAuth is no longer active")
  expect(state.calls).toHaveLength(1)
  expect(CodexModels.metadata("future")).toEqual({ display_name: "Account model" })
})
