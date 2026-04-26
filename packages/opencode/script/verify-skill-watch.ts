/**
 * Verifies the skill watcher end-to-end.
 *
 * Scenarios covered:
 *   T1  modify skill description       → project cache cleared
 *   T2  add new skill                  → project cache cleared
 *   T3  delete skill                   → project cache cleared
 *   T4  two writes within 300ms        → debounce coalesces, final value visible
 *   T5  write non-SKILL.md file        → no spurious cache clear
 *   T6  modify global skill            → clearSkillsPromptCache clears ALL instances
 *   T7  modify project-A skill         → only project-A cleared; project-B memory untouched
 *   T8  modify .aether project skill   → project-A refreshes new value
 *   T9  add .aether project skill      → project-A discovers new skill
 *   T10 delete .aether dir (project)   → only project-A cache clears
 *   T11 delete .aether dir (global)    → ALL instances clear
 *   T12 add .aether global skill       → ALL instances discover new skill
 *
 * Usage:
 *   bun run --cwd packages/opencode script/verify-skill-watch.ts
 *
 * Options:
 *   --timeout <ms>   Per-test wait limit (default: 3000)
 *   --quiet          Suppress [skill watch/cache/perf] internal logs
 */

// ── 1. Bootstrap ─────────────────────────────────────────────────────────────
// XDG dirs must be set before ANY src/ import — xdg-basedir reads env at
// import time and Global.Path.cache derives from it.

import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "timers/promises"

const tmpRoot = path.join(os.tmpdir(), `skill-watch-verify-${Date.now()}`)
await fs.mkdir(tmpRoot, { recursive: true })

process.env["XDG_DATA_HOME"] = path.join(tmpRoot, "share")
process.env["XDG_CACHE_HOME"] = path.join(tmpRoot, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(tmpRoot, "config")
process.env["XDG_STATE_HOME"] = path.join(tmpRoot, "state")
process.env["OPENCODE_TEST_HOME"] = path.join(tmpRoot, "home")
process.env["OPENCODE_DB"] = ":memory:"
process.env["OPENCODE_DISABLE_DEFAULT_PLUGINS"] = "true"

// Prevent Global.init() from wiping the cache dir
const cacheDir = path.join(tmpRoot, "cache", "aether")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Now safe to import from src/
const { Global } = await import("../src/global")
const { Skill } = await import("../src/skill")
const { Instance } = await import("../src/project/instance")

await Global.ensureDirs()

// ── 2. CLI args ───────────────────────────────────────────────────────────────

function argVal(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const TIMEOUT_MS = parseInt(argVal("timeout") ?? "3000", 10)
const QUIET = process.argv.includes("--quiet")

if (QUIET) {
  const orig = console.log.bind(console)
  console.log = (...args: unknown[]) => {
    const first = String(args[0] ?? "")
    if (first.startsWith("[skill ")) return
    orig(...args)
  }
}

// ── 3. Helpers ────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const passMsg = (msg: string) => `${GREEN}✓${RESET} ${msg}`
const failMsg = (msg: string) => `${RED}✗${RESET} ${msg}`
const infoMsg = (msg: string) => `${YELLOW}·${RESET} ${msg}`

let passed = 0
let failed = 0

function skillMd(name: string, desc: string, body = "") {
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body || `# ${name}`}\n`
}

function skillPath(dir: string, skillName: string, root = ".claude") {
  return path.join(dir, root, "skills", skillName, "SKILL.md")
}

async function writeSkill(dir: string, skillName: string, desc: string, body?: string, root = ".claude") {
  const p = skillPath(dir, skillName, root)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, skillMd(skillName, desc, body))
}

async function deleteSkill(dir: string, skillName: string, root = ".claude") {
  await fs.rm(path.dirname(skillPath(dir, skillName, root)), { recursive: true, force: true })
}

/**
 * Poll Skill.all() via Instance until predicate holds or timeout expires.
 */
async function waitFor(
  directory: string,
  predicate: (skills: Awaited<ReturnType<typeof Skill.all>>) => boolean,
  timeoutMs = TIMEOUT_MS,
): Promise<{ ok: boolean; elapsed: number; skills: Awaited<ReturnType<typeof Skill.all>> }> {
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  let skills: Awaited<ReturnType<typeof Skill.all>> = []
  while (Date.now() < deadline) {
    skills = await Instance.provide({ directory, fn: () => Skill.all() })
    if (predicate(skills)) return { ok: true, elapsed: Date.now() - t0, skills }
    await sleep(100)
  }
  return { ok: false, elapsed: Date.now() - t0, skills }
}

// ── 4. Setup ──────────────────────────────────────────────────────────────────
//
// Directory layout:
//   tmpRoot/home/.claude/skills/global-skill/SKILL.md   ← global scope (seen by all instances)
//   tmpRoot/project/.claude/skills/*/SKILL.md            ← project-A scope
//   tmpRoot/project-b/.claude/skills/*/SKILL.md          ← project-B scope
//
// Instance strategy:
//   project-A is warmed first → watcher started (watches project-A dirs + global home dir).
//   project-B is warmed immediately after → WATCH_ENSURE=5000ms throttle prevents B from
//   getting its own watcher. B's state IS loaded into memory. For global events, A's watcher
//   calls clearSkillsPromptCache which invalidates B too. For project events, only A is touched.

const homeDir = path.join(tmpRoot, "home") // = Global.Path.home
const projectDir = path.join(tmpRoot, "project") // project-A
const projectBDir = path.join(tmpRoot, "project-b") // project-B

await fs.mkdir(projectDir, { recursive: true })
await fs.mkdir(projectBDir, { recursive: true })

// Pre-create all fixtures before the warm call so the watcher covers all dirs from the start
await writeSkill(homeDir, "global-skill", "global v1") // global scope
await writeSkill(projectDir, "skill-modify", "version 1")
await writeSkill(projectDir, "skill-delete", "will be deleted")
await writeSkill(projectDir, "skill-debounce", "debounce-v1")
await writeSkill(projectBDir, "skill-b", "skill-b v1") // project-B scope
await writeSkill(homeDir, "global-aether", "global-aether v1", undefined, ".aether")
await writeSkill(projectDir, "skill-aether", "aether-v1", undefined, ".aether")
await writeSkill(projectBDir, "skill-aether-b", "aether-b-v1", undefined, ".aether")
// skill-add does NOT exist yet

// Warm project-A: initializes Instance + watcher (subscribes to projectDir/.claude AND homeDir/.claude)
const initialA = await Instance.provide({ directory: projectDir, fn: () => Skill.all() })

// Warm project-B immediately (within 5s → ensure throttle means no watcher for B;
// state IS loaded into memory so clearSkillsPromptCache can reach B for global events)
const initialB = await Instance.provide({ directory: projectBDir, fn: () => Skill.all() })

console.log(`\n${BOLD}Skill watcher verification${RESET}  (timeout=${TIMEOUT_MS}ms per test)\n`)
console.log(
  infoMsg(
    `project-A initial: ${initialA.length} skill(s): ${initialA.map((s) => s.name).join(", ")} ${DIM}(watcher running)${RESET}`,
  ),
)
console.log(
  infoMsg(
    `project-B initial: ${initialB.length} skill(s): ${initialB.map((s) => s.name).join(", ")} ${DIM}(no watcher — ensure throttle)${RESET}`,
  ),
)
console.log()

// Between tests: wait WATCH_COOLDOWN(500ms) + buffer so the previous invalidation's cooldown
// period has expired before writing the next change.
const BETWEEN_MS = 600

// ── 5. Tests ──────────────────────────────────────────────────────────────────

// ── T1: modify description ────────────────────────────────────────────────────
{
  await writeSkill(projectDir, "skill-modify", "version 2")

  const { ok, elapsed, skills } = await waitFor(projectDir, (s) =>
    s.some((x) => x.name === "skill-modify" && x.description === "version 2"),
  )

  if (ok) {
    console.log(passMsg(`T1  modify skill description             (${elapsed}ms)`))
    passed++
  } else {
    const desc = skills.find((x) => x.name === "skill-modify")?.description ?? "(not found)"
    console.log(failMsg(`T1  modify skill description — still "${desc}" after ${TIMEOUT_MS}ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T8: modify .aether project skill ──────────────────────────────────────────
{
  await writeSkill(projectDir, "skill-aether", "aether-v2", undefined, ".aether")

  const { ok, elapsed, skills } = await waitFor(projectDir, (s) =>
    s.some((x) => x.name === "skill-aether" && x.description === "aether-v2"),
  )

  if (ok) {
    console.log(passMsg(`T8  modify .aether project skill          (${elapsed}ms)`))
    passed++
  } else {
    const desc = skills.find((x) => x.name === "skill-aether")?.description ?? "(not found)"
    console.log(failMsg(`T8  modify .aether project skill — still "${desc}" after ${TIMEOUT_MS}ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T9: add .aether project skill ─────────────────────────────────────────────
{
  await writeSkill(projectDir, "skill-aether-add", "aether-add-v1", undefined, ".aether")

  const { ok, elapsed } = await waitFor(projectDir, (s) => s.some((x) => x.name === "skill-aether-add"))

  if (ok) {
    console.log(passMsg(`T9  add .aether project skill             (${elapsed}ms)`))
    passed++
  } else {
    console.log(failMsg(`T9  add .aether project skill — not visible after ${TIMEOUT_MS}ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T10: delete project .aether directory; only project-A cache clears ────────
{
  await fs.rm(path.dirname(skillPath(projectBDir, "skill-aether-b", ".aether")), { recursive: true, force: true })
  await fs.rm(path.join(projectDir, ".aether"), { recursive: true, force: true })

  const resA = await waitFor(
    projectDir,
    (s) => !s.some((x) => x.name === "skill-aether") && !s.some((x) => x.name === "skill-aether-add"),
  )

  const skillsB = await Instance.provide({ directory: projectBDir, fn: () => Skill.all() })
  const bHas = skillsB.some((x) => x.name === "skill-aether-b")

  if (resA.ok && bHas) {
    console.log(passMsg(`T10 delete project .aether dir            A=${resA.elapsed}ms B still has skill-aether-b`))
    passed++
  } else if (!resA.ok) {
    console.log(failMsg(`T10 delete project .aether dir — project-A did not refresh within ${TIMEOUT_MS}ms`))
    failed++
  } else {
    console.log(failMsg(`T10 delete project .aether dir — project-B cache was incorrectly cleared`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T11: delete global .aether directory; all instances clear ─────────────────
{
  await fs.rm(path.join(homeDir, ".aether"), { recursive: true, force: true })

  const resA = await waitFor(projectDir, (s) => !s.some((x) => x.name === "global-aether"))
  const resB = await waitFor(projectBDir, (s) => !s.some((x) => x.name === "global-aether"), 1000)

  if (resA.ok && resB.ok) {
    console.log(passMsg(`T11 delete global .aether dir             A=${resA.elapsed}ms B=${resB.elapsed}ms`))
    passed++
  } else if (!resA.ok) {
    console.log(failMsg(`T11 delete global .aether dir — project-A still has global-aether after ${TIMEOUT_MS}ms`))
    failed++
  } else {
    console.log(failMsg(`T11 delete global .aether dir — project-B still has global-aether after 1000ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T12: add global .aether skill; all instances discover it ──────────────────
{
  await writeSkill(homeDir, "global-aether-2", "global-aether-2 v1", undefined, ".aether")

  const resA = await waitFor(projectDir, (s) => s.some((x) => x.name === "global-aether-2"))
  const resB = await waitFor(projectBDir, (s) => s.some((x) => x.name === "global-aether-2"), TIMEOUT_MS)

  if (resA.ok && resB.ok) {
    console.log(passMsg(`T12 add global .aether skill              A=${resA.elapsed}ms B=${resB.elapsed}ms`))
    passed++
  } else if (!resA.ok) {
    console.log(failMsg(`T12 add global .aether skill — project-A did not discover it within ${TIMEOUT_MS}ms`))
    failed++
  } else {
    console.log(failMsg(`T12 add global .aether skill — project-B did not discover it within ${TIMEOUT_MS}ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T2: add a new skill ───────────────────────────────────────────────────────
{
  await writeSkill(projectDir, "skill-add", "brand new skill")

  const { ok, elapsed } = await waitFor(projectDir, (s) => s.some((x) => x.name === "skill-add"))

  if (ok) {
    console.log(passMsg(`T2  add new skill                        (${elapsed}ms)`))
    passed++
  } else {
    console.log(failMsg(`T2  add new skill — skill-add not visible after ${TIMEOUT_MS}ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T3: delete a skill ────────────────────────────────────────────────────────
{
  await deleteSkill(projectDir, "skill-delete")

  const { ok, elapsed } = await waitFor(projectDir, (s) => !s.some((x) => x.name === "skill-delete"))

  if (ok) {
    console.log(passMsg(`T3  delete skill                         (${elapsed}ms)`))
    passed++
  } else {
    console.log(failMsg(`T3  delete skill — skill-delete still present after ${TIMEOUT_MS}ms`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T4: rapid debounce — two writes within 300ms coalesce into one flush ──────
//
// Write v2, then write v3 50ms later (well within the 300ms debounce window).
// The second write resets the timer; only one flush fires 300ms after v3.
// The cache reloads from disk and must see v3, not the intermediate v2.
{
  await writeSkill(projectDir, "skill-debounce", "debounce-v2")
  await sleep(50)
  await writeSkill(projectDir, "skill-debounce", "debounce-v3")

  const { ok, elapsed, skills } = await waitFor(projectDir, (s) =>
    s.some((x) => x.name === "skill-debounce" && x.description === "debounce-v3"),
  )

  if (ok) {
    console.log(passMsg(`T4  rapid debounce (2 writes → final val)  (${elapsed}ms)`))
    passed++
  } else {
    const desc = skills.find((x) => x.name === "skill-debounce")?.description ?? "(not found)"
    console.log(failMsg(`T4  rapid debounce — got "${desc}" after ${TIMEOUT_MS}ms, expected "debounce-v3"`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T5: non-SKILL.md file change must not alter the skill list ────────────────
//
// Writing any other file should not trigger a flush (the queue() early-return fix).
// Verified by checking the skill count is unchanged after a 600ms settle window.
{
  const before = await Instance.provide({ directory: projectDir, fn: () => Skill.all() })
  await fs.writeFile(path.join(projectDir, "random.txt"), "not a skill")
  await sleep(600) // let any potential spurious flush + reload complete
  const after = await Instance.provide({ directory: projectDir, fn: () => Skill.all() })

  if (after.length === before.length) {
    console.log(passMsg(`T5  non-SKILL.md write → list unchanged`))
    passed++
  } else {
    console.log(failMsg(`T5  non-SKILL.md write → count changed: before=${before.length} after=${after.length}`))
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T6: global scope — watcher calls clearSkillsPromptCache → ALL instances ──
//
// project-A's watcher watches homeDir/.claude (global scope). When global-skill
// changes, flush() sees hasGlobal=true and calls clearSkillsPromptCache, which
// iterates Instance.dirs() and invalidates BOTH project-A and project-B.
{
  await writeSkill(homeDir, "global-skill", "global v2")

  // Wait for project-A to see the global change
  const resA = await waitFor(projectDir, (s) =>
    s.some((x) => x.name === "global-skill" && x.description === "global v2"),
  )

  // project-B's cache was also cleared by clearSkillsPromptCache; reload finds v2
  const resB = await waitFor(
    projectBDir,
    (s) => s.some((x) => x.name === "global-skill" && x.description === "global v2"),
    1000, // should be near-instant since A's flush already ran
  )

  if (resA.ok && resB.ok) {
    console.log(passMsg(`T6  global scope → all instances cleared   A=${resA.elapsed}ms B=${resB.elapsed}ms`))
    passed++
  } else if (!resA.ok) {
    console.log(failMsg(`T6  global scope — project-A did not see "global v2" after ${TIMEOUT_MS}ms`))
    failed++
  } else {
    console.log(
      failMsg(
        `T6  global scope — project-B did not see "global v2" after 1000ms (clearSkillsPromptCache may not have reached B)`,
      ),
    )
    failed++
  }
}

await sleep(BETWEEN_MS)

// ── T7: project scope — only the triggering instance's cache is cleared ───────
//
// Method:
//   1. Delete skill-b from disk. project-B has no watcher (ensure throttle), so
//      no event fires — B's in-memory cache still holds skill-b.
//   2. Modify a skill in project-A to trigger A's project-scope flush.
//      flush() uses Instance.provide({ directory: ctx.directory }) — only A is cleared.
//   3. After A's flush completes (verified by A seeing the new value), query B.
//      If flush incorrectly called clearSkillsPromptCache (global), B's cache would
//      be wiped, reload from disk would find no skill-b → test fails.
//      If flush correctly only cleared A, B still returns skill-b from memory → pass.
{
  // Step 1: remove skill-b from disk without triggering any watcher event
  await fs.rm(path.dirname(skillPath(projectBDir, "skill-b")), { recursive: true, force: true })

  // Step 2: trigger project-A's watcher → project-scope flush → only A cleared
  await writeSkill(projectDir, "skill-modify", "version 3")

  const resA = await waitFor(projectDir, (s) =>
    s.some((x) => x.name === "skill-modify" && x.description === "version 3"),
  )

  // Step 3: query project-B — must still have skill-b from its in-memory cache
  const skillsB = await Instance.provide({ directory: projectBDir, fn: () => Skill.all() })
  const bHasSkillB = skillsB.some((x) => x.name === "skill-b")

  if (resA.ok && bHasSkillB) {
    console.log(passMsg(`T7  project scope → only project-A cleared  A=${resA.elapsed}ms B still has skill-b`))
    passed++
  } else if (!resA.ok) {
    console.log(failMsg(`T7  project scope — project-A flush did not happen within ${TIMEOUT_MS}ms`))
    failed++
  } else {
    console.log(
      failMsg(
        `T7  project scope — project-B cache was incorrectly cleared (B lost skill-b after A's project-scope flush)`,
      ),
    )
    failed++
  }
}

// ── 6. Summary ────────────────────────────────────────────────────────────────

console.log()
if (failed === 0) {
  console.log(`${GREEN}${BOLD}All ${passed} tests passed${RESET}`)
} else {
  console.log(`${RED}${BOLD}${failed} of ${passed + failed} tests failed${RESET}`)
}

// ── 7. Cleanup ────────────────────────────────────────────────────────────────

await Instance.disposeAll()
await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
process.exit(failed > 0 ? 1 : 0)
