import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NativePermissions } from "../../src/native/permissions"
import { Native } from "../../src/native/schema"
import { tmpdir } from "../fixture/fixture"

test("legacy permission stays user and input cannot silently default old engines to auto", () => {
  expect(Native.Engine.parse({ type: "codex" })).toEqual({ type: "codex" })
  expect(Native.Input.safeParse({ type: "codex", permission: "never" }).success).toBe(false)
  expect(NativePermissions.resolve(undefined, "/project")).toEqual(NativePermissions.resolve("user", "/project"))
  expect(NativePermissions.resolve("user", "/project")).toEqual({
    thread: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write" },
    turn: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/project"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    },
  })
})

test("auto approval preserves the sandbox and requires verified support without falling back", () => {
  expect(() => NativePermissions.resolve("auto", "/project")).toThrow("could not be verified")
  expect(() => NativePermissions.resolve("auto", "/project", { auto: false, error: "Not supported" })).toThrow(
    "Not supported",
  )
  const value = NativePermissions.resolve("auto", "/project", { auto: true })
  expect(value.thread).toEqual({
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  })
  expect(value.turn).toMatchObject({
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
  })
})

test("full access explicitly removes approval prompts and sandbox restrictions for the next turn", () => {
  expect(NativePermissions.resolve("full", "/project")).toEqual({
    thread: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" },
    turn: { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } },
  })
})

test("capability parsing follows the actual parameter and fails closed for unknown schemas", () => {
  expect(NativePermissions.supports({ properties: { approvalsReviewer: { enum: ["user", "auto_review"] } } })).toBe(
    true,
  )
  expect(
    NativePermissions.supports({
      properties: { approvalsReviewer: { anyOf: [{ $ref: "#/$defs/Review" }, { type: "null" }] } },
      $defs: { Review: { oneOf: [{ const: "user" }, { const: "auto_review" }] } },
    }),
  ).toBe(true)
  expect(
    NativePermissions.supports({ properties: {}, definitions: { ApprovalsReviewer: { enum: ["auto_review"] } } }),
  ).toBe(false)
  expect(
    NativePermissions.supports({ properties: { approvalsReviewer: { enum: ["user", "guardian_subagent"] } } }),
  ).toBe(false)
  expect(
    NativePermissions.supports({
      properties: { approvalsReviewer: { $ref: "#/definitions/Loop" } },
      definitions: { Loop: { $ref: "#/definitions/Loop" } },
    }),
  ).toBe(false)
  expect(NativePermissions.supports(null)).toBe(false)
})

async function executable(root: string) {
  const file = path.join(root, process.platform === "win32" ? "codex.cmd" : "codex")
  const source = path.join(import.meta.dir, "permissions-fixture.ts")
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await Bun.write(
    file,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${source}" "${root}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(source)} ${quote(root)} "$@"\n`,
  )
  if (process.platform !== "win32") await fs.chmod(file, 0o755)
  return file
}

test("schema discovery isolates credentials, requires every endpoint, caches by executable identity and cleans its output", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  const previous = process.env.AETHER_PERMISSION_TEST_SECRET
  process.env.AETHER_PERMISSION_TEST_SECRET = "must-not-be-inherited"
  try {
    await Bun.write(path.join(dir.path, "mode"), "new")
    expect(await NativePermissions.discover(file)).toEqual({ auto: true })
    const audit = await Bun.file(path.join(dir.path, "audit.json")).json()
    expect(audit.token).toBeUndefined()
    expect(audit.home).toBe(audit.user)
    expect(audit.args).toEqual(["app-server", "generate-json-schema", "--out", audit.out, "--experimental"])
    expect(await fs.stat(path.dirname(audit.home)).catch(() => undefined)).toBeUndefined()
    await Bun.write(path.join(dir.path, "mode"), "old")
    expect(await NativePermissions.discover(file)).toEqual({ auto: true })
    await fs.utimes(file, new Date(), new Date(Date.now() + 2_000))
    expect(await NativePermissions.discover(file)).toMatchObject({
      auto: false,
      error: expect.stringContaining("Update Codex"),
    })
  } finally {
    if (previous === undefined) delete process.env.AETHER_PERMISSION_TEST_SECRET
    if (previous !== undefined) process.env.AETHER_PERMISSION_TEST_SECRET = previous
  }
})

test("schema export failure is explicit and retryable without replacing the binary", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  await Bun.write(path.join(dir.path, "mode"), "fail")
  expect(await NativePermissions.discover(file)).toMatchObject({
    auto: false,
    error: expect.stringContaining("Could not verify"),
  })
  await Bun.write(path.join(dir.path, "mode"), "new")
  expect(await NativePermissions.discover(file)).toEqual({ auto: true })
  expect(await NativePermissions.discover(path.join(dir.path, "missing"))).toMatchObject({ auto: false })
})

test("a stalled schema exporter times out, stops its process tree and removes only its temporary output", async () => {
  await using dir = await tmpdir()
  const file = await executable(dir.path)
  await Bun.write(path.join(dir.path, "mode"), "hang")
  const start = Date.now()
  try {
    expect(await NativePermissions.discover(file)).toMatchObject({
      auto: false,
      error: expect.stringContaining("Could not verify"),
    })
    expect(Date.now() - start).toBeLessThan(14_000)
    const audit = await Bun.file(path.join(dir.path, "audit.json")).json()
    // Process-tree termination is asynchronous on Windows.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await Promise.try(() => process.kill(audit.pid, 0)).catch(() => false))) break
      await Bun.sleep(25)
    }
    expect(() => process.kill(audit.pid, 0)).toThrow()
    expect(await fs.stat(path.dirname(audit.home)).catch(() => undefined)).toBeUndefined()
  } finally {
    await Bun.write(path.join(dir.path, "release"), "release")
  }
}, 15_000)
