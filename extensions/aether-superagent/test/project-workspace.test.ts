import { test, expect } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { canonical, git, outside, prepare, resolveProject } from "../src/workspace"
import { Engine } from "../src/engine"
import { Aether } from "../src/aether"
import { Store } from "../src/store"

async function fixture() {
  const parent = path.join(homedir(), "data/aether-superagent-tests")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "project-workspace-"))
  const source = path.join(root, "source")
  const state = path.join(root, "state")
  await mkdir(source)
  return { root, source, state }
}

async function commit(repo: string) {
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture")
}

test("new project initializes only metadata and an empty baseline; parallel requests share it", async () => {
  const f = await fixture()
  await writeFile(path.join(f.source, "STATUS.txt"), "live work in progress\n")
  const [a, b] = await Promise.all([resolveProject(f.source, f.state), resolveProject(f.source, f.state)])
  expect(a.directory).toBe(f.source)
  expect(a.base).toBe(b.base)
  expect(a.initialized).toBe(true)
  expect(await git(f.source, "ls-tree", "-r", "HEAD")).toBe("")
  expect(await git(f.source, "status", "--porcelain")).toContain("?? STATUS.txt")
  expect(await readFile(path.join(f.source, "STATUS.txt"), "utf8")).toBe("live work in progress\n")
  await prepare(a.repo!, path.join(f.state, "worker"), "fixture", a.base!)
  expect(await git(path.join(f.state, "worker"), "ls-tree", "-r", "HEAD")).toBe("")
})

test("unborn repository retains index bytes, staged files, config, and does not run user hooks", async () => {
  const f = await fixture()
  await git(f.source, "init")
  await writeFile(path.join(f.source, "staged.txt"), "staged\n")
  await git(f.source, "add", "staged.txt")
  await writeFile(path.join(f.source, "staged.txt"), "dirty staged\n")
  const hooks = path.join(f.root, "hooks")
  await mkdir(hooks)
  const marker = path.join(f.root, "HOOK_RAN")
  for (const name of ["reference-transaction", "post-checkout"])
    await writeFile(path.join(hooks, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  await git(f.source, "config", "core.hooksPath", hooks)
  const index = await readFile(path.join(f.source, ".git/index"))
  const config = await readFile(path.join(f.source, ".git/config"))
  const project = await resolveProject(f.source, f.state)
  expect(await readFile(path.join(f.source, ".git/index"))).toEqual(index)
  expect(await readFile(path.join(f.source, ".git/config"))).toEqual(config)
  expect(await git(f.source, "ls-tree", "-r", "HEAD")).toBe("")
  expect(await git(f.source, "show", ":staged.txt")).toBe("staged")
  expect(await readFile(path.join(f.source, "staged.txt"), "utf8")).toBe("dirty staged\n")
  await prepare(project.repo!, path.join(f.state, "worker"), "unborn", project.base!)
  expect(await stat(marker).then(() => true).catch(() => false)).toBe(false)
})

test("existing dirty nested and linked-worktree projects reuse Git while preserving selected live directory", async () => {
  const f = await fixture()
  await git(f.source, "init")
  await writeFile(path.join(f.source, "tracked.txt"), "initial")
  await git(f.source, "add", "tracked.txt")
  await commit(f.source)
  const head = await git(f.source, "rev-parse", "HEAD")
  await writeFile(path.join(f.source, "tracked.txt"), "staged")
  await git(f.source, "add", "tracked.txt")
  await writeFile(path.join(f.source, "tracked.txt"), "unstaged")
  const index = await readFile(path.join(f.source, ".git/index"))
  const nested = path.join(f.source, "analysis")
  await mkdir(nested)
  const project = await resolveProject(nested, f.state)
  expect(project).toEqual({ directory: nested, repo: f.source, base: head })
  expect(await readFile(path.join(f.source, ".git/index"))).toEqual(index)
  expect(await git(f.source, "rev-parse", "HEAD")).toBe(head)
  const linked = path.join(f.root, "linked")
  await git(f.source, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "linked", linked)
  const worktree = await resolveProject(linked, f.state)
  expect(worktree.repo).toBe(linked)
  expect(worktree.base).toBe(head)
})

test("missing paths, malformed or dangling Git metadata, bare repositories and nested state fail closed", async () => {
  const f = await fixture()
  await expect(resolveProject(path.join(f.root, "missing"), f.state)).rejects.toThrow()
  expect(await stat(path.join(f.root, "missing")).then(() => true).catch(() => false)).toBe(false)
  await writeFile(path.join(f.source, ".git"), "invalid git metadata")
  await expect(resolveProject(f.source, f.state)).rejects.toThrow()
  expect(await readFile(path.join(f.source, ".git"), "utf8")).toBe("invalid git metadata")
  const dangling = path.join(f.root, "dangling")
  await mkdir(dangling)
  await symlink(path.join(f.root, "absent-meta"), path.join(dangling, ".git"))
  await expect(resolveProject(dangling, f.state)).rejects.toThrow()
  const bare = path.join(f.root, "bare")
  await git(f.root, "init", "--bare", bare)
  await expect(resolveProject(bare, f.state)).rejects.toThrow()
  expect(() => outside("/", f.state)).toThrow("must not contain")
  expect(() => outside(f.source, "/")).toThrow("must not contain")
  expect(() => canonical("relative")).toThrow("absolute")
  const valid = path.join(f.root, "valid")
  await mkdir(valid)
  await git(valid, "init")
  await commit(valid)
  const nested = path.join(valid, "sub")
  await mkdir(nested)
  await expect(resolveProject(nested, path.join(valid, "state"))).rejects.toThrow("must not contain")
})

test("tasks bind separate projects immutably, restart without default and preserve explicit router selection", async () => {
  const f = await fixture()
  const other = path.join(f.root, "other")
  await mkdir(other)
  const store = new Store(path.join(f.root, "state.db"))
  const api = new Aether("http://127.0.0.1:1")
  const cfg = { state: f.state, workers: 2 }
  let engine = new Engine(store, api, cfg)
  try {
    expect(() => engine.submit("bad", "inspect", undefined, "task")).toThrow("project directory")
    const a = engine.submit("a", "monitor source", undefined, "A", undefined, f.source)
    const b = engine.submit("b", "monitor other", undefined, "B", undefined, other)
    expect(engine.project(a.ticket!)?.directory).toBe(f.source)
    expect(engine.project(b.ticket!)?.directory).toBe(other)
    expect(() => engine.submit("a", "monitor source", undefined, "A", undefined, other)).toThrow("Idempotency")
    expect(() => engine.submit("change", "continue", a.ticket!, undefined, undefined, other)).toThrow("cannot be changed")
    engine = new Engine(store, api, cfg)
    expect(engine.project(a.ticket!)?.directory).toBe(f.source)
    const input = engine.submit("route", "inspect this", undefined, undefined, undefined, f.source)
    store.put({ ...input, state: "dispatching" })
    expect(() => engine.complete(input, { info: { id: "msg_answer", role: "assistant", parentID: input.message, structured: {
      action: "create", title: "wrong", ticket: "", text: "inspect", project: other,
    } }, parts: [] })).toThrow("cannot override")
  } finally { store.db.close() }
})

test("legacy project provenance survives config removal without changing worker session or directory", async () => {
  const f = await fixture()
  const store = new Store(path.join(f.root, "legacy.db"))
  store.setting("identity", JSON.stringify({ repo: f.source, backend: "http://127.0.0.1:1/" }))
  store.setting("base", "legacy-fixed-hash")
  const ticket = { id: "legacy", title: "old", session: "ses_legacy", directory: path.join(f.state, "old-work"), state: "waiting" as const, result: "old" }
  store.save(ticket)
  try {
    const engine = new Engine(store, new Aether("http://127.0.0.1:1"), { state: f.state, workers: 1 })
    expect(engine.project(ticket.id)).toEqual({ directory: f.source, repo: f.source, base: "legacy-fixed-hash" })
    expect(store.ticket(ticket.id)).toEqual(ticket)
    engine.submit("followup", "continue", ticket.id)
    expect(engine.project(ticket.id)?.base).toBe("legacy-fixed-hash")
  } finally { store.db.close() }
})


test("empty Git marker on a strict ancestor does not prevent initializing its selected child", async () => {
  const f = await fixture()
  await mkdir(path.join(f.root, ".git"))
  const project = await resolveProject(f.source, f.state)
  expect(project.initialized).toBe(true)
  expect(await git(f.source, "ls-tree", "-r", "HEAD")).toBe("")
  await expect((await import("node:fs/promises")).readdir(path.join(f.root, ".git"))).resolves.toEqual([])
  const empty = path.join(f.root, "empty-own")
  await mkdir(path.join(empty, ".git"), { recursive: true })
  await expect(resolveProject(empty, f.state)).rejects.toThrow("Existing Git metadata")
})
