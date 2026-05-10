import { test, expect } from "bun:test"
import { FileIgnore } from "../../src/file/ignore"

test("match nested and non-nested", () => {
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  expect(FileIgnore.match("node_modules")).toBe(true)
  expect(FileIgnore.match("node_modules/")).toBe(true)
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})

test("watch patterns skip nested ignored directories", () => {
  expect(FileIgnore.WATCH).toHaveLength(1)
  expect(FileIgnore.WATCH[0]).toContain("node_modules")
  expect(FileIgnore.WATCH[0]).toContain("dist")
  expect(FileIgnore.WATCH[0]).not.toContain("**/node_modules")
  expect(FileIgnore.WATCH[0]).not.toContain("**/*.log")
})
