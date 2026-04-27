import { SkillDirty } from "../src/session/skill-dirty"

function check(ok: boolean, msg: string) {
  if (ok) return
  throw new Error(msg)
}

const id = "session-test"

SkillDirty.add(id, ["brainstorming", "brainstorming", "", " "])
check(SkillDirty.list(id).length === 1, "expected deduped dirty set")

SkillDirty.add(id, ["docx", "ppt-generation"])
const names = SkillDirty.take(id).sort()
check(
  JSON.stringify(names) === JSON.stringify(["brainstorming", "docx", "ppt-generation"].sort()),
  "expected full dirty set",
)

check(SkillDirty.take(id).length === 0, "expected dirty set cleared")

console.log("[verify-skill-dirty] ok")
