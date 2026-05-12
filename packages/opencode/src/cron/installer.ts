import { Cron } from "."

export type InstalledCron = {
  service: typeof Cron
  start(): Promise<void>
  stop(): Promise<void>
  purge(): Promise<void>
}

export async function installCron(): Promise<InstalledCron> {
  await Cron.start()
  return {
    service: Cron,
    start: Cron.start,
    stop: Cron.stop,
    purge: Cron.purge,
  }
}
