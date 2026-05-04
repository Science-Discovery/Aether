import { afterAll, describe, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { ConfigPaths } from "../../src/config/paths"
import { Instance } from "../../src/project/instance"
import { LLM } from "../../src/session/llm"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

type State = "passed" | "failed" | "skipped"
type Kind =
  | "config-missing"
  | "auth-failed"
  | "network"
  | "provider-error"
  | "stream-incomplete"
  | "assertion-failed"

type Usage =
  | { state: "present"; value: unknown }
  | { state: "missing"; reason: string }
  | { state: "unsupported"; reason: string }

type Item = {
  provider: string
  type: string
  baseURL: string
  model: string
  case: string
  status: State
  ms: number
  text: number
  reasoning: number
  tools: number
  finish?: string
  usage: Usage
  error?: {
    kind: Kind
    message: string
  }
}

type Model = z.infer<typeof Model>
type Spec = z.infer<typeof Spec>
type Case = z.infer<typeof Case>

const Capability = z.enum(["reasoning", "temperature", "tool", "vision", "history"])
const Model = z.object({
  id: z.string().min(1),
  api_id: z.string().optional(),
  name: z.string().optional(),
  cases: z.array(z.string()).optional(),
  capabilities: z
    .object({
      reasoning: z.boolean().optional().default(false),
      temperature: z.boolean().optional().default(true),
      tool: z.boolean().optional().default(true),
      vision: z.boolean().optional().default(false),
      interleaved: z.enum(["reasoning_content", "reasoning_details"]).optional(),
    })
    .optional()
    .default({ reasoning: false, temperature: true, tool: true, vision: false }),
  limit: z
    .object({
      context: z.number().int().positive().optional().default(128_000),
      output: z.number().int().positive().optional().default(8_192),
    })
    .optional()
    .default({ context: 128_000, output: 8_192 }),
})
const Spec = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  type: z.string().optional().default("openai-compatible"),
  npm: z.string().optional().default("@ai-sdk/openai-compatible"),
  base_url: z.string().min(1),
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  cases: z.array(z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional().default({}),
  models: z.array(Model).min(1),
})
const ConfigFile = z.object({
  version: z.number().optional(),
  providers: z.array(Spec),
})
const Case = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  tier: z.enum(["P0", "P1"]).optional().default("P0"),
  target: z
    .object({
      providers: z.array(z.string()).optional(),
      models: z.array(z.string()).optional(),
    })
    .optional()
    .default({}),
  system: z.string().optional(),
  prompt: z.string().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system", "tool"]),
        content: z.unknown(),
      }),
    )
    .optional()
    .default([]),
  capabilities: z.array(Capability).optional().default([]),
  assert: z
    .object({
      non_empty: z.boolean().optional().default(true),
      contains: z.array(z.string()).optional(),
      tool_call: z.boolean().optional().default(false),
      reasoning: z.boolean().optional().default(false),
      endpoint: z.enum(["chat", "responses"]).optional(),
    })
    .optional()
    .default({ non_empty: true, tool_call: false, reasoning: false }),
})

const dir = path.join(import.meta.dir, "llm")
const local = process.env.OPENCODE_SYSTEM_LLM_CONFIG ?? path.join(dir, "providers.local.yaml")
const sample = path.join(dir, "providers.example.yaml")
const cases = process.env.OPENCODE_SYSTEM_LLM_CASES ?? path.join(dir, "cases")
const enabled = process.env.OPENCODE_SYSTEM_TEST === "1"
const p1 = process.env.OPENCODE_SYSTEM_TEST_P1 === "1"
const timeout = Number(process.env.OPENCODE_SYSTEM_TEST_TIMEOUT ?? 120_000)
const concurrency = Math.max(1, Number(process.env.OPENCODE_SYSTEM_TEST_CONCURRENCY ?? 4))
const report = process.env.OPENCODE_SYSTEM_TEST_REPORT !== "0"
const reportPath =
  process.env.OPENCODE_SYSTEM_TEST_REPORT_PATH ??
  path.join(process.cwd(), "..", "..", ".aether", "llm-system-reports", `llm-p0-${process.pid}.json`)
const rows: Item[] = []
let missing: string | undefined

function list(name: string, variable: string) {
  const env = (process.env[variable] ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  const values = process.argv.flatMap((arg, index) => (arg === `--${name}` ? [process.argv[index + 1]] : []))
  const items = values.flatMap((value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean))
  const result = [...env, ...items]
  if (result.length === 0) return undefined
  return new Set(result)
}

const providers = list("provider", "OPENCODE_SYSTEM_TEST_PROVIDER")
const inputs = list("input", "OPENCODE_SYSTEM_TEST_INPUT")
let active = 0
const queue: (() => void)[] = []

async function limit<T>(fn: () => Promise<T>) {
  if (active >= concurrency) {
    await new Promise<void>((resolve) => queue.push(resolve))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    queue.shift()?.()
  }
}

function env(input: string | undefined) {
  if (!input) return undefined
  const value = process.env[input]?.trim()
  if (!value) return undefined
  return value
}

function fill(input: string) {
  return input.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "")
}

function key(spec: Spec) {
  const value = spec.api_key?.trim() || env(spec.api_key_env)
  if (!value) return undefined
  return value
}

function classify(input: unknown): Kind {
  const text = detail(input).toLowerCase()
  if (text.includes("timed out") || text.includes("aborted")) return "stream-incomplete"
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("forbidden")) {
    return "auth-failed"
  }
  if (
    text.includes("fetch") ||
    text.includes("network") ||
    text.includes("tls") ||
    text.includes("dns") ||
    text.includes("unable to connect") ||
    text.includes("failedtoopensocket") ||
    text.includes("failed to open socket") ||
    text.includes("connectionrefused") ||
    text.includes("connection refused")
  ) {
    return "network"
  }
  if (text.includes("assert")) return "assertion-failed"
  return "provider-error"
}

function message(input: unknown) {
  if (input instanceof Error) return input.message
  return String(input)
}

function detail(input: unknown): string {
  if (!(input instanceof Error)) return message(input)
  const err = input as Error & { code?: unknown; errno?: unknown; path?: unknown }
  const items = [input.name, input.message, err.code, err.errno, err.path, input.cause ? detail(input.cause) : undefined]
  return items.filter((item): item is string => typeof item === "string" && item.length > 0).join(" ")
}

function assert(ok: boolean, text: string) {
  if (ok) return
  throw new Error(`assertion failed: ${text}`)
}

function agent(): Agent.Info {
  return {
    name: "system",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function user(spec: Spec, model: Model, sessionID: SessionID): MessageV2.User {
  return {
    id: MessageID.make(`${spec.id}-${model.id}-${Date.now()}`),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "system",
    model: {
      providerID: ProviderID.make(spec.id),
      modelID: ModelID.make(model.id),
    },
  }
}

function provider(spec: Spec, model: Model, secret: string) {
  return {
    name: spec.name ?? spec.id,
    npm: spec.npm,
    api: fill(spec.base_url),
    env: [],
    models: {
      [model.id]: {
        id: model.api_id ?? model.id,
        name: model.name ?? model.id,
        tool_call: model.capabilities.tool,
        reasoning: model.capabilities.reasoning,
        ...(model.capabilities.interleaved ? { interleaved: { field: model.capabilities.interleaved } } : {}),
        temperature: model.capabilities.temperature,
        limit: {
          context: model.limit.context,
          output: model.limit.output,
        },
        modalities: {
          input: model.capabilities.vision ? ["text", "image"] : ["text"],
          output: ["text"],
        },
      },
    },
    options: {
      apiKey: secret,
      baseURL: fill(spec.base_url),
      timeout,
      chunkTimeout: timeout,
      ...spec.options,
    },
  }
}

function usable(spec: Spec, model: Model, input: Case) {
  if (!enabled) return "OPENCODE_SYSTEM_TEST is not 1"
  if (missing) return `provider config missing: ${missing}`
  if (!spec.enabled) return "provider disabled in YAML"
  if (input.tier === "P1" && !p1) return "P1 disabled"
  if (input.target.providers && !input.target.providers.includes(spec.id)) return "case targets another provider"
  if (input.target.models && !input.target.models.includes(model.id)) return "case targets another model"
  if (input.capabilities.includes("reasoning") && !model.capabilities.reasoning) return "model lacks reasoning"
  if (input.capabilities.includes("temperature") && !model.capabilities.temperature) return "model lacks temperature"
  if (input.capabilities.includes("tool") && !model.capabilities.tool) return "model lacks tool"
  if (input.capabilities.includes("vision") && !model.capabilities.vision) return "model lacks vision"
  if (spec.cases && !spec.cases.includes(input.id)) return "case not listed for provider"
  if (model.cases && !model.cases.includes(input.id)) return "case not listed for model"
  if (!key(spec)) return `missing API key${spec.api_key_env ? ` from ${spec.api_key_env}` : ""}`
  return undefined
}

async function loadSpecs() {
  const file = (await Bun.file(local).exists()) ? local : sample
  if (file === sample) missing = local
  const data = ConfigFile.parse(Bun.YAML.parse(await Bun.file(file).text()))
  return { file, specs: data.providers }
}

async function loadCases() {
  const files = (await Array.fromAsync(new Bun.Glob("*.json").scan(cases))).sort()
  return Promise.all(files.map(async (file) => Case.parse(await Bun.file(path.join(cases, file)).json())))
}

function record(row: Item) {
  rows.push(row)
  console.info(JSON.stringify({ kind: "llm-system-test", ...row }))
}

async function run(spec: Spec, model: Model, input: Case) {
  const secret = key(spec)
  if (!secret) throw new Error("missing API key")

  await using tmp = await tmpdir({
    init: async (root) => {
      const text = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        enabled_providers: [spec.id],
        provider: {
          [spec.id]: provider(spec, model, secret),
        },
      })
      await Promise.all([Bun.write(path.join(root, "aether.json"), text), Bun.write(path.join(root, "opencode.json"), text)])
    },
  })

  return await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await Config.get()
      if (!cfg.provider?.[spec.id]) {
        const files = await ConfigPaths.projectFiles("aether", Instance.directory, Instance.worktree)
        throw new Error(`test config was not loaded; files=${files.join(",")}`)
      }

      const resolved = await Provider.getModel(ProviderID.make(spec.id), ModelID.make(model.id))
      if (input.assert.endpoint) {
        assert(
          (input.assert.endpoint === "responses" && resolved.api.npm === "@ai-sdk/openai") ||
            (input.assert.endpoint === "chat" && resolved.api.npm === "@ai-sdk/openai-compatible"),
          `expected ${input.assert.endpoint} endpoint, got ${resolved.api.npm}`,
        )
      }
      const sessionID = SessionID.make(`system-${spec.id}-${model.id}-${input.id}-${Date.now()}`)
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(`${spec.id}/${model.id}/${input.id} timed out after ${timeout}ms`), timeout)
      const started = performance.now()
      const tools: Record<string, Tool> =
        input.assert.tool_call
          ? {
              lookup: tool({
                description: "Look up a short value by key.",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: {
                    key: { type: "string" },
                  },
                  required: ["key"],
                  additionalProperties: false,
                }),
                execute: async () => ({ output: "ok" }),
              }),
            }
          : {}

      try {
        const stream = await LLM.stream({
          user: user(spec, model, sessionID),
          sessionID,
          model: resolved,
          agent: agent(),
          system: [input.system ?? "You are a concise system-test assistant. Answer the user directly."],
          abort: ctl.signal,
          messages: [
            ...(input.history as ModelMessage[]),
            ...(input.prompt ? [{ role: "user" as const, content: input.prompt }] : []),
          ],
          tools,
          toolChoice: input.assert.tool_call ? "required" : "auto",
          retries: 0,
        })

        let text = ""
        let chunks = 0
        let reasoning = 0
        let calls = 0
        let done = false
        let finish: string | undefined
        let usage: Usage = { state: "missing", reason: "provider did not return usage in finish-step" }

        for await (const part of stream.fullStream) {
          if (part.type === "text-delta") {
            text += part.text
            chunks++
          }
          if (part.type === "reasoning-delta") reasoning++
          if (part.type === "tool-call") calls++
          if (part.type === "finish-step") {
            done = true
            finish = part.finishReason
            if (part.usage) usage = { state: "present", value: part.usage }
          }
          if (part.type === "error") throw part.error
        }

        assert(done, "stream ended without finish-step")
        assert(
          !input.assert.non_empty || text.trim().length > 0 || reasoning > 0 || calls > 0,
          "stream produced no text, reasoning, or tool call chunks",
        )
        for (const item of input.assert.contains ?? []) {
          assert(text.includes(item), `response did not contain ${item}`)
        }
        assert(!input.assert.tool_call || calls > 0, "stream produced no tool-call chunks")
        assert(!input.assert.reasoning || reasoning > 0, "stream produced no reasoning chunks")

        return {
          ms: Math.round(performance.now() - started),
          text: chunks,
          reasoning,
          tools: calls,
          finish,
          usage,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  })
}

const data = await loadSpecs()
const suite = await loadCases()

afterAll(async () => {
  if (!report) return
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  await Bun.write(
    reportPath,
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        config: data.file,
        cases,
        rows,
      },
      null,
      2,
    ),
  )
})

describe("LLM system tests", () => {
  for (const spec of providers ? data.specs.filter((spec) => providers.has(spec.id)) : data.specs) {
    for (const model of spec.models) {
      for (const input of inputs ? suite.filter((input) => inputs.has(input.id)) : suite) {
        test(
          `${spec.id}/${model.id}/${input.id}`,
          async () => {
            const skip = usable(spec, model, input)
            if (skip) {
              record({
                provider: spec.id,
                type: spec.type,
                baseURL: fill(spec.base_url),
                model: model.id,
                case: input.id,
                status: "skipped",
                ms: 0,
                text: 0,
                reasoning: 0,
                tools: 0,
                usage: { state: "unsupported", reason: "case skipped before request" },
                error: { kind: "config-missing", message: skip },
              })
              return
            }

            const started = performance.now()
            try {
              const result = await limit(() => run(spec, model, input))
              record({
                provider: spec.id,
                type: spec.type,
                baseURL: fill(spec.base_url),
                model: model.id,
                case: input.id,
                status: "passed",
                ...result,
              })
            } catch (err) {
              const text = `${spec.id}/${model.id}/${input.id} failed: ${message(err)}`
              record({
                provider: spec.id,
                type: spec.type,
                baseURL: fill(spec.base_url),
                model: model.id,
                case: input.id,
                status: "failed",
                ms: Math.round(performance.now() - started),
                text: 0,
                reasoning: 0,
                tools: 0,
                usage: { state: "missing", reason: "request failed before usage was available" },
                error: { kind: classify(err), message: text },
              })
              throw new Error(text, { cause: err })
            }
          },
          timeout + 10_000,
        )
      }
    }
  }
})
