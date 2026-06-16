import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Spawner } from "./spawner"
import {
  serializeHistory,
  buildReviewPrompt,
  isReviewSession,
  serializeSkillInventory,
  collectSkillInventory,
} from "./review-agent"
import type { MessageSnapshot, SkillSummary } from "./review-agent"

describe("serializeHistory", () => {
  test("produces XML block from message snapshots", () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "Hello" }] },
      { role: "assistant", parts: [{ type: "text", text: "Hi there" }] },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("<conversation_history>")
    expect(xml).toContain('role="user"')
    expect(xml).toContain('role="assistant"')
    expect(xml).toContain("Hello")
    expect(xml).toContain("Hi there")
    expect(xml).toContain("</conversation_history>")
  })

  test("escapes XML special characters", () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: 'a < b & c > d "quote"' }] },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("&lt;")
    expect(xml).toContain("&amp;")
    expect(xml).toContain("&gt;")
    expect(xml).toContain("&quot;")
  })

  test("includes tool_call parts", () => {
    const messages: MessageSnapshot[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "bash", callID: "call-123" }],
      },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain('name="bash"')
    expect(xml).toContain('id="call-123"')
  })

  test("handles empty messages array", () => {
    const xml = serializeHistory([])
    expect(xml).toContain("<conversation_history>")
    expect(xml).toContain("</conversation_history>")
  })
})

describe("buildReviewPrompt", () => {
  test("returns a string containing the conversation history and review prompt base", async () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "Please help me deploy" }] },
    ]
    const prompt = await buildReviewPrompt(messages, "test-project-abc")
    expect(prompt).toContain("<conversation_history>")
    expect(prompt).toContain("Please help me deploy")
    // Should contain the base prompt
    expect(prompt).toContain("skill evolution agent")
    // Should carry the "Do NOT capture" blacklist borrowed from Hermes
    expect(prompt).toContain("self-imposed constraints")
    expect(prompt).toContain("this tool does not work")
    // Should carry the positive concrete-reuse test
    expect(prompt).toContain("name the specific future moment")
    // Should carry the two scope-overreach blacklist entries
    expect(prompt).toContain("dressed as a universal method")
    expect(prompt).toContain("self-re-running artifact")
  })

  test("includes a do-not-evolve warning naming each protected skill when the list is non-empty", async () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]
    const prompt = await buildReviewPrompt(messages, "test-project-abc", ["protected-one", "protected-two"])
    // Names the protected skills.
    expect(prompt).toContain("protected-one")
    expect(prompt).toContain("protected-two")
    // States the prohibition: do not modify them, and do not recreate equivalents.
    expect(prompt.toLowerCase()).toContain("do not modify")
    expect(prompt.toLowerCase()).toContain("do not create")
  })

  test("omits the warning entirely when no skills are protected (boundary)", async () => {
    const messages: MessageSnapshot[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]
    const prompt = await buildReviewPrompt(messages, "test-project-abc", [])
    expect(prompt.toLowerCase()).not.toContain("do not modify")
  })
})

describe("serializeSkillInventory", () => {
  test("lists each skill's name, category and description with edit-first guidance", () => {
    const skills: SkillSummary[] = [
      { name: "ai-qft-survey", description: "Survey AI + QFT progress", category: "Research" },
      { name: "review-pr", description: "Review a PR diff", category: "GitHub" },
    ]
    const out = serializeSkillInventory(skills)
    expect(out).toContain("ai-qft-survey")
    expect(out).toContain("Survey AI + QFT progress")
    expect(out).toContain("review-pr")
    expect(out).toContain("Review a PR diff")
    // #3: nudge the reviewer toward editing an existing skill over making a near-duplicate
    expect(out.toLowerCase()).toContain("prefer editing")
  })

  test("empty list yields a no-skills sentinel, no throw (boundary)", () => {
    const out = serializeSkillInventory([])
    expect(out.toLowerCase()).toContain("none")
  })
})

describe("collectSkillInventory", () => {
  test("reads name+description+category from the sub-project's SKILL.md (write→read seam)", async () => {
    const folderName = "test-inventory-scan-fixture"
    const base = Spawner.skillEvolutionBase(folderName)
    const skillDir = path.join(Spawner.skillEvolutionDir(folderName), "my-skill")
    await fs.rm(base, { recursive: true, force: true })
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: "my-skill"\ndescription: "Does a specific thing"\ncategory: "Testing"\n---\n\nbody`,
    )
    try {
      const inv = await collectSkillInventory(folderName)
      const found = inv.find((s) => s.name === "my-skill")
      expect(found).toBeDefined()
      expect(found!.description).toBe("Does a specific thing")
      expect(found!.category).toBe("Testing")
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("missing dir yields empty list, no throw (boundary)", async () => {
    const inv = await collectSkillInventory("nonexistent-folder-xyz-12345")
    expect(inv).toEqual([])
  })

  test("does not read a `category:` line from the body when frontmatter omits it (frontmatter-scoped)", async () => {
    const folderName = "test-inventory-bodyleak-fixture"
    const base = Spawner.skillEvolutionBase(folderName)
    const skillDir = path.join(Spawner.skillEvolutionDir(folderName), "leaky-skill")
    await fs.rm(base, { recursive: true, force: true })
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: "leaky-skill"\ndescription: "real description"\n---\n\nSome body text.\ncategory: from-body\n`,
    )
    try {
      const inv = await collectSkillInventory(folderName)
      const found = inv.find((s) => s.name === "leaky-skill")
      expect(found).toBeDefined()
      expect(found!.description).toBe("real description")
      // The `category:` line lives in the body, not the frontmatter — it must NOT leak in.
      expect(found!.category).toBeUndefined()
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})

describe("serializeHistory tool input/output", () => {
  test("includes tool input and output", () => {
    const messages: MessageSnapshot[] = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool",
            tool: "webfetch",
            callID: "c1",
            state: { status: "completed", input: { url: "https://example.com" }, output: "Status 200 OK body" },
          },
        ],
      },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("https://example.com")
    expect(xml).toContain("Status 200 OK body")
  })

  test("truncates long output and marks it; full blob absent (truncation)", () => {
    const big = "x".repeat(5000)
    const messages: MessageSnapshot[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "bash", callID: "c2", state: { status: "completed", output: big } }],
      },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("truncated")
    expect(xml).not.toContain(big)
  })

  test("tool part without state renders no input/output, no throw (boundary)", () => {
    const messages: MessageSnapshot[] = [
      { role: "assistant", parts: [{ type: "tool", tool: "bash", callID: "c3" }] },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain('name="bash"')
    expect(xml).not.toContain("<input>")
    expect(xml).not.toContain("<output>")
  })

  test("renders output for every tool_call in one message (boundary)", () => {
    const messages: MessageSnapshot[] = [
      {
        role: "assistant",
        parts: [
          { type: "tool", tool: "webfetch", callID: "a", state: { output: "first-result" } },
          { type: "tool", tool: "webfetch", callID: "b", state: { output: "second-result" } },
        ],
      },
    ]
    const xml = serializeHistory(messages)
    expect(xml).toContain("first-result")
    expect(xml).toContain("second-result")
  })
})

describe("isReviewSession", () => {
  test("returns false for unknown session IDs", () => {
    expect(isReviewSession()).toBe(false)
  })
})
