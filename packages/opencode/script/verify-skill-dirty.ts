import { SkillDirty } from "../src/session/skill-dirty"

function check(ok: boolean, msg: string) {
  if (ok) return
  throw new Error(msg)
}

const id = "session-test"

SkillDirty.add(id, ["brainstorming", "brainstorming", "", "   "])
check(SkillDirty.list(id).length === 1, "expected deduped dirty list")

SkillDirty.add(id, ["docx", "ppt-generation"])
const list = SkillDirty.take(id).sort()
check(
  JSON.stringify(list) === JSON.stringify(["brainstorming", "docx", "ppt-generation"].sort()),
  "expected take to return full dirty set",
)

check(SkillDirty.take(id).length === 0, "expected take to clear pending dirty set")

console.log("[verify-skill-dirty] ok")
