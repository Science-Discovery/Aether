import { expect, test } from "bun:test"
import { NativeForm } from "../../src/native/elicitation-schema"
import { NativeElicitation } from "../../src/native/elicitation"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const form = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 2, maxLength: 20 },
    pages: { type: "integer", minimum: 1, maximum: 10 },
    enabled: { type: "boolean", default: false },
    style: {
      type: "string",
      oneOf: [
        { const: "short", title: "Short" },
        { const: "long", title: "Long" },
      ],
    },
    tags: {
      type: "array",
      items: {
        anyOf: [
          { const: "math", title: "Mathematics" },
          { const: "science", title: "Science" },
        ],
      },
      minItems: 1,
      maxItems: 2,
    },
  },
  required: ["title", "pages", "enabled"],
}

test("standard form values retain their types, options and constraints", () => {
  const fields = NativeForm.parse(form)
  expect(fields.find((field) => field.name === "enabled")?.default).toBe(false)
  expect(fields.find((field) => field.name === "style")?.options?.[0]).toEqual({ value: "short", title: "Short" })
  const value = { title: "Test", pages: 3, enabled: false, style: "short", tags: ["math"] }
  expect(NativeForm.content(fields, value)).toEqual(value)
  for (const data of [
    { ...value, pages: "3" },
    { ...value, pages: 1.5 },
    { ...value, pages: 11 },
    { ...value, title: "a" },
    { ...value, extra: true },
    { ...value, style: "other" },
    { ...value, tags: [] },
    { ...value, tags: ["math", "math"] },
    { title: "Test", pages: 3 },
  ]) {
    expect(() => NativeForm.content(fields, data)).toThrow()
  }
})

test("unsupported secrets, nesting and constraints fail before showing a form", () => {
  for (const field of [
    { type: "string", format: "password" },
    { type: "string", pattern: "^x$" },
    { type: "object", properties: {} },
    { type: "string", isSecret: true },
  ]) {
    expect(() => NativeForm.parse({ type: "object", properties: { value: field } })).toThrow()
  }
  expect(() => NativeForm.parse({ ...form, required: ["missing"] })).toThrow()
  expect(() =>
    NativeForm.parse({
      type: "object",
      properties: { choice: { type: "string", enum: ["x", "y"], enumNames: ["X"] } },
    }),
  ).toThrow()
  const fields = NativeForm.parse({
    type: "object",
    properties: { email: { type: "string", format: "email" }, date: { type: "string", format: "date" } },
  })
  expect(() => NativeForm.content(fields, { email: "bad" })).toThrow()
  expect(() => NativeForm.content(fields, { date: "2026-02-30" })).toThrow()
  expect(NativeForm.content(fields, { email: "a@example.com", date: "2026-10-30" })).toEqual({
    email: "a@example.com",
    date: "2026-10-30",
  })
})

async function scenario(run: (session: Session.Info) => Promise<void>) {
  await using dir = await tmpdir()
  try {
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        const session = await Session.create({ engine: { type: "codex" } })
        await Session.setEngine({ sessionID: session.id, engine: { type: "codex", thread: "root" } })
        await run(await Session.get(session.id))
      },
    })
  } finally {
    await Instance.disposeDirectory(dir.path)
  }
}

async function pending(session: Session.Info, mode: "form" | "url" = "form") {
  const abort = new AbortController()
  const result = NativeElicitation.ask(
    session.id,
    {
      threadId: "root",
      serverName: "fixture",
      mode,
      message: "Choose a value",
      requestedSchema: form,
      url: "https://example.com/authorize",
      elicitationId: "flow",
    },
    abort.signal,
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = (await NativeElicitation.list(session.id))[0]
    if (info) return { abort, result, info }
    await Bun.sleep(1)
  }
  abort.abort()
  await result
  throw new Error("Request not registered")
}

test("answers go back once to their originating request and only hashed receipts remain", async () => {
  await scenario(async (session) => {
    const item = await pending(session)
    const content = { title: "Test", pages: 2, enabled: false }
    const input = { sessionID: session.id, id: item.info.id, action: "accept" as const, content }
    expect(NativeElicitation.active(session.id)).toBe(true)
    await expect(NativeElicitation.reply({ ...input, content: { ...content, pages: "two" } })).rejects.toThrow()
    expect((await NativeElicitation.list(session.id)).length).toBe(1)
    const receipts = await Promise.all([NativeElicitation.reply(input), NativeElicitation.reply(input)])
    expect(receipts[0]).toEqual(receipts[1])
    expect(await item.result).toEqual({ action: "accept", content })
    expect(await NativeElicitation.list(session.id)).toEqual([])
    expect(NativeElicitation.active(session.id)).toBe(false)
    await expect(NativeElicitation.reply({ ...input, action: "decline", content: null })).rejects.toThrow()
    expect(await Session.messages({ sessionID: session.id })).toEqual([])
  })
})

test("withdrawn or stopped requests cannot be answered; URL opening is not required or automatic", async () => {
  await scenario(async (session) => {
    const item = await pending(session, "url")
    item.abort.abort()
    expect(await item.result).toEqual({ action: "cancel", content: null })
    await expect(
      NativeElicitation.reply({ sessionID: session.id, id: item.info.id, action: "accept" }),
    ).rejects.toThrow()
    const next = await pending(session, "url")
    await expect(
      NativeElicitation.reply({
        sessionID: session.id,
        id: next.info.id,
        action: "accept",
        content: { token: "secret" },
      }),
    ).rejects.toThrow()
    await NativeElicitation.reply({ sessionID: session.id, id: next.info.id, action: "decline" })
    expect(await next.result).toEqual({ action: "decline", content: null })
    for (const url of ["javascript:alert(1)", "file:///tmp/token", "https://user:pass@example.com"]) {
      await expect(
        NativeElicitation.ask(
          session.id,
          { threadId: "root", serverName: "fixture", mode: "url", message: "Authorize", url, elicitationId: "flow" },
          new AbortController().signal,
        ),
      ).rejects.toThrow()
    }
  })
})

test("another project or session cannot read or reply to a pending form", async () => {
  await scenario(async (session) => {
    const item = await pending(session)
    const other = await Session.create({ engine: { type: "codex" } })
    await expect(NativeElicitation.reply({ sessionID: other.id, id: item.info.id, action: "cancel" })).rejects.toThrow()
    await using dir = await tmpdir()
    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await expect(NativeElicitation.list(session.id)).rejects.toThrow()
        await expect(
          NativeElicitation.reply({ sessionID: session.id, id: item.info.id, action: "cancel" }),
        ).rejects.toThrow()
      },
    })
    await Instance.disposeDirectory(dir.path)
    item.abort.abort()
    await item.result
  })
})
