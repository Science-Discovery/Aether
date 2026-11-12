import path from "node:path"
import { mkdir, readFile, writeFile, unlink, rename, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { git } from "./workspace"

type Edit = { file: string; before: string | null; after: string; blocks?: string[] }
type Removal = { file: string; current: string | null; after: string | null }
type Receipt = { version: 1; installation?: string; root: string; files: Edit[]; removals?: Removal[] }
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const read = (file: string) => readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null
  throw error
})
async function atomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
  await rename(temporary, file)
}
async function manifest(root: string) {
  return path.join(await git(root, "rev-parse", "--absolute-git-dir"), "aether-superagent-install.json")
}
function add(text: string, anchor: string, block: string) {
  if (text.split(anchor).length !== 2) throw new Error(`Unsupported Aether source: expected one anchor ${JSON.stringify(anchor)}.`)
  return text.replace(anchor, anchor + block)
}

export async function install(options: { root: string; bridge: string; url: string; token: string }) {
  const root = await realpath(options.root)
  const file = await manifest(root)
  const existing = await read(file)
  if (existing) {
    const receipt = JSON.parse(existing) as Receipt
    if (receipt.root !== root) throw new Error("Installation receipt belongs to another checkout.")
    if (receipt.removals) throw new Error("An uninstall is in progress. Finish uninstalling before installing again.")
    for (const item of receipt.files) {
      const current = await read(item.file)
      if (item.blocks ? !item.blocks.every((block) => current?.split(block).length === 2) : current !== item.after)
        throw new Error(`Managed installation changed: ${item.file}. Review before updating or uninstalling.`)
    }
    const bridge = receipt.files.find((item) => item.file === path.resolve(options.bridge))
    if (!bridge || bridge.after !== JSON.stringify({ url: options.url, tokenFile: path.resolve(options.token) }, null, 2) + "\n")
      throw new Error("Already installed with different bridge settings. Uninstall before changing them.")
    return { installed: true, changed: false, manifest: file }
  }
  const installation = crypto.randomUUID()
  const files: Edit[] = []
  for (const [source, target] of [
    ["app/permissions.tsx", "packages/app/src/addons/superagent/permissions.tsx"],
    ["app/permission-cache.ts", "packages/app/src/addons/superagent/permission-cache.ts"],
    ["app/settings.tsx", "packages/app/src/addons/superagent/settings.tsx"],
    ["app/client.ts", "packages/app/src/addons/superagent/client.ts"],
    ["app/entry.tsx", "packages/app/src/addons/superagent/entry.tsx"],
    ["app/panel.tsx", "packages/app/src/addons/superagent/panel.tsx"],
    ["app/journal.ts", "packages/app/src/addons/superagent/journal.ts"],
    ["app/styles.css", "packages/app/src/addons/superagent/styles.css"],
    ["server/routes.ts", "packages/opencode/src/server/routes/superagent.ts"],
  ]) {
    const destination = path.join(root, target!)
    if (await read(destination) !== null) throw new Error(`Refusing to replace existing file: ${destination}`)
    files.push({ file: destination, before: null, after: await readFile(path.join(import.meta.dir, "../integration", source!), "utf8") })
  }
  const bridge = path.resolve(options.bridge)
  const configDir = path.dirname(bridge)
  for (const [source, destination] of [
    ["plugin/superagent.ts", path.join(configDir, "plugins/aether-superagent-v05.ts")],
    ["agents/superagent.md", path.join(configDir, "agents/superagent.md")],
    ["agents/superagent-worker.md", path.join(configDir, "agents/superagent-worker.md")],
  ]) {
    if (await read(destination!) !== null) throw new Error(`Refusing to replace existing file: ${destination}`)
    const content = await readFile(path.join(import.meta.dir, "../integration", source!), "utf8")
    files.push({ file: destination!, before: null, after: content.replace("__SUPERAGENT_BRIDGE__", JSON.stringify(bridge)).replace("__SUPERAGENT_PLUGIN__", JSON.stringify(path.join(root, "packages/plugin/src/index.ts"))) })
  }
  const lifecycle = path.join(path.dirname(path.resolve(options.token)), "integration.json")
  if (await read(lifecycle) !== null) throw new Error(`Refusing to replace existing file: ${lifecycle}`)
  files.push({ file: lifecycle, before: null, after: JSON.stringify({ root, bridge, tokenFile: path.resolve(options.token), installation }, null, 2) + "\n" })
  if (await read(bridge) !== null) throw new Error(`Refusing to replace existing bridge config: ${bridge}`)
  const url = new URL(options.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Coordinator must be a loopback HTTP origin without credentials or a path.")
  files.push({ file: bridge, before: null, after: JSON.stringify({ url: options.url, tokenFile: path.resolve(options.token) }, null, 2) + "\n" })
  for (const target of ["packages/app/src/pages/layout/sidebar-shell.tsx", "packages/opencode/src/server/server.ts", "packages/app/src/app.tsx", "packages/app/src/pages/layout.tsx", "packages/app/src/components/dialog-settings.tsx"]) {
    const destination = path.join(root, target)
    const before = await readFile(destination, "utf8")
    if (before.includes("aether-superagent:")) throw new Error(`Unmanaged super-agent markers found in ${target}.`)
    const settings = target.endsWith("/dialog-settings.tsx")
    const frontend = target.includes("sidebar")
    const router = target.endsWith("/app.tsx")
    const layout = target.endsWith("/layout.tsx")
    const blocks = settings ? [
      '// aether-superagent:import:start\nimport { SettingsSuperagent } from "@/addons/superagent/settings"\n// aether-superagent:import:end\n',
      '                    {/* aether-superagent:settings-tab:start */}\n                    <Tabs.Trigger value="superagent"><Icon name="task" />Super-agent</Tabs.Trigger>\n                    {/* aether-superagent:settings-tab:end */}\n',
      '        {/* aether-superagent:settings-page:start */}\n        <Tabs.Content value="superagent" class="no-scrollbar"><SettingsSuperagent /></Tabs.Content>\n        {/* aether-superagent:settings-page:end */}\n',
    ] : layout ? [
      '// aether-superagent:import:start\nimport { useLocation } from "@solidjs/router"\n// aether-superagent:import:end\n',
      '  // aether-superagent:route:start\n  const research = useLocation()\n  const forward = (href: string) => navigateWithSidebarReset(href)\n  createEffect(() => {\n    if (research.pathname.replace(/\\/+$/, "").endsWith("/superagent")) setState("autoselect", false)\n  })\n  // aether-superagent:route:end\n',
      '    // aether-superagent:navigation:start\n    const origin = research.pathname\n    const navigateWithSidebarReset = (href: string) => {\n      if (research.pathname !== origin && research.pathname.replace(/\\/+$/, "").endsWith("/superagent")) return\n      forward(href)\n    }\n    // aether-superagent:navigation:end\n',
    ] : router ? [
      '// aether-superagent:import:start\nconst Research = lazy(() => import("@/addons/superagent/panel"))\n// aether-superagent:import:end\n',
      '                  {/* aether-superagent:route:start */}\n                  <Route path="/superagent" component={Research} />\n                  {/* aether-superagent:route:end */}\n',
    ] : frontend ? [
      '// aether-superagent:import:start\nimport { SuperagentEntry } from "@/addons/superagent/entry"\n// aether-superagent:import:end\n',
      '          {/* aether-superagent:entry:start */}\n          <SuperagentEntry />\n          {/* aether-superagent:entry:end */}\n',
    ] : [
      '// aether-superagent:import:start\nimport { SuperagentRoutes } from "./routes/superagent"\n// aether-superagent:import:end\n',
      '      // aether-superagent:route:start\n      .route("/superagent", SuperagentRoutes())\n      // aether-superagent:route:end\n',
    ]
    const anchors = settings ? [
      'import { SettingsNative } from "./settings-native"\n',
      '                    </Tabs.Trigger>\n                    <Tabs.Trigger value="cron">\n',
      '        <Tabs.Content value="cron" class="no-scrollbar">\n',
    ] : layout ? ['import { useNavigate, useParams } from "@solidjs/router"\n', '  const editor = createInlineEditorController()\n', '  async function navigateToProject(directory: string | undefined) {\n'] : router ? [
      'const HomeRoute = lazy(() => import("@/pages/home"))\n',
      '                  <Route path="/" component={HomeRoute} />\n',
    ] : frontend ? [
      'import { Icon } from "@opencode-ai/ui/icon"\n',
      '        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">\n',
    ] : ['import { Hono } from "hono"\n', '      .route("/global", GlobalRoutes())\n']
    const after = blocks.reduce((text, block, i) => {
      if (settings && i > 0) {
        const anchor = i === 1 ? '                    <Tabs.Trigger value="cron">\n' : anchors[i]!
        if (text.split(anchor).length !== 2) throw new Error(`Unsupported Aether source: expected one anchor ${JSON.stringify(anchor)}.`)
        return text.replace(anchor, block + anchor)
      }
      return add(text, anchors[i]!, block)
    }, before)
    files.push({ file: destination, before, after, blocks })
  }
  // Preflight is complete before writing anything. Keep a durable receipt first,
  // so an interrupted install can be rolled back by uninstall rather than reset.
  const receipt: Receipt = { version: 1, installation, root, files }
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  try {
    for (const item of files) {
      if (await read(item.file) !== item.before) throw new Error(`Concurrent edit detected: ${item.file}`)
      await atomic(item.file, item.after)
    }
  } catch (error) {
    await uninstall(root).catch(() => undefined)
    throw error
  }
  return { installed: true, changed: true, manifest: file }
}

export async function uninstall(directory: string) {
  const root = await realpath(directory)
  const file = await manifest(root)
  const raw = await read(file)
  if (!raw) return { installed: false, changed: false }
  const receipt = JSON.parse(raw) as Receipt
  if (receipt.version !== 1 || receipt.root !== root) throw new Error("Invalid installation receipt.")
  const plan: Removal[] = receipt.removals ?? []
  for (const item of receipt.removals ? [] : receipt.files) {
    const current = await read(item.file)
    if (current === item.before) continue // Not yet written in an interrupted install.
    if (item.blocks) {
      if (current === null || !item.blocks.every((block) => current.split(block).length === 2))
        throw new Error(`Mount block changed; refusing to overwrite edits: ${item.file}`)
      plan.push({ file: item.file, current, after: item.blocks.reduce((text, block) => text.replace(block, ""), current) })
      continue
    }
    if (current !== null && hash(current) !== hash(item.after)) throw new Error(`Added file was edited; refusing to delete: ${item.file}`)
    if (current !== null) plan.push({ file: item.file, current, after: null })
  }
  for (const item of plan) {
    const current = await read(item.file)
    if (current !== item.current && current !== item.after) throw new Error(`Concurrent edit detected: ${item.file}`)
  }
  // Save exact removal results before writing, so interrupted uninstalls can
  // resume even when the user had edited outside our mount blocks.
  if (!receipt.removals) await atomic(file, JSON.stringify({ ...receipt, removals: plan }, null, 2) + "\n")
  for (const item of plan) {
    const current = await read(item.file)
    if (current === item.after) continue
    if (current !== item.current) throw new Error(`Concurrent edit detected: ${item.file}`)
    if (item.after === null) await unlink(item.file)
    else await atomic(item.file, item.after)
  }
  await unlink(file)
  return { installed: false, changed: true }
}
