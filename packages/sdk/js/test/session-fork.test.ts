import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "../src/v2/client"

function fixture(status = 200) {
  const requests: { method: string; url: URL; body: string; auth: string | null }[] = []
  const session = { id: "ses_child", title: "Example (fork #1)" }
  const error = { name: "SessionDetachError", data: { message: "A session in this subtree is busy" } }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        url: new URL(request.url),
        body: await request.text(),
        auth: request.headers.get("authorization"),
      })
      return Response.json(status === 200 ? session : error, { status })
    },
  })
  return {
    client: createOpencodeClient({ baseUrl: server.url.href, headers: { Authorization: "Basic fixture" } }),
    requests,
    session,
    error,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

describe("session fork and detach SDK requests", () => {
  test.each([undefined, false, true])(
    "serializes detached=%s without changing the selected message",
    async (detached) => {
      using data = fixture()
      const result = await data.client.session.fork({ sessionID: "ses_source", messageID: "msg_selected", detached })
      expect(result.data).toEqual(data.session)
      expect(data.requests).toHaveLength(1)
      expect(data.requests[0].method).toBe("POST")
      expect(data.requests[0].url.pathname).toBe("/session/ses_source/fork")
      expect(JSON.parse(data.requests[0].body)).toEqual({
        messageID: "msg_selected",
        ...(detached === undefined ? {} : { detached }),
      })
      expect(data.requests[0].auth).toBe("Basic fixture")
    },
  )

  test("detaches using the original session ID and directory without a request body", async () => {
    using data = fixture()
    const result = await data.client.session.detach({ sessionID: "ses_child", directory: "F:/研究/space test" })
    expect(result.data).toEqual(data.session)
    expect(data.requests).toHaveLength(1)
    expect(data.requests[0].method).toBe("POST")
    expect(data.requests[0].url.pathname).toBe("/session/ses_child/detach")
    expect(data.requests[0].url.searchParams.get("directory")).toBe("F:/研究/space test")
    expect(data.requests[0].body).toBe("")
    expect(data.requests[0].auth).toBe("Basic fixture")
  })

  test("returns a detach conflict without retrying or changing the session", async () => {
    using data = fixture(409)
    const result = await data.client.session.detach({ sessionID: "ses_child" })
    expect(result.data).toBeUndefined()
    expect(result.error).toEqual(data.error)
    expect(data.requests).toHaveLength(1)
  })

  test("preserves the typed server error when throwOnError is enabled", async () => {
    using data = fixture(409)
    await expect(data.client.session.detach({ sessionID: "ses_child" }, { throwOnError: true })).rejects.toEqual(
      data.error,
    )
    expect(data.requests).toHaveLength(1)
  })
})
