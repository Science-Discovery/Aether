import { FeishuManager } from "./feishu"
import { QQManager } from "./qq"
import { WeChatManager } from "./wechat"
import { Presence, type Info } from "../server/presence"

const INTERVAL = 60_000
const FIRST_DELAY = 5_000

const managers = [FeishuManager, QQManager, WeChatManager]

// A same-channel sibling occupies a platform while its bridge is on the way
// to or standing at "connected" — the mirror of the local predicate that
// keeps this supervisor from restarting a manager already off "idle"/"error".
// Siblings that predate the mobile field fail open (never block).
export function occupied(siblings: Info[], platform: string) {
  return siblings.some((sibling) => {
    const status = sibling.mobile?.[platform]
    return status !== undefined && status !== "idle" && status !== "error"
  })
}

Presence.report(() => Object.fromEntries(managers.map((m) => [m.adapter.platform, m.status])))

class SupervisorImpl {
  private timer: ReturnType<typeof setInterval> | null = null
  private first: ReturnType<typeof setTimeout> | null = null
  private running = false

  start() {
    if (process.env.OPENCODE_DISABLE_MOBILE === "true") return
    if (this.timer) return
    this.first = setTimeout(() => {
      this.first = null
      void this.tick()
    }, FIRST_DELAY)
    this.first.unref?.()
    this.timer = setInterval(() => void this.tick(), INTERVAL)
  }

  async stop() {
    if (this.first) {
      clearTimeout(this.first)
      this.first = null
    }
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async tick() {
    if (this.running) return
    this.running = true
    try {
      const siblings = await Presence.others()
      for (const manager of managers) {
        try {
          if (!(await manager.desired())) continue
          if (!(await manager.hasCredentials())) continue
          if (manager.status !== "idle" && manager.status !== "error") continue
          if (occupied(siblings, manager.adapter.platform)) {
            console.log(`[mobile-supervisor] skip auto-start ${manager.platformName()}: sibling holds the bridge`)
            continue
          }
          console.log(`[mobile-supervisor] auto-start ${manager.platformName()}`)
          await manager.start()
        } catch (err) {
          console.error("[mobile-supervisor] tick error:", err)
        }
      }
    } finally {
      this.running = false
    }
  }
}

export const MobileSupervisor = new SupervisorImpl()
