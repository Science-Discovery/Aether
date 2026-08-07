import { describe, expect, test } from "bun:test"
import { Skill } from "./index"

describe("hidden skills", () => {
  test("parses hidden metadata and keeps hidden skills out of the advertised list", () => {
    expect(Skill.Test.Meta.parse({ name: "internal", description: "internal skill", hidden: true }).hidden).toBe(true)
    const skills = [
      { name: "internal", description: "internal skill", location: "internal", content: "" },
      { name: "visible", description: "visible skill", location: "visible", content: "" },
    ]
    expect(Skill.Test.visible(skills, new Set(["internal"])).map((skill) => skill.name)).toEqual(["visible"])
  })
})
