import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { assertExternalDirectory } from "../../src/tool/external-directory"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

type Req = Omit<Permission.Request, "id" | "sessionID" | "tool">

function recorder() {
  const requests: Req[] = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: async (req) => {
      requests.push(req)
    },
  }
  return { requests, ctx }
}

const linkType = () => (process.platform === "win32" ? "junction" : "dir")

async function alias(link: string, target: string) {
  await fs.symlink(target, link, linkType())
}

const glob = (p: string) => path.join(p, "*").replaceAll("\\", "/")

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const { requests, ctx } = recorder()
    await Instance.provide({ directory: "/tmp", fn: () => assertExternalDirectory(ctx) })
    expect(requests.length).toBe(0)
  })

  test("skips prompting when bypass=true", async () => {
    const { requests, ctx } = recorder()
    await Instance.provide({
      directory: "/tmp/project",
      fn: () => assertExternalDirectory(ctx, "/tmp/outside/file.txt", { bypass: true }),
    })
    expect(requests.length).toBe(0)
  })

  test("no-ops for existing paths inside the project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "content")
      },
    })
    const { requests, ctx } = recorder()
    await Instance.provide({
      directory: tmp.path,
      fn: () => assertExternalDirectory(ctx, path.join(tmp.path, "file.txt")),
    })
    expect(requests.length).toBe(0)
  })

  test("no-ops for a new file inside the project", async () => {
    await using tmp = await tmpdir()
    const { requests, ctx } = recorder()
    await Instance.provide({
      directory: tmp.path,
      fn: () => assertExternalDirectory(ctx, path.join(tmp.path, "nested", "new.txt")),
    })
    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob for external targets", async () => {
    await using outer = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "content")
      },
    })
    await using project = await tmpdir({ git: true })
    const { requests, ctx } = recorder()
    const target = path.join(outer.path, "file.txt")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([glob(path.dirname(target))])
    expect(req!.always).toEqual([glob(path.dirname(target))])
  })

  test("uses target directory when kind=directory", async () => {
    await using outer = await tmpdir()
    await using project = await tmpdir({ git: true })
    const { requests, ctx } = recorder()
    await Instance.provide({
      directory: project.path,
      fn: () => assertExternalDirectory(ctx, outer.path, { kind: "directory" }),
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([glob(outer.path)])
  })

  test("asks external_read when access=read", async () => {
    await using outer = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "file.txt"), "content")
      },
    })
    await using project = await tmpdir({ git: true })
    const { requests, ctx } = recorder()
    const target = path.join(outer.path, "file.txt")
    await Instance.provide({
      directory: project.path,
      fn: () => assertExternalDirectory(ctx, target, { access: "read" }),
    })

    expect(requests.length).toBe(1)
    expect(requests[0]!.permission).toBe("external_read")
    expect(requests[0]!.patterns).toEqual([glob(path.dirname(target))])
  })

  test("asks external_directory when access=write or unset", async () => {
    await using outer1 = await tmpdir()
    await using outer2 = await tmpdir()
    await using project = await tmpdir({ git: true })
    const { requests, ctx } = recorder()
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await assertExternalDirectory(ctx, path.join(outer1.path, "file.txt"), { access: "write" })
        await assertExternalDirectory(ctx, path.join(outer2.path, "file.txt"))
      },
    })

    expect(requests.length).toBe(2)
    for (const req of requests) {
      expect(req.permission).toBe("external_directory")
    }
  })
})

describe("tool.assertExternalDirectory symlink aliases", () => {
  test("asks external_read when reading through an alias pointing outside", async () => {
    await using priv = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "secret")
      },
    })
    await using project = await tmpdir({ git: true })
    await alias(path.join(project.path, "link"), priv.path)

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "link", "secret.txt")
    await Instance.provide({
      directory: project.path,
      fn: () => assertExternalDirectory(ctx, target, { access: "read" }),
    })

    expect(requests.length).toBe(1)
    expect(requests[0]!.permission).toBe("external_read")
    expect(requests[0]!.patterns).toEqual([glob(path.dirname(target))])
  })

  test("asks external_directory when creating a file through an alias pointing outside", async () => {
    await using priv = await tmpdir()
    await using project = await tmpdir({ git: true })
    await alias(path.join(project.path, "link"), priv.path)

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "link", "new.txt")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    expect(requests.length).toBe(1)
    expect(requests[0]!.permission).toBe("external_directory")
  })

  test("asks external_directory when overwriting an existing file through an alias pointing outside", async () => {
    await using priv = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "secret")
      },
    })
    await using project = await tmpdir({ git: true })
    await alias(path.join(project.path, "link"), priv.path)

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "link", "secret.txt")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    expect(requests.length).toBe(1)
    expect(requests[0]!.permission).toBe("external_directory")
  })

  test("no-ops for an alias resolving inside the project", async () => {
    await using project = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "sub", "file.txt"), "content")
      },
    })
    await alias(path.join(project.path, "alias"), path.join(project.path, "sub"))

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "alias", "file.txt")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    expect(requests.length).toBe(0)
  })

  test("asks for a dangling alias pointing outside", async () => {
    await using priv = await tmpdir()
    await using project = await tmpdir({ git: true })
    await alias(path.join(project.path, "dangle"), path.join(priv.path, "missing.txt"))

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "dangle", "extra.txt")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    expect(requests.length).toBe(1)
    expect(requests[0]!.permission).toBe("external_directory")
  })

  test("no-ops for a dangling alias resolving inside the project", async () => {
    await using project = await tmpdir({ git: true })
    await alias(path.join(project.path, "dangle"), path.join(project.path, "future", "x.txt"))

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "dangle")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    expect(requests.length).toBe(0)
  })

  test("asks when an alias cycle cannot be resolved", async () => {
    await using project = await tmpdir({ git: true })
    await alias(path.join(project.path, "c1"), path.join(project.path, "c2"))
    await alias(path.join(project.path, "c2"), path.join(project.path, "c1"))

    const { requests, ctx } = recorder()
    const target = path.join(project.path, "c1", "file.txt")
    await Instance.provide({ directory: project.path, fn: () => assertExternalDirectory(ctx, target) })

    expect(requests.length).toBe(1)
    expect(requests[0]!.permission).toBe("external_directory")
  })
})
