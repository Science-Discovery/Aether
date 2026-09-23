import { expect, test } from "bun:test"
import nodePath from "path"
import * as assets from "./web"

test("maps root to index.html", () => {
  expect(assets.resolve("/srv/web", "/")).toBe(nodePath.resolve("/srv/web", "index.html"))
})

test("serves assets inside root", () => {
  expect(assets.resolve("/srv/web", "/assets/app.js")).toBe(nodePath.resolve("/srv/web", "assets/app.js"))
})

test("blocks dotdot traversal", () => {
  expect(assets.resolve("/srv/web", "/../secret.txt")).toBeUndefined()
})

test("blocks nested dotdot traversal", () => {
  expect(assets.resolve("/srv/web", "/assets/../../../../etc/passwd")).toBeUndefined()
})

test("blocks exact root", () => {
  expect(assets.resolve("/srv/web", "/.")).toBeUndefined()
})

test("contains absolute-looking segment inside root", () => {
  expect(assets.resolve("/srv/web", "/etc/passwd")).toBe(nodePath.resolve("/srv/web", "etc/passwd"))
})

if (process.platform === "win32") {
  test("blocks encoded-backslash traversal on windows", () => {
    expect(assets.resolve("C:\\srv\\web", "/..\\..\\users/me/.ssh/id_rsa")).toBeUndefined()
  })

  test("allows backslash separators inside root on windows", () => {
    expect(assets.resolve("C:\\srv\\web", "/assets\\app.js")).toBe(nodePath.resolve("C:\\srv\\web", "assets/app.js"))
  })

  test("contains unc-looking segment inside root on windows", () => {
    expect(assets.resolve("C:\\srv\\web", "\\\\evil\\share\\x")).toBe(nodePath.resolve("C:\\srv\\web", "evil/share/x"))
  })
} else {
  test("allows backslash inside a filename on posix", () => {
    expect(assets.resolve("/srv/web", "/assets\\app.js")).toBe(nodePath.resolve("/srv/web", "assets\\app.js"))
  })
}
