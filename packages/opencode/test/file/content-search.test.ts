import { describe, expect, test } from "bun:test"
import path from "path"
import { ContentSearch } from "../../src/file/content-search"
import { tmpdir } from "../fixture/fixture"

describe("file.content-search", () => {
  test("creates a session and pages through grouped results", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "needle one\n")
        await Bun.write(path.join(dir, "b.ts"), "needle two\n")
        await Bun.write(path.join(dir, "c.ts"), "needle three\n")
      },
    })

    const first = await ContentSearch.create({
      cwd: tmp.path,
      pattern: "needle",
      limit: 2,
    })

    expect(first.items).toHaveLength(2)
    expect(first.cursor).toBe(2)
    expect(first.done).toBe(false)

    const second = await ContentSearch.next({
      sessionID: first.session_id,
      cursor: first.cursor,
      limit: 2,
    })

    expect(second.items).toHaveLength(1)
    expect(second.cursor).toBe(3)
    expect(second.done).toBe(true)
    expect(
      [...first.items, ...second.items]
        .map((item) => item.path.text)
        .sort(),
    ).toEqual(["a.ts", "b.ts", "c.ts"])

    ContentSearch.remove(first.session_id)
  })

  test("deleting a session makes later reads fail", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "needle one\n")
      },
    })

    const first = await ContentSearch.create({
      cwd: tmp.path,
      pattern: "needle",
      limit: 1,
    })

    ContentSearch.remove(first.session_id)

    await expect(
      ContentSearch.next({
        sessionID: first.session_id,
        cursor: first.cursor,
        limit: 1,
      }),
    ).rejects.toThrow(`Search session not found: ${first.session_id}`)
  })
})
