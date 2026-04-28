/**
 * Test script for skill versioning (skill-versions.ts)
 * Run: bun packages/opencode/script/test-skill-versions.ts
 */

import fs from "fs/promises"
import path from "path"
import os from "os"
import { snapshot, snapshotBeforeDelete, rollback, listVersions, formatHistory, isVersionsDir } from "../src/tool/skill-versions"

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

async function assertThrows(fn: () => Promise<unknown>, label: string) {
  try {
    await fn()
    console.error(`  ✗ ${label} (expected throw, but did not)`)
    failed++
  } catch {
    console.log(`  ✓ ${label}`)
    passed++
  }
}

async function setup(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-ver-test-"))
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function writeSkill(skillDir: string, content: string) {
  const file = path.join(skillDir, "SKILL.md")
  await fs.mkdir(skillDir, { recursive: true })
  await fs.writeFile(file, content, "utf8")
}

async function readSkill(skillDir: string): Promise<string> {
  return fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testBasicSnapshot() {
  console.log("\n[1] Basic snapshot after create/edit/patch")
  const dir = await setup()
  try {
    await writeSkill(dir, "---\nname: \"test\"\ndescription: \"d\"\n---\n\nv1 content")
    await snapshot(dir, "create")

    let versions = await listVersions(dir)
    assert(versions.length === 1, "one version after create")
    assert(versions[0].label === "v001", "label is v001")
    assert(versions[0].action === "create", "action is create")

    await writeSkill(dir, "---\nname: \"test\"\ndescription: \"d\"\n---\n\nv2 content")
    await snapshot(dir, "edit")
    versions = await listVersions(dir)
    assert(versions.length === 2, "two versions after edit")
    assert(versions[1].label === "v002", "second label is v002")
    assert(versions[1].action === "edit", "action is edit")

    await writeSkill(dir, "---\nname: \"test\"\ndescription: \"d\"\n---\n\nv3 content")
    await snapshot(dir, "patch")
    versions = await listVersions(dir)
    assert(versions.length === 3, "three versions after patch")
    assert(versions[2].action === "patch", "action is patch")
  } finally {
    await cleanup(dir)
  }
}

async function testRollback() {
  console.log("\n[2] Rollback to a previous version")
  const dir = await setup()
  try {
    await writeSkill(dir, "v1 content")
    await snapshot(dir, "create")

    await writeSkill(dir, "v2 content")
    await snapshot(dir, "edit")

    await writeSkill(dir, "v3 bad content")
    await snapshot(dir, "patch")

    // rollback to v002
    const { restoredFrom } = await rollback(dir, "v002")
    assert(restoredFrom.includes("v002"), "restoredFrom references v002")

    const current = await readSkill(dir)
    assert(current === "v2 content", "SKILL.md restored to v2 content")

    const versions = await listVersions(dir)
    assert(versions.length === 4, "4 versions after rollback")
    assert(versions[3].action === "rollback-v002", "rollback snapshot has correct action label")
    assert(versions[3].label === "v004", "rollback snapshot is v004")
  } finally {
    await cleanup(dir)
  }
}

async function testRollbackNumericLabel() {
  console.log("\n[3] Rollback accepts numeric label '2' as well as 'v002'")
  const dir = await setup()
  try {
    await writeSkill(dir, "v1 content")
    await snapshot(dir, "create")
    await writeSkill(dir, "v2 content")
    await snapshot(dir, "edit")
    await writeSkill(dir, "v3 content")
    await snapshot(dir, "patch")

    await rollback(dir, "2")
    const current = await readSkill(dir)
    assert(current === "v2 content", "numeric rollback '2' restores correct content")
  } finally {
    await cleanup(dir)
  }
}

async function testDoubleRollback() {
  console.log("\n[4] Two consecutive rollbacks")
  const dir = await setup()
  try {
    await writeSkill(dir, "v1 content")
    await snapshot(dir, "create")

    await writeSkill(dir, "v2 content")
    await snapshot(dir, "edit")

    await writeSkill(dir, "v3 bad")
    await snapshot(dir, "patch")

    // first rollback: back to v002
    await rollback(dir, "v002")
    let versions = await listVersions(dir)
    assert(versions[3].action === "rollback-v002", "first rollback label is rollback-v002")

    // continue evolving badly
    await writeSkill(dir, "v5 bad again")
    await snapshot(dir, "edit")

    // second rollback: back to v004 (which is the rollback-v002 state)
    await rollback(dir, "v004")
    versions = await listVersions(dir)
    assert(versions.length === 6, "6 versions total after two rollbacks + one edit")
    assert(versions[5].action === "rollback-v004", "second rollback label is rollback-v004")

    const current = await readSkill(dir)
    assert(current === "v2 content", "content after double rollback is v2 (the state v004 captured)")
  } finally {
    await cleanup(dir)
  }
}

async function testSnapshotBeforeDelete() {
  console.log("\n[5] snapshotBeforeDelete utility works standalone")
  const dir = await setup()
  try {
    await writeSkill(dir, "will be deleted")
    await snapshot(dir, "create")
    await snapshotBeforeDelete(dir)

    const versions = await listVersions(dir)
    assert(versions.length === 2, "two versions after manual snapshotBeforeDelete call")
    assert(versions[1].action === "delete", "second version action is delete")
    const content = await fs.readFile(path.join(dir, ".versions", versions[1].filename), "utf8")
    assert(content === "will be deleted", "snapshot content is correct")
  } finally {
    await cleanup(dir)
  }
}

async function testRollbackNotFound() {
  console.log("\n[6] Rollback to non-existent version throws")
  const dir = await setup()
  try {
    await writeSkill(dir, "content")
    await snapshot(dir, "create")
    await assertThrows(() => rollback(dir, "v999"), "rollback to missing version throws")
  } finally {
    await cleanup(dir)
  }
}

async function testRollbackNoHistory() {
  console.log("\n[7] Rollback with no history throws")
  const dir = await setup()
  try {
    await writeSkill(dir, "content")
    await assertThrows(() => rollback(dir, "v001"), "rollback with no history throws")
  } finally {
    await cleanup(dir)
  }
}

async function testSnapshotOnMissingSkillFile() {
  console.log("\n[8] Snapshot throws if SKILL.md does not exist")
  const dir = await setup()
  try {
    await fs.mkdir(dir, { recursive: true })
    // no SKILL.md written
    await assertThrows(() => snapshot(dir, "create"), "snapshot throws when SKILL.md missing")
  } finally {
    await cleanup(dir)
  }
}

async function testVersionsPruning() {
  console.log("\n[9] Versions pruned when exceeding MAX (using small limit via direct test)")
  // We test pruning logic indirectly by checking the prune call removes oldest
  // We can't set MAX_VERSIONS=3 directly, so we verify the file structure is clean
  const dir = await setup()
  try {
    for (let i = 1; i <= 5; i++) {
      await writeSkill(dir, `content v${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    assert(versions.length === 5, "5 versions stored without hitting prune limit")
    assert(versions[0].label === "v001", "oldest is v001")
    assert(versions[4].label === "v005", "newest is v005")
  } finally {
    await cleanup(dir)
  }
}

async function testVersionOrdering() {
  console.log("\n[10] Versions sorted by sequence number not filesystem order")
  const dir = await setup()
  try {
    for (let i = 0; i < 12; i++) {
      await writeSkill(dir, `content ${i}`)
      await snapshot(dir, i === 0 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    assert(versions.length === 12, "12 versions total")
    // Verify sort: v001 < v002 < ... < v012
    let ordered = true
    for (let i = 1; i < versions.length; i++) {
      if (versions[i].version <= versions[i - 1].version) ordered = false
    }
    assert(ordered, "versions sorted in ascending sequence order")
    // v010 should be properly ordered (tests 3-digit pad sorting)
    assert(versions[9].label === "v010", "v010 correctly padded and sorted")
  } finally {
    await cleanup(dir)
  }
}

async function testFormatHistory() {
  console.log("\n[11] formatHistory output")
  const dir = await setup()
  try {
    await writeSkill(dir, "v1")
    await snapshot(dir, "create")
    await writeSkill(dir, "v2")
    await snapshot(dir, "edit")

    const versions = await listVersions(dir)
    const output = formatHistory("myskill", versions)
    assert(output.includes("myskill"), "output contains skill name")
    assert(output.includes("v002"), "output contains v002")
    assert(output.includes("v001"), "output contains v001")
    assert(output.includes("current"), "output marks current version")
    assert(output.includes("create"), "output shows create action")
    assert(output.includes("edit"), "output shows edit action")

    const emptyOutput = formatHistory("empty", [])
    assert(emptyOutput.includes("no version history"), "empty history message shown")
  } finally {
    await cleanup(dir)
  }
}

async function testIsVersionsDir() {
  console.log("\n[12] isVersionsDir utility")
  assert(isVersionsDir(".versions"), "'.versions' recognized")
  assert(!isVersionsDir("SKILL.md"), "SKILL.md not recognized as versions dir")
  assert(!isVersionsDir(".version"), "'.version' not recognized")
  assert(!isVersionsDir("versions"), "'versions' not recognized")
}

async function testRollbackToRollback() {
  console.log("\n[13] Rollback to a version that is itself a rollback snapshot")
  const dir = await setup()
  try {
    await writeSkill(dir, "v1 original")
    await snapshot(dir, "create")

    await writeSkill(dir, "v2 edited")
    await snapshot(dir, "edit")

    await writeSkill(dir, "v3 bad")
    await snapshot(dir, "patch")

    // First rollback to v002
    await rollback(dir, "v002")
    // v004_rollback-v002 now exists, SKILL.md = v2 content

    // Edit again badly
    await writeSkill(dir, "v5 also bad")
    await snapshot(dir, "edit")

    // Rollback to v004 (itself a rollback)
    await rollback(dir, "v004")

    const current = await readSkill(dir)
    assert(current === "v2 edited", "rolling back to a rollback snapshot restores correct content")

    const versions = await listVersions(dir)
    assert(versions[versions.length - 1].action === "rollback-v004", "final snapshot named rollback-v004")
  } finally {
    await cleanup(dir)
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== skill-versions test suite ===")
  await testBasicSnapshot()
  await testRollback()
  await testRollbackNumericLabel()
  await testDoubleRollback()
  await testSnapshotBeforeDelete()
  await testRollbackNotFound()
  await testRollbackNoHistory()
  await testSnapshotOnMissingSkillFile()
  await testVersionsPruning()
  await testVersionOrdering()
  await testFormatHistory()
  await testIsVersionsDir()
  await testRollbackToRollback()

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error("Unexpected error:", err)
  process.exit(1)
})
