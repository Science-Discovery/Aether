import { expect, test } from "bun:test"
import { Skill } from "@/skill"

// 回归防护(SKILL_IDENTITY_DESIGN.md bug①): frontmatter 里 id 不是字符串(如外部 skill 的 `id: 123`)
// 不能让整条解析失败、把 skill 整个丢掉 —— 坏 id 当没有(undefined)即可。
test("Info schema tolerates a non-string id instead of rejecting the whole skill", () => {
  const parsed = Skill.Info.pick({ name: true, description: true, id: true }).safeParse({
    name: "x",
    description: "y",
    id: 123, // 非字符串
  })
  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.id).toBeUndefined() // 坏 id 被忽略, 不报错
})
