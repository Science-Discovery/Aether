import { SkillDirty } from "../src/session/skill-dirty"
import { SkillRefresh } from "../src/session/skill-refresh"

function check(ok: boolean, msg: string) {
  if (ok) return
  throw new Error(msg)
}

const sid = "session-flow"
const box = new Map<string, string>([["alpha", "v1"]])

SkillDirty.add(sid, ["alpha", "gone"])
const one = await SkillRefresh.patch(sid, async (name) => {
  const content = box.get(name)
  if (!content) return
  return { name, content: `# ${name}\n\n${content}` }
})

check(one?.names.join(",") === "alpha,gone", "expected names in patch")
check(one?.text.includes('<skill_content name="alpha">') ?? false, "expected alpha content block")
check(one?.text.includes("v1") ?? false, "expected latest alpha content")
check(one?.text.includes('<skill_content name="gone">') ?? false, "expected missing block")

const two = await SkillRefresh.patch(sid, async () => undefined)
check(two === undefined, "expected dirty consumed")

box.set("alpha", "v2")
SkillDirty.add(sid, ["alpha"])
const three = await SkillRefresh.patch(sid, async (name) => {
  const content = box.get(name)
  if (!content) return
  return { name, content: `# ${name}\n\n${content}` }
})

check(three?.text.includes("v2") ?? false, "expected updated content")
check(!(three?.text.includes("v1") ?? true), "expected stale content removed")

console.log("[verify-skill-refresh] ok")
