import { describe, expect, mock, test } from "bun:test"
import { pull } from "./download"

describe("session download helpers", () => {
  test("pull prefers filename from content disposition", async () => {
    const fetch = mock(
      async () =>
        new Response(new Blob(["ok"]), {
          headers: {
            "Content-Disposition": `attachment; filename="docs.zip"; filename*=UTF-8''${encodeURIComponent("资料.zip")}`,
          },
        }),
    ) as unknown as typeof globalThis.fetch

    const out = await pull({
      url: "http://localhost:4096",
      dir: "/repo",
      path: "docs",
      fetch,
    })

    expect(out.name).toBe("资料.zip")
    expect(await out.blob.text()).toBe("ok")
  })

  test("pull falls back to path basename", async () => {
    const fetch = mock(async () => new Response(new Blob(["ok"]))) as unknown as typeof globalThis.fetch

    const out = await pull({
      url: "http://localhost:4096",
      dir: "/repo",
      path: "src/index.ts",
      fetch,
    })

    expect(out.name).toBe("index.ts")
  })

  test("pull surfaces server errors", async () => {
    const fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "Missing path" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }),
    ) as unknown as typeof globalThis.fetch

    await expect(
      pull({
        url: "http://localhost:4096",
        dir: "/repo",
        path: "bad",
        fetch,
      }),
    ).rejects.toThrow("Missing path")
  })
})
