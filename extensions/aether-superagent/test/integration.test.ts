import { beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile, unlink, stat } from "node:fs/promises"
import path from "node:path"
import { homedir } from "node:os"
import { install, uninstall } from "../src/integration"
import { git } from "../src/workspace"

const sidebarPath = "packages/app/src/pages/layout/sidebar-shell.tsx"
const layoutPath = "packages/app/src/pages/layout.tsx"
const layout = 'import { useNavigate, useParams } from "@solidjs/router"\nexport const Layout = () => {\n  const editor = createInlineEditorController()\n  async function navigateToProject(directory: string | undefined) {\n    return directory\n  }\n  return editor\n}\n'
const appPath = "packages/app/src/app.tsx"
const app = 'const HomeRoute = lazy(() => import("@/pages/home"))\nconst App = () => (\n                  <Route path="/" component={HomeRoute} />\n)\n'
const serverPath = "packages/opencode/src/server/server.ts"
const settingsPath = "packages/app/src/components/dialog-settings.tsx"
const settings = 'import { SettingsNative } from "./settings-native"\n                    <Tabs.Trigger value="cron">\n        <Tabs.Content value="cron" class="no-scrollbar">\n'
const assets = ["packages/app/src/addons/superagent/settings.tsx", "packages/app/src/addons/superagent/client.ts","packages/app/src/addons/superagent/styles.css", "packages/app/src/addons/superagent/entry.tsx", "packages/app/src/addons/superagent/panel.tsx", "packages/app/src/addons/superagent/journal.ts", "packages/opencode/src/server/routes/superagent.ts"]
// Minimal source fixture uses exact current upstream mount anchors, while keeping
// unrelated code/comments and Unicode content to test byte-preserving removal.
const sidebar = 'import { Icon } from "@opencode-ai/ui/icon"\n// 用户原有侧栏\nexport const Sidebar = () => (\n        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">\n          <span>Existing entry</span>\n        </div>\n)\n'
const server = 'import { Hono } from "hono"\n// original server comment\nexport const app = new Hono()\n      .route("/global", GlobalRoutes())\n      .route("/existing", ExistingRoutes())\n'
let directory: string, root: string, bridge: string, token: string
function options() { return { root, bridge, token, url: "http://127.0.0.1:19700" } }
async function put(relative: string, content: string) { const p = path.join(root, relative); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, content) }
async function snapshot() {
  const output: Record<string, string> = {}
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.isFile()) output[path.relative(directory, p)] = Buffer.from(await readFile(p)).toString("base64")
    }
  }
  await walk(directory)
  return output
}
async function present(file: string) { return stat(file).then(() => true, () => false) }
beforeEach(async () => {
  const parent = path.join(homedir(), "data/aether-superagent-tests")
  await mkdir(parent, { recursive: true })
  directory = await mkdtemp(path.join(parent, "integration-")); root = path.join(directory, "Aether")
  bridge = path.join(directory, "config/superagent.json"); token = path.join(directory, "fixture-token")
  await mkdir(root); await git(root, "init")
  await put(sidebarPath, sidebar); await put(serverPath, server); await put(appPath, app); await put(layoutPath, layout); await put(settingsPath, settings)
  await writeFile(token, "fixture-secret-must-not-be-copied")
})

describe("independent source-integration lifecycle verification", () => {
  test("install has exact additions, no copied secret, and idempotent second install", async () => {
    const first = await install(options())
    expect(first.changed).toBe(true)
    expect(first.manifest).toBe(path.join(root, ".git/aether-superagent-install.json"))
    for (const asset of assets) expect(await present(path.join(root, asset))).toBe(true)
    const config = await readFile(bridge, "utf8")
    expect(JSON.parse(config)).toEqual({ url: options().url, tokenFile: token })
    expect(config).not.toContain("fixture-secret-must-not-be-copied")
    expect(await readFile(path.join(root, sidebarPath), "utf8")).toContain("<SuperagentEntry />")
    expect(await readFile(path.join(root, serverPath), "utf8")).toContain('.route("/superagent", SuperagentRoutes())')
    expect(await readFile(path.join(root, appPath), "utf8")).toContain('path="/superagent"')
    const before = await snapshot()
    expect((await install(options())).changed).toBe(false)
    expect(await snapshot()).toEqual(before)
  })

  test("uninstall restores original bytes and repeated uninstall is a no-op", async () => {
    const before = await snapshot()
    await install(options())
    expect((await uninstall(root)).changed).toBe(true)
    expect(await snapshot()).toEqual(before)
    expect(await readFile(path.join(root, sidebarPath), "utf8")).toBe(sidebar)
    expect(await readFile(path.join(root, serverPath), "utf8")).toBe(server)
    expect(await readFile(path.join(root, appPath), "utf8")).toBe(app)
    expect(await readFile(path.join(root, layoutPath), "utf8")).toBe(layout)
    expect(await uninstall(root)).toEqual({ installed: false, changed: false })
  })

  test("uninstall preserves user edits outside managed blocks and unrelated added files", async () => {
    await install(options())
    await put(sidebarPath, '// later user sidebar edit\n' + await readFile(path.join(root, sidebarPath), "utf8"))
    await put(serverPath, (await readFile(path.join(root, serverPath), "utf8")) + '// later user server edit\n')
    await put(appPath, "// user page route comment\n" + await readFile(path.join(root, appPath), "utf8"))
    await put(layoutPath, "// user layout comment\n" + await readFile(path.join(root, layoutPath), "utf8"))
    await put("packages/app/src/addons/superagent/user-note.txt", "leave this user file alone\n")
    expect((await install(options())).changed).toBe(false)
    await uninstall(root)
    expect(await readFile(path.join(root, sidebarPath), "utf8")).toBe('// later user sidebar edit\n' + sidebar)
    expect(await readFile(path.join(root, serverPath), "utf8")).toBe(server + '// later user server edit\n')
    expect(await readFile(path.join(root, appPath), "utf8")).toBe("// user page route comment\n" + app)
    expect(await readFile(path.join(root, layoutPath), "utf8")).toBe("// user layout comment\n" + layout)
    expect(await readFile(path.join(root, "packages/app/src/addons/superagent/user-note.txt"), "utf8")).toBe("leave this user file alone\n")
  })

  test("interrupted uninstall resumes saved removal plan and preserves existing outside-block edits", async () => {
    const installed = await install(options())
    const prefix = "// user addition before uninstall\n"
    await put(sidebarPath, prefix + await readFile(path.join(root, sidebarPath), "utf8"))
    const receipt = JSON.parse(await readFile(installed.manifest, "utf8")) as {
      files: { file: string; before: string | null; blocks?: string[] }[]
      removals?: { file: string; current: string; after: string | null }[]
    }
    const removals = await Promise.all(receipt.files.map(async (item) => {
      const current = await readFile(item.file, "utf8")
      return { file: item.file, current, after: item.blocks ? item.blocks.reduce((text, block) => text.replace(block, ""), current) : null }
    }))
    // Durable state after the uninstall plan was saved, some assets were removed,
    // and a mount file was restored before process interruption.
    receipt.removals = removals
    await writeFile(installed.manifest, JSON.stringify(receipt))
    await unlink(path.join(root, assets[0]!))
    await put(sidebarPath, prefix + sidebar)
    await expect(install(options())).rejects.toThrow("uninstall is in progress")
    expect((await uninstall(root)).changed).toBe(true)
    expect(await readFile(path.join(root, sidebarPath), "utf8")).toBe(prefix + sidebar)
    expect(await readFile(path.join(root, serverPath), "utf8")).toBe(server)
    expect(await readFile(path.join(root, appPath), "utf8")).toBe(app)
    expect(await readFile(path.join(root, layoutPath), "utf8")).toBe(layout)
    for (const asset of assets) expect(await present(path.join(root, asset))).toBe(false)
    expect(await present(bridge)).toBe(false)
    expect(await present(installed.manifest)).toBe(false)
    expect((await uninstall(root)).changed).toBe(false)
  })

  test("modified managed asset refuses reinstall and uninstall without partial deletion", async () => {
    await install(options())
    const asset = "packages/app/src/addons/superagent/panel.tsx"
    await put(asset, (await readFile(path.join(root, asset), "utf8")) + '\n// user changed managed file\n')
    const before = await snapshot()
    await expect(install(options())).rejects.toThrow("Managed installation changed")
    await expect(uninstall(root)).rejects.toThrow("refusing to delete")
    expect(await snapshot()).toEqual(before)
  })

  test("modified managed mount block refuses uninstall before deleting assets", async () => {
    await install(options())
    await put(serverPath, (await readFile(path.join(root, serverPath), "utf8")).replace('SuperagentRoutes())', 'SuperagentRoutes({ custom: true }))'))
    const before = await snapshot()
    await expect(uninstall(root)).rejects.toThrow("Mount block changed")
    expect(await snapshot()).toEqual(before)
  })

  test("edited bridge configuration is user work and cannot be removed", async () => {
    await install(options())
    await writeFile(bridge, '{"url":"http://127.0.0.1:29999","userEdited":true}\n')
    const before = await snapshot()
    await expect(uninstall(root)).rejects.toThrow("refusing to delete")
    expect(await snapshot()).toEqual(before)
  })

  test("incompatible last mount anchor is rejected without any partial installation", async () => {
    await put(serverPath, server.replace('.route("/global", GlobalRoutes())', '.route("/globals-v2", GlobalRoutes())'))
    const before = await snapshot()
    await expect(install(options())).rejects.toThrow("expected one anchor")
    expect(await snapshot()).toEqual(before)
    expect(await present(bridge)).toBe(false)
  })

  test("incompatible page route anchor refuses all assets and other mount edits", async () => {
    await put(appPath, app.replace('component={HomeRoute}', 'component={NewHomeRoute}'))
    const before = await snapshot()
    await expect(install(options())).rejects.toThrow("expected one anchor")
    expect(await snapshot()).toEqual(before)
  })

  test("incompatible final layout anchor refuses partial page and backend mounts", async () => {
    await put(layoutPath, layout.replace("createInlineEditorController()", "createNewEditor()"))
    const before = await snapshot()
    await expect(install(options())).rejects.toThrow("expected one anchor")
    expect(await snapshot()).toEqual(before)
  })

  test("duplicate mount anchor is rejected without writing a receipt or assets", async () => {
    await put(sidebarPath, sidebar + 'import { Icon } from "@opencode-ai/ui/icon"\n')
    const before = await snapshot()
    await expect(install(options())).rejects.toThrow("expected one anchor")
    expect(await snapshot()).toEqual(before)
  })

  test("existing foreign asset or bridge is never overwritten", async () => {
    await put(assets[0]!, "user's original addon\n")
    let before = await snapshot()
    await expect(install(options())).rejects.toThrow("Refusing to replace existing file")
    expect(await snapshot()).toEqual(before)
    await unlink(path.join(root, assets[0]!))
    await mkdir(path.dirname(bridge), { recursive: true }); await writeFile(bridge, "user config\n")
    before = await snapshot()
    await expect(install(options())).rejects.toThrow("Refusing to replace existing bridge")
    expect(await snapshot()).toEqual(before)
  })

  test("reinstall with changed bridge settings refuses without mutation", async () => {
    await install(options())
    const before = await snapshot()
    await expect(install({ ...options(), url: "http://127.0.0.1:19701" })).rejects.toThrow("different bridge settings")
    expect(await snapshot()).toEqual(before)
  })

  test("non-loopback or credential-bearing coordinator URL is refused in preflight", async () => {
    const before = await snapshot()
    for (const url of ["https://example.com", "http://user:password@127.0.0.1:19700", "http://127.0.0.1:19700/private", "http://127.0.0.1:19700/?token=secret"]) {
      await expect(install({ ...options(), url })).rejects.toThrow("loopback HTTP origin")
      expect(await snapshot()).toEqual(before)
    }
  })
})
