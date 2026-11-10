import path from "node:path"
import { readFile, realpath } from "node:fs/promises"
import type { Engine } from "./engine"
import { uninstall } from "./integration"
import { git } from "./workspace"

export class LifecycleError extends Error { constructor(message: string, readonly status = 409) { super(message) } }

// Only the installer-recorded checkout can be removed. No request-supplied paths.
export async function removeIntegration(engine: Engine, master?: { session: string; directory: string }) {
  if (engine.active.size || engine.store.inputs().some((input) => ["dispatching", "uncertain"].includes(input.state)))
    throw new LifecycleError("仍有运行中或状态待核对的任务。请先等待完成，或停止任务并确认状态，再卸载。")
  if (master && await engine.aether.status(master.directory, master.session) !== "idle")
    throw new LifecycleError("主会话仍在运行，请等待当前回复结束再卸载。")
  const tokenFile = path.join(engine.config.state, "token")
  let record: { root: string; bridge: string; tokenFile: string; installation?: string }
  try { record = JSON.parse(await readFile(path.join(engine.config.state, "integration.json"), "utf8")) }
  catch { throw new LifecycleError("未找到这份安装的记录。请使用安装器的 --uninstall 命令检查原安装位置。") }
  if (record.tokenFile !== tokenFile || !path.isAbsolute(record.root) || !path.isAbsolute(record.bridge) || await realpath(record.root) !== record.root)
    throw new LifecycleError("安装记录与当前协调器不匹配，已保留所有文件。")
  const manifest = path.join(await git(record.root, "rev-parse", "--absolute-git-dir"), "aether-superagent-install.json")
  const receipt = JSON.parse(await readFile(manifest, "utf8")) as { root: string; installation?: string; files: { file: string; after: string }[] }
  const bridge = receipt.files.find((file) => file.file === record.bridge)
  if (receipt.root !== record.root || !bridge || JSON.parse(bridge.after).tokenFile !== tokenFile)
    throw new LifecycleError("安装清单与当前协调器不匹配，已保留所有文件。")
  if (record.installation) engine.store.setting("native:installation", record.installation)
  const result = await uninstall(record.root)
  engine.store.setting("native:uninstalled", "true")
  return { ...result, retained: ["Aether sessions", "research records", "workspaces", "provider credentials"],
    message: "已移除 Super-agent 集成。已有会话、研究记录和模型配置已保留。请刷新页面；已加载的插件将在下次加载工作区时移除。" }
}

// A new, matching installer receipt allows reinstallation without deleting research
// data. It never automatically re-enables scheduling or changes user preferences.
export async function refreshInstallation(engine: Engine) {
  try {
    const record = JSON.parse(await readFile(path.join(engine.config.state, "integration.json"), "utf8"))
    if (typeof record.installation !== "string" || record.installation === engine.store.setting("native:installation")) return
    if (record.tokenFile !== path.join(engine.config.state, "token") || !path.isAbsolute(record.root) || await realpath(record.root) !== record.root) return
    const manifest = path.join(await git(record.root, "rev-parse", "--absolute-git-dir"), "aether-superagent-install.json")
    const receipt = JSON.parse(await readFile(manifest, "utf8"))
    if (receipt.root !== record.root || receipt.installation !== record.installation || receipt.removals) return
    const bridge = receipt.files.find((item: { file: string }) => item.file === record.bridge)
    if (!bridge || JSON.parse(bridge.after).tokenFile !== record.tokenFile || await readFile(record.bridge, "utf8") !== bridge.after) return
    const complete = await Promise.all(receipt.files.map(async (item: { file: string; after: string; blocks?: string[] }) => {
      const current = await readFile(item.file, "utf8")
      return item.blocks ? item.blocks.every((block) => current.split(block).length === 2) : current === item.after
    }))
    if (!complete.every(Boolean)) return
    engine.store.atomic(() => {
      engine.store.setting("native:installation", record.installation)
      engine.store.setting("native:uninstalled", "false")
    })
  } catch { /* Missing or interrupted installations are never treated as installed. */ }
}
