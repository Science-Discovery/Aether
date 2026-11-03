import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NativeModes } from "../../src/native/modes"
import type { Protocol } from "../../src/native/protocol"
import { tmpdir } from "../fixture/fixture"

function schemas() {
  const modes = { type: "string", enum: ["default", "plan"] }
  return {
    requests: {
      oneOf: ["turn/start", "turn/steer", "collaborationMode/list"].map((method) => ({
        properties: { method: { enum: [method] } },
      })),
    },
    steer: {
      required: ["threadId", "input", "expectedTurnId"],
      properties: {
        threadId: { type: "string" },
        expectedTurnId: { type: "string" },
        clientUserMessageId: { type: ["string", "null"] },
        input: { type: "array", items: { $ref: "#/definitions/Input" } },
      },
      definitions: {
        Input: { oneOf: [{ properties: { type: { const: "text" }, text: { type: "string" } } }] },
      },
    },
    start: {
      properties: { collaborationMode: { anyOf: [{ $ref: "#/$defs/Mode" }, { type: "null" }] } },
      $defs: {
        Mode: { properties: { mode: modes, settings: { $ref: "#/$defs/Settings" } } },
        Settings: {
          properties: {
            model: { type: "string" },
            reasoning_effort: { type: ["string", "null"] },
            developer_instructions: { type: ["string", "null"] },
          },
        },
      },
    },
    list: {
      properties: {
        data: { type: "array", items: { properties: { name: { type: "string" }, mode: modes } } },
      },
    },
  }
}

function client(value: unknown, calls: string[] = []): Pick<Protocol.Client, "request"> {
  return {
    request: async <T>(method: string) => {
      calls.push(method)
      if (value instanceof Error) throw value
      return value as T
    },
  }
}

test("native capabilities follow parameter schemas and require tracked steering input", () => {
  expect(NativeModes.supports(schemas())).toEqual({ steer: true, plan: true })
  const docs = schemas()
  docs.steer.required = ["threadId", "input"]
  expect(NativeModes.supports(docs)).toMatchObject({ steer: false, plan: true })
  expect(
    NativeModes.supports({
      ...schemas(),
      steer: { ...schemas().steer, properties: { ...schemas().steer.properties, clientUserMessageId: {} } },
    }),
  ).toMatchObject({ steer: false, plan: true })
  expect(NativeModes.supports({ ...schemas(), requests: {} })).toMatchObject({ steer: false, plan: false })
})

test("collaboration support requires both modes and built-in instruction semantics on the turn parameter", () => {
  expect(NativeModes.supports({ ...schemas(), start: { definitions: schemas().start.$defs } })).toMatchObject({
    plan: false,
  })
  const docs = schemas()
  docs.start.$defs.Mode.properties.mode.enum = ["plan"]
  expect(NativeModes.supports(docs)).toMatchObject({ plan: false })
  const next = schemas()
  next.start.$defs.Settings.properties.developer_instructions.type = ["string"]
  expect(NativeModes.supports(next)).toMatchObject({ plan: false })
  expect(NativeModes.supports({ ...schemas(), list: null })).toMatchObject({ plan: false })
})

test("schema traversal handles large request catalogs and refuses cyclic references", () => {
  const docs = schemas()
  docs.requests.oneOf.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({ properties: { method: { enum: [`unrelated/${index}`] } } })),
  )
  expect(NativeModes.supports(docs)).toEqual({ steer: true, plan: true })
  expect(
    NativeModes.supports({
      ...schemas(),
      start: {
        properties: { collaborationMode: { $ref: "#/definitions/Loop" } },
        definitions: { Loop: { $ref: "#/definitions/Loop" } },
      },
    }),
  ).toMatchObject({ plan: false })
})

test("native presets determine availability while selected model and effort stay explicit", async () => {
  const calls: string[] = []
  const server = client(
    { data: [{ name: "Planning", mode: "plan", model: "preset-model", reasoning_effort: "high" }] },
    calls,
  )
  expect(
    await NativeModes.resolve(server, { mode: "plan", model: "chosen", effort: "low" }, { plan: true, steer: true }),
  ).toEqual({ mode: "plan", settings: { model: "chosen", reasoning_effort: "low", developer_instructions: null } })
  expect(await NativeModes.resolve(server, { mode: "plan", model: "chosen" }, { plan: true, steer: true })).toEqual({
    mode: "plan",
    settings: { model: "chosen", reasoning_effort: "high", developer_instructions: null },
  })
  expect(calls).toEqual(["collaborationMode/list", "collaborationMode/list"])
})

test("older servers keep ordinary turns available without pretending to support plan mode", async () => {
  const calls: string[] = []
  const server = client(new Error("must not call this server"), calls)
  expect(
    await NativeModes.resolve(server, { mode: "default", model: "chosen" }, { plan: false, steer: false }),
  ).toBeUndefined()
  await expect(
    NativeModes.resolve(server, { mode: "plan", model: "chosen" }, { plan: false, steer: false }),
  ).rejects.toThrow("does not support native plan")
  expect(calls).toEqual([])
})

test("switching a supported server back to default never silently omits the mode", async () => {
  const capabilities = { steer: true, plan: true }
  expect(
    await NativeModes.resolve(
      client({ data: [{ name: "Execute", mode: "default" }] }),
      { mode: "default", model: "chosen" },
      capabilities,
    ),
  ).toEqual({ mode: "default", settings: { model: "chosen", reasoning_effort: null, developer_instructions: null } })
  await expect(
    NativeModes.resolve(client(new Error("offline")), { mode: "default", model: "chosen" }, capabilities),
  ).rejects.toThrow("offline")
  await expect(
    NativeModes.resolve(client({ data: [] }), { mode: "plan", model: "chosen" }, capabilities),
  ).rejects.toThrow("did not advertise")
  await expect(NativeModes.list(client({ data: [{ mode: "plan" }] }))).rejects.toThrow("unsupported")
  expect(await NativeModes.list(client({ data: [{ name: "Future", mode: "new-mode" }] }))).toEqual([])
})

test("unverified capabilities cannot silently retain a previous native plan mode", async () => {
  const calls: string[] = []
  const server = client(new Error("must not call this server"), calls)
  await expect(
    NativeModes.resolve(
      server,
      { mode: "default", model: "chosen", previous: "plan" },
      { plan: false, steer: false, error: "discovery failed" },
    ),
  ).rejects.toThrow("existing thread may retain plan mode")
  expect(
    await NativeModes.resolve(
      server,
      { mode: "default", model: "chosen", previous: "default" },
      { plan: false, steer: false },
    ),
  ).toBeUndefined()
  expect(calls).toEqual([])
})

async function executable(root: string) {
  const file = path.join(root, process.platform === "win32" ? "codex.cmd" : "codex")
  const source = path.join(import.meta.dir, "modes-fixture.ts")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${source}" "${root}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} ${quote(root)} "$@"\n`,
  )
  if (process.platform !== "win32") await fs.chmod(file, 0o755)
  await Bun.write(path.join(root, "schemas.json"), JSON.stringify(schemas()))
  return file
}

test("discovery exports only isolated schemas, caches the executable identity and removes temporary output", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  const previous = process.env.AETHER_MODE_TEST_SECRET
  process.env.AETHER_MODE_TEST_SECRET = "not-for-child"
  try {
    await Bun.write(path.join(dir.path, "mode"), "new")
    expect(await NativeModes.discover(file)).toEqual({ steer: true, plan: true })
    const audit = await Bun.file(path.join(dir.path, "audit.json")).json()
    expect(audit.token).toBeUndefined()
    expect(audit.home).toBe(audit.user)
    expect(audit.args).toEqual(["app-server", "generate-json-schema", "--out", audit.out, "--experimental"])
    expect(await fs.stat(path.dirname(audit.home)).catch(() => undefined)).toBeUndefined()
    await Bun.write(path.join(dir.path, "mode"), "old")
    expect(await NativeModes.discover(file)).toEqual({ steer: true, plan: true })
    await fs.utimes(file, new Date(), new Date(Date.now() + 2_000))
    expect(await NativeModes.discover(file)).toMatchObject({ steer: false, plan: false })
  } finally {
    if (previous === undefined) delete process.env.AETHER_MODE_TEST_SECRET
    if (previous !== undefined) process.env.AETHER_MODE_TEST_SECRET = previous
  }
})

test("failed discovery is briefly cached and expires while a changed executable bypasses it", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  await Bun.write(path.join(dir.path, "mode"), "fail")
  expect(await NativeModes.discover(file)).toMatchObject({ steer: false, plan: false, error: expect.any(String) })
  await Bun.write(path.join(dir.path, "mode"), "new")
  expect(await NativeModes.discover(file)).toMatchObject({ steer: false, plan: false })
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 30_001)
  try {
    expect(await NativeModes.discover(file)).toEqual({ steer: true, plan: true })
  } finally {
    clock.mockRestore()
  }
  await Bun.write(path.join(dir.path, "mode"), "fail")
  await fs.utimes(file, new Date(), new Date(Date.now() + 2_000))
  expect(await NativeModes.discover(file)).toMatchObject({ steer: false, plan: false })
  await Bun.write(path.join(dir.path, "mode"), "new")
  await fs.utimes(file, new Date(), new Date(Date.now() + 4_000))
  expect(await NativeModes.discover(file)).toEqual({ steer: true, plan: true })
  expect(await NativeModes.discover(path.join(dir.path, "missing"))).toMatchObject({ steer: false, plan: false })
})

test("stalled schema discovery is bounded and stops its isolated exporter", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  await Bun.write(path.join(dir.path, "mode"), "hang")
  const start = Date.now()
  try {
    expect(await NativeModes.discover(file)).toMatchObject({ steer: false, plan: false, error: expect.any(String) })
    expect(Date.now() - start).toBeLessThan(14_000)
    const audit = await Bun.file(path.join(dir.path, "audit.json")).json()
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await Promise.try(() => process.kill(audit.pid, 0)).catch(() => false))) break
      await Bun.sleep(25)
    }
    expect(() => process.kill(audit.pid, 0)).toThrow()
    expect(await fs.stat(path.dirname(audit.home)).catch(() => undefined)).toBeUndefined()
  } finally {
    await Bun.write(path.join(dir.path, "release"), "done")
  }
}, 15_000)
