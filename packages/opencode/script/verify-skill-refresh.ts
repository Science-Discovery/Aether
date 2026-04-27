import { SkillDirty } from "../src/session/skill-dirty"
import { SkillRefresh } from "../src/session/skill-refresh"

function check(ok: boolean, msg: string) {
  if (ok) return
  throw new Error(msg)
}

const sid = "session-flow"
const box = new Map<string, string>([
  ["alpha", "v1"],
  ["beta", "v1"],
])

SkillDirty.add(sid, ["alpha", "gone"])
const one = await SkillRefresh.patch(sid, async (name) => {
  const content = box.get(name)
  if (!content) return
  return { name, content: `# ${name}\n\n${content}` }
})

check(typeof one === "string", "expected first patch block")
check(one!.includes('<skill_content name="alpha">'), "expected alpha in patch")
check(one!.includes("v1"), "expected latest alpha content")
check(one!.includes('<skill_content name="gone">'), "expected missing skill entry")
check(one!.includes("removed or is unavailable"), "expected missing hint")

const two = await SkillRefresh.patch(sid, async () => undefined)
check(two === undefined, "expected dirty set consumed after first patch")

box.set("alpha", "v2")
SkillDirty.add(sid, ["alpha"])
const three = await SkillRefresh.patch(sid, async (name) => {
  const content = box.get(name)
  if (!content) return
  return { name, content: `# ${name}\n\n${content}` }
})

check(typeof three === "string", "expected second patch block")
check(three!.includes("v2"), "expected updated alpha content")
check(!three!.includes("v1"), "expected stale content removed")

console.log("[verify-skill-refresh] ok")
