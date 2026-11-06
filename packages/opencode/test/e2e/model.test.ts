import { expect, test } from "bun:test"
import { ManagedRuntime } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { TestLLMServer } from "../lib/llm-server"
import { startBackend } from "../../../app/e2e/backend"

test("shared e2e seeds use an explicitly configured local provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aether-e2e-model-"))
  const runtime = ManagedRuntime.make(TestLLMServer.layer)
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    const llm = await runtime.runPromise(TestLLMServer.asEffect())
    backend = await startBackend("model-seed", { llmUrl: llm.url })
    const opened = await fetch(`${backend.url}/project/open?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: dir }),
    })
    expect(opened.ok).toBe(true)
    const sdk = createOpencodeClient({ baseUrl: backend.url, directory: dir, throwOnError: true })
    const providers = await sdk.config.providers().then((res) => res.data!.providers)
    expect(providers.find((provider) => provider.id === "e2e")?.models["test-model"]).toBeDefined()
    expect(providers.find((provider) => provider.id === "opencode")).toBeUndefined()
    const session = await sdk.session.create({ directory: dir, title: "Local provider smoke" }).then((res) => res.data!)
    await runtime.runPromise(llm.text("Local fixture reply"))
    const result = await sdk.session
      .prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Reply with the fixture message." }],
      })
      .then((res) => res.data!)
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("Local fixture reply"))).toBe(true)
    expect(await runtime.runPromise(llm.calls)).toBe(1)
  } finally {
    await backend?.stop()
    await runtime.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 120_000)
