import { describe, expect, test } from "bun:test"
import { AttachmentExtraction } from "../../src/attachment-extraction"

describe("attachment extraction MinerU client", () => {
  test("selects only attachments unsupported by the target model", () => {
    const files = [
      { id: "pdf", mime: "application/pdf", filename: "sample.pdf", url: "data:application/pdf;base64,JVBERg==" },
      { id: "image", mime: "image/png", filename: "sample.png", url: "data:image/png;base64,iVBORw==" },
      { id: "text", mime: "text/plain", filename: "sample.txt", url: "data:text/plain;base64,dGV4dA==" },
    ]

    expect(AttachmentExtraction.Test.select({ pdf: true, image: true }, files)).toEqual([])
    expect(AttachmentExtraction.Test.select({ pdf: true, image: false }, files).map((file) => file.id)).toEqual([
      "image",
    ])
    expect(AttachmentExtraction.Test.select({ pdf: false, image: true }, files).map((file) => file.id)).toEqual(["pdf"])
    expect(AttachmentExtraction.Test.select({ pdf: false, image: false }, files).map((file) => file.id)).toEqual([
      "pdf",
      "image",
    ])
  })

  test("uses the asynchronous MinerU API and returned result URLs", async () => {
    const seen: Record<string, string> = {}
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/tasks") {
          const form = await req.formData()
          for (const key of [
            "backend",
            "parse_method",
            "return_md",
            "response_format_zip",
            "start_page_id",
            "end_page_id",
          ]) {
            seen[key] = String(form.get(key))
          }
          const file = form.get("files")
          expect(file).toBeInstanceOf(File)
          expect((file as File).name).toBe("sample.pdf")
          return Response.json(
            {
              task_id: "job-1",
              status_url: "/state/job-1",
              result_url: "/output/job-1",
            },
            { status: 202 },
          )
        }
        if (url.pathname === "/state/job-1") return Response.json({ status: "completed" })
        if (url.pathname === "/output/job-1") {
          return Response.json({ results: { sample: { md_content: "# Extracted\n\nHello" } } })
        }
        return new Response("not found", { status: 404 })
      },
    })

    try {
      const text = await AttachmentExtraction.Test.convert({
        root: server.url.toString().replace(/\/$/, ""),
        file: {
          id: "part-1",
          mime: "application/pdf",
          filename: "sample.pdf",
          url: "data:application/pdf;base64,JVBERg==",
        },
        range: { startPage: 2, endPage: 4 },
      })

      expect(text).toBe("# Extracted\n\nHello")
      expect(seen).toEqual({
        backend: "pipeline",
        parse_method: "auto",
        return_md: "true",
        response_format_zip: "false",
        start_page_id: "1",
        end_page_id: "3",
      })
    } finally {
      server.stop(true)
    }
  })

  test("requires a healthy MinerU response", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "starting" }) })

    try {
      await expect(AttachmentExtraction.health(server.url.toString())).rejects.toThrow("MinerU API is not healthy")
    } finally {
      server.stop(true)
    }
  })
})
