/**
 * Test suite for skill-versions.ts (bundle format)
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

async function assertThrowsMsg(fn: () => Promise<unknown>, substr: string, label: string) {
  try {
    await fn()
    console.error(`  ✗ ${label} (expected throw, but did not)`)
    failed++
  } catch (e: any) {
    if (String(e?.message ?? e).includes(substr)) {
      console.log(`  ✓ ${label}`)
      passed++
    } else {
      console.error(`  ✗ ${label} (threw but message "${e?.message}" missing "${substr}")`)
      failed++
    }
  }
}

async function setup(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "skill-bundle-test-"))
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
}

async function writeFile(dir: string, relPath: string, content: string | Buffer) {
  const absPath = path.join(dir, relPath)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  if (typeof content === "string") await fs.writeFile(absPath, content, "utf8")
  else await fs.writeFile(absPath, content)
}

async function readFile(dir: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(dir, relPath), "utf8")
}

async function fileExists(dir: string, relPath: string): Promise<boolean> {
  return fs.access(path.join(dir, relPath)).then(() => true, () => false)
}

async function readBundle(skillDir: string, versionNum: number) {
  const versions = await listVersions(skillDir)
  const entry = versions.find((v) => v.version === versionNum)
  if (!entry) throw new Error(`version v${versionNum} not found`)
  const raw = await fs.readFile(path.join(skillDir, ".versions", entry.filename), "utf8")
  return JSON.parse(raw) as { action: string; timestamp: string; files: Record<string, { content: string; encoding: string }> }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// [1] Bundle file format
async function testBundleFormat() {
  console.log("\n[1] Bundle file format")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "initial content")
    await snapshot(dir, "create")

    const versions = await listVersions(dir)
    assert(versions.length === 1, "one version created")
    assert(versions[0]!.label === "v001", "label is v001")
    assert(versions[0]!.action === "create", "action is create")
    assert(versions[0]!.filename.endsWith(".bundle.json"), "file ends with .bundle.json")
    assert(versions[0]!.filename.startsWith("v001_create_"), "filename starts with v001_create_")
    assert(/\d{8}T\d{6}/.test(versions[0]!.timestamp), "timestamp matches YYYYMMDDThhmmss")

    const bundle = await readBundle(dir, 1)
    assert(bundle.action === "create", "bundle.action is create")
    assert(typeof bundle.timestamp === "string", "bundle.timestamp exists")
    assert(typeof bundle.files === "object", "bundle.files is object")
    assert("SKILL.md" in bundle.files, "bundle contains SKILL.md")
    assert(bundle.files["SKILL.md"]!.content === "initial content", "SKILL.md content correct")
    assert(bundle.files["SKILL.md"]!.encoding === "utf8", "SKILL.md encoding is utf8")
  } finally {
    await cleanup(dir)
  }
}

// [2] Multi-file snapshot
async function testMultiFileSnapshot() {
  console.log("\n[2] Multi-file snapshot (SKILL.md + scripts + nested)")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill content")
    await writeFile(dir, "scripts/run.sh", "#!/bin/bash\necho hello")
    await writeFile(dir, "scripts/utils/helper.py", "def helper(): pass")
    await writeFile(dir, "config.yaml", "key: value")
    await snapshot(dir, "edit")

    const bundle = await readBundle(dir, 1)
    assert("SKILL.md" in bundle.files, "bundle has SKILL.md")
    assert("scripts/run.sh" in bundle.files, "bundle has scripts/run.sh")
    assert("scripts/utils/helper.py" in bundle.files, "bundle has scripts/utils/helper.py")
    assert("config.yaml" in bundle.files, "bundle has config.yaml")
    assert(!(".versions" in bundle.files), ".versions dir excluded from bundle")
    assert(bundle.files["scripts/run.sh"]!.content === "#!/bin/bash\necho hello", "run.sh content correct")
    assert(bundle.files["scripts/utils/helper.py"]!.content === "def helper(): pass", "nested file content correct")
  } finally {
    await cleanup(dir)
  }
}

// [3] .versions dir excluded from snapshot
async function testVersionsDirExcluded() {
  console.log("\n[3] .versions/ is never included in bundle")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "v1")
    await snapshot(dir, "create")
    await writeFile(dir, "SKILL.md", "v2")
    await snapshot(dir, "edit") // now .versions has 1 file

    const bundle = await readBundle(dir, 2)
    const keys = Object.keys(bundle.files)
    assert(!keys.some((k) => k.startsWith(".versions")), "no .versions keys in bundle")
  } finally {
    await cleanup(dir)
  }
}

// [4] Version numbering and listVersions
async function testVersionNumbering() {
  console.log("\n[4] Version numbering and listVersions")
  const dir = await setup()
  try {
    for (let i = 1; i <= 12; i++) {
      await writeFile(dir, "SKILL.md", `content ${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    assert(versions.length === 12, "12 versions")
    let ordered = true
    for (let i = 1; i < versions.length; i++) {
      if (versions[i]!.version <= versions[i - 1]!.version) ordered = false
    }
    assert(ordered, "versions sorted ascending")
    assert(versions[0]!.label === "v001", "first is v001")
    assert(versions[9]!.label === "v010", "tenth is v010 (3-digit pad)")
    assert(versions[11]!.label === "v012", "twelfth is v012")
  } finally {
    await cleanup(dir)
  }
}

// [5] formatHistory
async function testFormatHistory() {
  console.log("\n[5] formatHistory output")
  const dir = await setup()
  try {
    assert(formatHistory("empty", []).includes("no version history"), "empty history message")

    await writeFile(dir, "SKILL.md", "v1")
    await snapshot(dir, "create")
    await writeFile(dir, "SKILL.md", "v2")
    await snapshot(dir, "patch")

    const versions = await listVersions(dir)
    const out = formatHistory("myskill", versions)
    assert(out.includes("myskill"), "contains skill name")
    assert(out.includes("v001"), "contains v001")
    assert(out.includes("v002"), "contains v002")
    assert(out.includes("create"), "contains create action")
    assert(out.includes("patch"), "contains patch action")
    assert(out.includes("← current"), "marks current version")
    // newest first: v002 line appears before v001 line
    assert(out.indexOf("v002") < out.indexOf("v001"), "newest version listed first")
  } finally {
    await cleanup(dir)
  }
}

// [6] Rollback case ③ — both have file, different content → overwrite
async function testRollbackOverwrite() {
  console.log("\n[6] Rollback case ③: both have file, content differs → overwrite")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "original SKILL")
    await writeFile(dir, "scripts/run.sh", "original script")
    await snapshot(dir, "create") // v001

    await writeFile(dir, "SKILL.md", "modified SKILL")
    await writeFile(dir, "scripts/run.sh", "modified script")
    await snapshot(dir, "edit") // v002

    await rollback(dir, "v001")

    assert(await readFile(dir, "SKILL.md") === "original SKILL", "SKILL.md restored to v001 content")
    assert(await readFile(dir, "scripts/run.sh") === "original script", "scripts/run.sh restored to v001 content")
  } finally {
    await cleanup(dir)
  }
}

// [7] Rollback case ① — bundle has file, current doesn't → create
async function testRollbackRestore() {
  console.log("\n[7] Rollback case ①: bundle has file, current directory doesn't → restore")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill")
    await writeFile(dir, "scripts/run.sh", "the script")
    await writeFile(dir, "templates/base.txt", "the template")
    await snapshot(dir, "create") // v001

    // Delete files after snapshot
    await fs.unlink(path.join(dir, "scripts/run.sh"))
    await fs.rmdir(path.join(dir, "scripts"))
    await fs.unlink(path.join(dir, "templates/base.txt"))
    await fs.rmdir(path.join(dir, "templates"))
    await snapshot(dir, "edit") // v002 (without the deleted files)

    await rollback(dir, "v001")

    assert(await fileExists(dir, "scripts/run.sh"), "scripts/run.sh recreated")
    assert(await readFile(dir, "scripts/run.sh") === "the script", "scripts/run.sh content correct")
    assert(await fileExists(dir, "templates/base.txt"), "templates/base.txt recreated")
    assert(await readFile(dir, "templates/base.txt") === "the template", "templates/base.txt content correct")
  } finally {
    await cleanup(dir)
  }
}

// [8] Rollback case ② — current has file, bundle doesn't → delete
async function testRollbackDelete() {
  console.log("\n[8] Rollback case ②: current has file, bundle doesn't → delete")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill")
    await snapshot(dir, "create") // v001 — only SKILL.md

    // Add extra files after snapshot
    await writeFile(dir, "scripts/run.sh", "extra script")
    await writeFile(dir, "config.yaml", "extra config")
    await snapshot(dir, "write_file") // v002

    await rollback(dir, "v001")

    assert(!(await fileExists(dir, "scripts/run.sh")), "scripts/run.sh deleted")
    assert(!(await fileExists(dir, "config.yaml")), "config.yaml deleted")
    assert(await fileExists(dir, "SKILL.md"), "SKILL.md still present")
  } finally {
    await cleanup(dir)
  }
}

// [9] Empty directory cleanup after rollback case ②
async function testEmptyDirCleanup() {
  console.log("\n[9] Empty directories removed after rollback case ②")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill")
    await snapshot(dir, "create") // v001

    await writeFile(dir, "scripts/utils/helper.py", "helper")
    await snapshot(dir, "write_file") // v002

    await rollback(dir, "v001")

    assert(!(await fileExists(dir, "scripts/utils/helper.py")), "nested file deleted")
    assert(!(await fileExists(dir, "scripts/utils")), "empty nested dir removed")
    assert(!(await fileExists(dir, "scripts")), "empty parent dir removed")
  } finally {
    await cleanup(dir)
  }
}

// [10] Non-empty parent dir NOT removed
async function testNonEmptyDirKept() {
  console.log("\n[10] Non-empty parent directory kept after partial rollback")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill")
    await writeFile(dir, "scripts/keep.sh", "keeper")
    await snapshot(dir, "create") // v001 — scripts/keep.sh exists

    await writeFile(dir, "scripts/delete_me.sh", "gone")
    await snapshot(dir, "write_file") // v002

    await rollback(dir, "v001")

    assert(await fileExists(dir, "scripts/keep.sh"), "scripts/keep.sh still present")
    assert(!(await fileExists(dir, "scripts/delete_me.sh")), "scripts/delete_me.sh deleted")
    assert(await fileExists(dir, "scripts"), "scripts/ dir kept (non-empty)")
  } finally {
    await cleanup(dir)
  }
}

// [11] Rollback creates new snapshot
async function testRollbackCreatesSnapshot() {
  console.log("\n[11] Rollback automatically creates a new snapshot")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "v1")
    await snapshot(dir, "create")
    await writeFile(dir, "SKILL.md", "v2 bad")
    await snapshot(dir, "edit")

    const beforeCount = (await listVersions(dir)).length
    await rollback(dir, "v001")
    const versions = await listVersions(dir)

    assert(versions.length === beforeCount + 1, "version count increased by 1")
    assert(versions[versions.length - 1]!.action === "rollback-v001", "new snapshot action is rollback-v001")

    const bundle = await readBundle(dir, versions.length)
    assert(bundle.files["SKILL.md"]?.content === "v1", "rollback snapshot captures restored state")
  } finally {
    await cleanup(dir)
  }
}

// [12] Numeric label support
async function testNumericLabel() {
  console.log("\n[12] Rollback accepts numeric label '2' same as 'v002'")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "v1")
    await snapshot(dir, "create")
    await writeFile(dir, "SKILL.md", "v2")
    await snapshot(dir, "edit")
    await writeFile(dir, "SKILL.md", "v3 bad")
    await snapshot(dir, "patch")

    await rollback(dir, "2")
    assert(await readFile(dir, "SKILL.md") === "v2", "numeric '2' rollback restores v2 content")
  } finally {
    await cleanup(dir)
  }
}

// [13] Double rollback
async function testDoubleRollback() {
  console.log("\n[13] Two consecutive rollbacks")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "v1 original")
    await snapshot(dir, "create") // v001

    await writeFile(dir, "SKILL.md", "v2 good")
    await snapshot(dir, "edit") // v002

    await writeFile(dir, "SKILL.md", "v3 bad")
    await snapshot(dir, "patch") // v003

    await rollback(dir, "v002") // → v004_rollback-v002
    assert(await readFile(dir, "SKILL.md") === "v2 good", "first rollback correct")

    await writeFile(dir, "SKILL.md", "v5 also bad")
    await snapshot(dir, "edit") // v005

    await rollback(dir, "v004") // rollback to rollback
    const versions = await listVersions(dir)
    assert(versions[versions.length - 1]!.action === "rollback-v004", "second rollback label correct")
    assert(await readFile(dir, "SKILL.md") === "v2 good", "content after double rollback is v2 state")
  } finally {
    await cleanup(dir)
  }
}

// [14] Rollback to a rollback snapshot
async function testRollbackToRollback() {
  console.log("\n[14] Rollback to a snapshot that is itself a rollback")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "original")
    await writeFile(dir, "scripts/run.sh", "original script")
    await snapshot(dir, "create") // v001

    await writeFile(dir, "SKILL.md", "edited")
    await snapshot(dir, "edit") // v002

    await rollback(dir, "v001") // → v003_rollback-v001 (restores original + scripts/run.sh)

    await writeFile(dir, "SKILL.md", "bad again")
    await snapshot(dir, "patch") // v004

    await rollback(dir, "v003") // rollback to the rollback snapshot

    assert(await readFile(dir, "SKILL.md") === "original", "SKILL.md is original after rollback-to-rollback")
    assert(await fileExists(dir, "scripts/run.sh"), "scripts/run.sh restored in rollback-to-rollback")
    assert(await readFile(dir, "scripts/run.sh") === "original script", "scripts content correct")
  } finally {
    await cleanup(dir)
  }
}

// [15] snapshotBeforeDelete
async function testSnapshotBeforeDelete() {
  console.log("\n[15] snapshotBeforeDelete")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "about to delete")
    await writeFile(dir, "scripts/run.sh", "script content")
    await snapshot(dir, "create")
    await snapshotBeforeDelete(dir)

    const versions = await listVersions(dir)
    assert(versions.length === 2, "two versions after snapshotBeforeDelete")
    assert(versions[1]!.action === "delete", "second version action is 'delete'")

    const bundle = await readBundle(dir, 2)
    assert(bundle.files["SKILL.md"]?.content === "about to delete", "SKILL.md content in delete snapshot")
    assert("scripts/run.sh" in bundle.files, "scripts/run.sh included in delete snapshot")
    assert(bundle.files["scripts/run.sh"]?.content === "script content", "script content in delete snapshot")
  } finally {
    await cleanup(dir)
  }
}

// [16] write_file / remove_file actions produce correct bundle action labels
async function testWriteFileRemoveFileActions() {
  console.log("\n[16] write_file / remove_file action labels in bundle")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill")
    await snapshot(dir, "create") // v001

    await writeFile(dir, "scripts/run.sh", "script")
    await snapshot(dir, "write_file") // v002

    await fs.unlink(path.join(dir, "scripts/run.sh"))
    await snapshot(dir, "remove_file") // v003

    const versions = await listVersions(dir)
    assert(versions[1]!.action === "write_file", "v002 action is write_file")
    assert(versions[2]!.action === "remove_file", "v003 action is remove_file")

    const v2bundle = await readBundle(dir, 2)
    assert("scripts/run.sh" in v2bundle.files, "write_file bundle includes scripts/run.sh")

    const v3bundle = await readBundle(dir, 3)
    assert(!("scripts/run.sh" in v3bundle.files), "remove_file bundle does not include scripts/run.sh")
  } finally {
    await cleanup(dir)
  }
}

// [17] Error: invalid version label
async function testErrorInvalidLabel() {
  console.log("\n[17] Error cases")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "content")
    await snapshot(dir, "create")

    await assertThrowsMsg(() => rollback(dir, "abc"), "Invalid version label", "invalid label 'abc' throws")
    await assertThrowsMsg(() => rollback(dir, "v999"), "not found", "missing version throws with 'not found'")
    await assertThrowsMsg(() => rollback(dir, "v999"), "v001", "error message lists available versions")
  } finally {
    await cleanup(dir)
  }
}

// [18] Error: rollback with no history
async function testErrorNoHistory() {
  console.log("\n[18] Rollback with no history throws")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "content")
    await assertThrows(() => rollback(dir, "v001"), "rollback with no history throws")
  } finally {
    await cleanup(dir)
  }
}

// [19] Error: snapshot with no files
async function testErrorNoFiles() {
  console.log("\n[19] Snapshot with empty skill dir throws")
  const dir = await setup()
  try {
    await assertThrowsMsg(() => snapshot(dir, "create"), "no files found", "empty dir snapshot throws")
  } finally {
    await cleanup(dir)
  }
}

// [20] Binary file handling
async function testBinaryFiles() {
  console.log("\n[20] Binary file stored as base64 and restored correctly")
  const dir = await setup()
  try {
    await writeFile(dir, "SKILL.md", "skill with binary")
    // create a buffer with null bytes (binary marker)
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE])
    await writeFile(dir, "assets/image.bin", binaryData)
    await snapshot(dir, "create") // v001

    const bundle = await readBundle(dir, 1)
    assert(bundle.files["assets/image.bin"]?.encoding === "base64", "binary file stored as base64")
    assert(
      bundle.files["assets/image.bin"]?.content === binaryData.toString("base64"),
      "base64 content matches original",
    )

    // Delete the file then rollback to restore it
    await fs.unlink(path.join(dir, "assets/image.bin"))
    await fs.rmdir(path.join(dir, "assets"))
    await snapshot(dir, "edit") // v002 without binary

    await rollback(dir, "v001")

    const restored = await fs.readFile(path.join(dir, "assets/image.bin"))
    assert(restored.equals(binaryData), "binary file restored byte-for-byte")
  } finally {
    await cleanup(dir)
  }
}

// [21] isVersionsDir utility
async function testIsVersionsDir() {
  console.log("\n[21] isVersionsDir utility")
  assert(isVersionsDir(".versions"), "'.versions' recognized")
  assert(!isVersionsDir("SKILL.md"), "SKILL.md not a versions dir")
  assert(!isVersionsDir(".version"), "'.version' not a versions dir")
  assert(!isVersionsDir("versions"), "'versions' not a versions dir")
  assert(!isVersionsDir("scripts"), "'scripts' not a versions dir")
}

// [22] Version pruning
async function testVersionsPruning() {
  console.log("\n[22] Version count stays stable below MAX (smoke test)")
  const dir = await setup()
  try {
    for (let i = 1; i <= 5; i++) {
      await writeFile(dir, "SKILL.md", `content v${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    assert(versions.length === 5, "5 versions below MAX, all retained")
    assert(versions[0]!.label === "v001", "oldest is v001")
    assert(versions[4]!.label === "v005", "newest is v005")
  } finally {
    await cleanup(dir)
  }
}

// [23] All-in-one: complex multi-file lifecycle
async function testComplexLifecycle() {
  console.log("\n[23] Complex lifecycle: multi-file create → write → remove → rollback chain")
  const dir = await setup()
  try {
    // v001: create with SKILL.md + script
    await writeFile(dir, "SKILL.md", "skill v1")
    await writeFile(dir, "scripts/run.sh", "run v1")
    await snapshot(dir, "create")

    // v002: add config
    await writeFile(dir, "config.yaml", "mode: prod")
    await snapshot(dir, "write_file")

    // v003: edit SKILL.md, modify script
    await writeFile(dir, "SKILL.md", "skill v3")
    await writeFile(dir, "scripts/run.sh", "run v3")
    await snapshot(dir, "edit")

    // v004: remove script
    await fs.unlink(path.join(dir, "scripts/run.sh"))
    await fs.rmdir(path.join(dir, "scripts"))
    await snapshot(dir, "remove_file")

    // rollback to v002 (SKILL.md=v1, script=v1, config=prod)
    await rollback(dir, "v002")

    assert(await readFile(dir, "SKILL.md") === "skill v1", "SKILL.md rolled back to v1")
    assert(await readFile(dir, "scripts/run.sh") === "run v1", "scripts/run.sh restored")
    assert(await readFile(dir, "config.yaml") === "mode: prod", "config.yaml present")

    const versions = await listVersions(dir)
    assert(versions.length === 5, "5 versions total (4 + 1 rollback snapshot)")
    assert(versions[4]!.action === "rollback-v002", "last snapshot is rollback-v002")
  } finally {
    await cleanup(dir)
  }
}

// [24] Binary Ruler: v001 永不被淘汰
async function testBinaryRulerOriginPreserved() {
  console.log("\n[24] Binary Ruler: v001 always retained past capacity")
  const dir = await setup()
  try {
    // Use C=10 via env mock — we inject via a small wrapper instead
    // Write 15 snapshots; prune uses DEFAULT (100), so no pruning yet.
    // Force pruning by writing enough versions.
    // To keep test fast, use C=10 by monkey-patching resolveMaxVersions indirectly:
    // we can't easily override config here, so we write DEFAULT_MAX_VERSIONS+1 snapshots.
    // Instead, write 12 versions and verify v001 is present at boundary with C=10 logic by
    // calling the exported functions and checking listVersions directly.
    // Since DEFAULT_MAX_VERSIONS=100, write 101 to trigger prune.
    for (let i = 1; i <= 101; i++) {
      await writeFile(dir, "SKILL.md", `content ${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    assert(versions.length <= 100, `count ${versions.length} <= 100 after 101 snapshots`)
    assert(versions.some((v) => v.version === 1), "v001 always retained")
  } finally {
    await cleanup(dir)
  }
}

// [25] Binary Ruler: 活跃区最新版本全部保留
async function testBinaryRulerActiveZone() {
  console.log("\n[25] Binary Ruler: active zone (latest 49) fully retained")
  const dir = await setup()
  try {
    for (let i = 1; i <= 101; i++) {
      await writeFile(dir, "SKILL.md", `content ${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    // With C=100, A=49: last 49 version numbers must all be present
    const retained = new Set(versions.map((v) => v.version))
    // latest 49: versions 53..101
    let allActive = true
    for (let n = 53; n <= 101; n++) {
      if (!retained.has(n)) { allActive = false; break }
    }
    assert(allActive, "all 49 active-zone versions retained (v053-v101)")
  } finally {
    await cleanup(dir)
  }
}

// [26] Binary Ruler: 奇数版本（权重=1）先被淘汰，2 的幂次版本长久保留
async function testBinaryRulerMilestoneWeights() {
  console.log("\n[26] Binary Ruler: odd versions evicted first, power-of-2 versions survive")
  const dir = await setup()
  try {
    // With C=100, A=49, M=50: at N=105 the milestone zone has 55 candidates (v002-v056),
    // keeps top 50 by weight → evicts the 5 oldest weight-1 versions: v003,v005,v007,v009,v011.
    for (let i = 1; i <= 105; i++) {
      await writeFile(dir, "SKILL.md", `content ${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const versions = await listVersions(dir)
    const retained = new Set(versions.map((v) => v.version))
    // Power-of-2 milestones should all survive
    for (const n of [2, 4, 8, 16, 32]) {
      assert(retained.has(n), `v${String(n).padStart(3, "0")} (weight=${n}) retained in milestone zone`)
    }
    // The 5 oldest weight-1 odd versions should be evicted
    for (const n of [3, 5, 7, 9, 11]) {
      assert(!retained.has(n), `v${String(n).padStart(3, "0")} (odd, weight=1) evicted from milestone zone`)
    }
  } finally {
    await cleanup(dir)
  }
}

// [27] Binary Ruler: 总数始终不超 C
async function testBinaryRulerCountBound() {
  console.log("\n[27] Binary Ruler: version count never exceeds C=100")
  const dir = await setup()
  try {
    for (let i = 1; i <= 150; i++) {
      await writeFile(dir, "SKILL.md", `content ${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
      const versions = await listVersions(dir)
      if (versions.length > 100) {
        assert(false, `count exceeded 100 at iteration ${i}: got ${versions.length}`)
        return
      }
    }
    assert(true, "count stayed <= 100 across 150 snapshots")
  } finally {
    await cleanup(dir)
  }
}

// [28] Binary Ruler: rollback 后仍满足容量约束
async function testBinaryRulerRollbackConstraint() {
  console.log("\n[28] Binary Ruler: rollback still satisfies capacity constraint")
  const dir = await setup()
  try {
    for (let i = 1; i <= 101; i++) {
      await writeFile(dir, "SKILL.md", `content ${i}`)
      await snapshot(dir, i === 1 ? "create" : "edit")
    }
    const before = await listVersions(dir)
    assert(before.length <= 100, `before rollback: ${before.length} <= 100`)
    // Rollback to v001 (always present)
    await rollback(dir, "v001")
    const after = await listVersions(dir)
    assert(after.length <= 100, `after rollback: ${after.length} <= 100`)
    assert(after[after.length - 1]!.action === "rollback-v001", "rollback snapshot created")
  } finally {
    await cleanup(dir)
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== skill-versions bundle test suite ===")
  await testBundleFormat()
  await testMultiFileSnapshot()
  await testVersionsDirExcluded()
  await testVersionNumbering()
  await testFormatHistory()
  await testRollbackOverwrite()
  await testRollbackRestore()
  await testRollbackDelete()
  await testEmptyDirCleanup()
  await testNonEmptyDirKept()
  await testRollbackCreatesSnapshot()
  await testNumericLabel()
  await testDoubleRollback()
  await testRollbackToRollback()
  await testSnapshotBeforeDelete()
  await testWriteFileRemoveFileActions()
  await testErrorInvalidLabel()
  await testErrorNoHistory()
  await testErrorNoFiles()
  await testBinaryFiles()
  await testIsVersionsDir()
  await testVersionsPruning()
  await testComplexLifecycle()
  await testBinaryRulerOriginPreserved()
  await testBinaryRulerActiveZone()
  await testBinaryRulerMilestoneWeights()
  await testBinaryRulerCountBound()
  await testBinaryRulerRollbackConstraint()

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error("Unexpected error:", err)
  process.exit(1)
})
