import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { SessionID, MessageID } from "../../src/session/schema"

export function reply(mode: "chat" | "responses", model = "test-model") {
  const chunks =
    mode === "responses"
      ? [
          { type: "response.created", response: { id: "resp-1", created_at: 1, model, service_tier: null } },
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
        ].map((chunk) => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}`)
      : [
          `data: ${JSON.stringify({ id: "chat-1", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}`,
          `data: ${JSON.stringify({ id: "chat-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          "data: [DONE]",
        ]
  return new Response(chunks.join("\n\n") + "\n\n", { headers: { "Content-Type": "text/event-stream" } })
}

export async function stream(model: Provider.Model, variant?: string, options: Record<string, unknown> = {}) {
  const llm = await import("../../src/session/llm")
  const session = SessionID.make("session-reasoning")
  const agent = {
    name: "test",
    mode: "primary",
    options,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
  const output = await llm.LLM.stream({
    user: {
      id: MessageID.make("user-reasoning"),
      sessionID: session,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: model.providerID, modelID: model.id },
      variant,
    },
    sessionID: session,
    model,
    agent,
    system: [],
    abort: new AbortController().signal,
    messages: [{ role: "user", content: "Hello" }],
    tools: {},
  })
  return output.text
}
