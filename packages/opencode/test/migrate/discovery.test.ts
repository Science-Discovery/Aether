import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFile, cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { detect, detectFile, list, read } from "../../src/migrate"
import { tmpdir } from "../fixture/fixture"

const fixture = (file: string) => path.join(import.meta.dir, "fixtures", file)
const claudeID = "10000000-0000-4000-8000-000000000000"
const codexID = "20000000-0000-4000-8000-000000000000"
const piID = "11111111-1111-4111-8111-111111111111"
const copilotID = "33333333-3333-4333-8333-333333333333"
const kimiID = "session_0e9113f5-23d9-4ad4-8a94-a3f44c175d14"
const qwenID = "44c47f3e-ccfe-4fb7-aa06-0217dc950456"
const museID = "74747474-7474-4747-8747-747474747474"
const grokID = "95959595-9595-4959-8959-959595959595"
const openhandsID = "99e61c51f6e945cc93b022fee3a459f4"
const qoderID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const qodercnID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const codebuddyID = "01a0f1c7-5e3a-7c41-9b8d-6f2a4e8d1b30"

async function copy(source: string, target: string) {
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
}

describe("migrate discovery", () => {
  test("detects default roots and lists sessions", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home")
    const cwd = path.join(dir.path, "work")
    await mkdir(cwd, { recursive: true })
    await copy(fixture("claude/basic.jsonl"), path.join(home, ".claude/projects/-work", `${claudeID}.jsonl`))
    await copy(
      fixture("codex/basic.jsonl"),
      path.join(home, ".codex/sessions/2026/08/17", `rollout-2026-08-17T13-00-00-${codexID}.jsonl`),
    )
    await copy(
      fixture("pi/basic.jsonl"),
      path.join(home, ".pi/agent/sessions/--work--", `2026-08-18T12-00-00-000Z_${piID}.jsonl`),
    )
    await copy(fixture("copilot/events.jsonl"), path.join(home, ".copilot/session-state", copilotID, "events.jsonl"))
    await mkdir(path.join(home, ".local/share/opencode"), { recursive: true })
    const db = new Database(path.join(home, ".local/share/opencode/opencode.db"))
    db.run("create table session (id text primary key, title text, directory text, time_updated integer)")
    db.run("insert into session values ('ses_db_fixture', 'Database Fixture', '/work', 123)")
    db.close()

    const ctx = { home, cwd, env: {} }
    const found = await detect(ctx)
    expect(found.find((item) => item.id === "claude")?.sessions).toBe(1)
    expect(found.find((item) => item.id === "codex")?.sessions).toBe(1)
    expect(found.find((item) => item.id === "pi")?.sessions).toBe(1)
    expect(found.find((item) => item.id === "copilot")?.sessions).toBe(1)
    expect(found.find((item) => item.id === "opencode")?.roots[0]?.path).toBe(path.join(home, ".local/share/opencode"))

    expect((await list("claude", ctx)).map((item) => item.id)).toContain(claudeID)
    expect((await list("codex", ctx)).map((item) => item.id)).toContain(codexID)
    expect((await list("pi", ctx)).map((item) => item.id)).toContain(piID)
    expect((await list("copilot", ctx)).map((item) => item.id)).toContain(copilotID)
    expect(await list("opencode", ctx)).toEqual([
      {
        source: "opencode",
        id: "ses_db_fixture",
        path: "opencode:ses_db_fixture",
        title: "Database Fixture",
        cwd: "/work",
        updated: 123,
      },
    ])

    expect((await read("claude", { id: claudeID, ctx })).source).toBe("claude")
    expect((await read("codex", { id: codexID, ctx })).source).toBe("codex")
    expect((await read("pi", { id: piID, ctx })).source).toBe("pi")
    expect((await read("copilot", { id: copilotID, ctx })).source).toBe("copilot")
  })

  test("detects project-local roots", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home")
    const cwd = path.join(dir.path, "project")
    await copy(fixture("claude/basic.jsonl"), path.join(cwd, ".claude/projects/-work", `${claudeID}.jsonl`))
    const found = await detect({ home, cwd, env: {} })
    const root = found.find((item) => item.id === "claude")?.roots.find((item) => item.origin === "project")
    expect(root?.path).toBe(path.join(cwd, ".claude"))
  })

  test("expands home-relative environment roots", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home")
    const cwd = path.join(dir.path, "work")
    await mkdir(cwd, { recursive: true })
    await copy(fixture("claude/basic.jsonl"), path.join(home, "alt-claude/projects/-work", `${claudeID}.jsonl`))
    const found = await detect({ home, cwd, env: { CLAUDE_CONFIG_DIR: "~\\alt-claude" } })
    const root = found.find((item) => item.id === "claude")?.roots.find((item) => item.origin === "environment")
    expect(root?.path).toBe(path.join(home, "alt-claude"))
  })

  test("detects source files", async () => {
    expect(await detectFile(fixture("claude/basic.jsonl"))).toBe("claude")
    expect(await detectFile(fixture("codex/basic.jsonl"))).toBe("codex")
    expect(await detectFile(fixture("pi/basic.jsonl"))).toBe("pi")
    expect(await detectFile(fixture("copilot/events.jsonl"))).toBe("copilot")
    expect(await detectFile(fixture("opencode/basic.json"))).toBe("opencode")
    expect(await detectFile(path.join(import.meta.dir, "fixtures/copilot"))).toBe("copilot")
    expect((await read("copilot", { path: path.join(import.meta.dir, "fixtures/copilot") })).source).toBe("copilot")
  })

  test("finds native source roots", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home")
    const ctx = { home, cwd: path.join(dir.path, "work"), env: {} }
    await mkdir(ctx.cwd, { recursive: true })
    await mkdir(path.join(home, ".omp/agent/sessions/--work--"), { recursive: true })
    await cp(fixture("omp/basic.jsonl"), path.join(home, ".omp/agent/sessions/--work--/basic.jsonl"))
    await mkdir(path.join(home, ".qwen/projects/-work/chats"), { recursive: true })
    await cp(fixture("qwen/basic.jsonl"), path.join(home, ".qwen/projects/-work/chats", `${qwenID}.jsonl`))
    await mkdir(path.join(home, ".kimi-code/sessions/wd_work_fixture"), { recursive: true })
    await cp(fixture(`kimi/${kimiID}`), path.join(home, ".kimi-code/sessions/wd_work_fixture", kimiID), { recursive: true })
    await mkdir(path.join(home, ".vibe/logs/session"), { recursive: true })
    await cp(fixture("vibe/basic"), path.join(home, ".vibe/logs/session/session_fixture"), { recursive: true })
    await mkdir(path.join(home, ".grok/sessions/fixture-cwd"), { recursive: true })
    await cp(fixture("grok/session"), path.join(home, ".grok/sessions/fixture-cwd", grokID), { recursive: true })
    await mkdir(path.join(home, ".openhands/conversations"), { recursive: true })
    await cp(fixture(`openhands/${openhandsID}`), path.join(home, ".openhands/conversations", openhandsID), { recursive: true })
    await mkdir(path.join(home, ".local/share/muse/sessions/2026/08/31", museID), { recursive: true })
    await cp(fixture("muse/session.jsonl"), path.join(home, ".local/share/muse/sessions/2026/08/31", museID, "session.jsonl"))

    const found = await detect(ctx)
    for (const id of ["omp", "qwen", "kimi", "vibe", "muse", "grok", "openhands"]) {
      expect(found.find((item) => item.id === id)?.sessions).toBe(1)
    }

    expect((await read("qwen", { id: qwenID, ctx })).source).toBe("qwen")
    expect((await read("kimi", { id: kimiID.replace(/^session_/, ""), ctx })).source).toBe("kimi")
    expect((await read("vibe", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ctx })).source).toBe("vibe")
    expect((await read("muse", { id: museID, ctx })).source).toBe("muse")
    expect((await read("grok", { id: grokID, ctx })).source).toBe("grok")
    expect((await read("openhands", { id: "99e61c51-f6e9-45cc-93b0-22fee3a459f4", ctx })).source).toBe("openhands")
  })

  test("finds Qoder, Qoder CN and CodeBuddy roots", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home")
    const cwd = path.join(dir.path, "work")
    await mkdir(cwd, { recursive: true })
    const targets = [
      [".qoder/projects/-work", `${qoderID}.jsonl`, "qoder/basic.jsonl"],
      [".qoder-cn/projects/-work", `${qodercnID}.jsonl`, "qodercn/basic.jsonl"],
      [".codebuddy/projects/-work", `${codebuddyID}.jsonl`, "codebuddy/basic.jsonl"],
    ] as const
    for (const [directory, name, source] of targets) {
      await copy(fixture(source), path.join(home, directory, name))
    }
    const ctx = { home, cwd, env: {} }
    const found = await detect(ctx)
    expect(found.find((item) => item.id === "qoder")?.sessions).toBe(1)
    expect(found.find((item) => item.id === "qodercn")?.sessions).toBe(1)
    expect(found.find((item) => item.id === "codebuddy")?.sessions).toBe(1)

    const qoderRef = (await list("qoder", ctx, { titles: true }))[0]
    expect(qoderRef?.title).toBe("QODER_TITLE")
    expect(qoderRef?.cwd).toBe("/work")
    expect((await list("qodercn", ctx, { titles: true }))[0]?.title).toBe("QODERCN_TITLE")
    expect((await list("codebuddy", ctx, { titles: true }))[0]?.title).toBe("CODEBUDDY_TITLE")
    expect((await read("qoder", { id: qoderID, ctx })).source).toBe("qoder")
    expect((await read("qodercn", { id: qodercnID, ctx })).source).toBe("qodercn")
    expect((await read("codebuddy", { id: codebuddyID, ctx })).source).toBe("codebuddy")

    expect(await detectFile(path.join(home, ".qoder/projects/-work", `${qoderID}.jsonl`))).toBe("qoder")
    expect(await detectFile(path.join(home, ".qoder-cn/projects/-work", `${qodercnID}.jsonl`))).toBe("qodercn")
    expect(await detectFile(path.join(home, ".codebuddy/projects/-work", `${codebuddyID}.jsonl`))).toBe("codebuddy")
  })
})
