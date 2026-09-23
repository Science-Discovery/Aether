import { FeishuManager } from "./feishu"
import { QQManager } from "./qq"
import { WeChatManager } from "./wechat"

const INTERVAL = 60_000
const FIRST_DELAY = 5_000

const managers = [FeishuManager, QQManager, WeChatManager]

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
      for (const manager of managers) {
        try {
          if (!(await manager.desired())) continue
          if (!(await manager.hasCredentials())) continue
          if (manager.status !== "idle" && manager.status !== "error") continue
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
