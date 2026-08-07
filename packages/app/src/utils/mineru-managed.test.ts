import { describe, expect, test } from "bun:test"
import { MineruManagedTest, ensureManagedMineru, needsMineru } from "./mineru-managed"

type Client = Parameters<typeof ensureManagedMineru>[0]["client"]

function client(input: { install?: "ready" | "unconfigured"; run?: "running" | "stopped"; start?: () => void }) {
  return {
    global: {
      mineruManagedStatus: async () => ({
        data: {
          install: input.install ?? "ready",
          run: input.run ?? "stopped",
        },
      }),
      mineruManagedStart: async () => {
        input.start?.()
        return { data: {} }
      },
    },
  } as unknown as Client
}

describe("managed MinerU send policy", () => {
  test("only starts for attachment types unsupported by the model", () => {
    expect(needsMineru({ image: true, pdf: true }, [{ mime: "image/png" }, { mime: "application/pdf" }])).toBe(false)
    expect(needsMineru({ image: true, pdf: false }, [{ mime: "application/pdf" }])).toBe(true)
    expect(needsMineru({ image: false, pdf: true }, [{ mime: "image/jpeg" }])).toBe(true)
  })

  test("starts for a captured PDF region sent to a text-only model", async () => {
    MineruManagedTest.reset()
    let starts = 0
    const files = [{ mime: "image/png" }]

    expect(needsMineru({ image: false, pdf: false }, files)).toBe(true)
    expect(
      await ensureManagedMineru({
        client: client({ start: () => starts++ }),
        prompt: true,
        confirm: async () => true,
      }),
    ).toBe(true)
    expect(starts).toBe(1)
  })

  test("declining once keeps the legacy path for the app session", async () => {
    MineruManagedTest.reset()
    let prompts = 0
    let starts = 0
    const api = client({ start: () => starts++ })
    const confirm = async () => {
      prompts++
      return false
    }
    expect(await ensureManagedMineru({ client: api, prompt: true, confirm })).toBe(false)
    expect(await ensureManagedMineru({ client: api, prompt: true, confirm })).toBe(false)
    expect(prompts).toBe(1)
    expect(starts).toBe(0)
  })

  test("starts after confirmation and skips the prompt when already running", async () => {
    MineruManagedTest.reset()
    let starts = 0
    expect(
      await ensureManagedMineru({
        client: client({ start: () => starts++ }),
        prompt: true,
        confirm: async () => true,
      }),
    ).toBe(true)
    expect(starts).toBe(1)

    MineruManagedTest.reset()
    let prompts = 0
    expect(
      await ensureManagedMineru({
        client: client({ run: "running" }),
        prompt: true,
        confirm: async () => {
          prompts++
          return true
        },
      }),
    ).toBe(true)
    expect(prompts).toBe(0)
  })

  test("does not start an incomplete installation", async () => {
    MineruManagedTest.reset()
    let prompts = 0
    expect(
      await ensureManagedMineru({
        client: client({ install: "unconfigured" }),
        prompt: true,
        confirm: async () => {
          prompts++
          return true
        },
      }),
    ).toBe(false)
    expect(prompts).toBe(0)
  })
})
