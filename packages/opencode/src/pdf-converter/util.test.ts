import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { computeOutputPaths, resolveConflict } from "./util"

describe("computeOutputPaths", () => {
  test("uses original folder by default", () => {
    expect(computeOutputPaths("/work/docs/a.pdf", "merged")).toEqual({
      merged: "/work/docs/a.md",
      perPage: "/work/docs/a_md",
      images: "/work/docs/a_images",
      dataJson: "/work/docs/a_data.json",
    })
  })

  test("uses custom folder when provided", () => {
    expect(computeOutputPaths("/work/docs/a.pdf", "merged", "/out")).toEqual({
      merged: "/out/a.md",
      perPage: "/out/a_md",
      images: "/out/a_images",
      dataJson: "/out/a_data.json",
    })
  })
})

describe("resolveConflict", () => {
  test("renames against existing file in target folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-util-"))
    const file = path.join(dir, "a.md")
    await Bun.write(file, "x")
    expect(await resolveConflict(file, "rename")).toBe(path.join(dir, "a(1).md"))
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("renames against existing directory in target folder", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-util-"))
    const out = path.join(dir, "a_md")
    await fs.mkdir(out)
    expect(await resolveConflict(out, "rename")).toBe(path.join(dir, "a_md(1)"))
    await fs.rm(dir, { recursive: true, force: true })
  })
})
