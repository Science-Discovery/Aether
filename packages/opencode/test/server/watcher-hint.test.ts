import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { WatcherHint } from "../../src/project/watcher-hint"
import { Instance } from "../../src/project/instance"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  WatcherHint.clear()
  await Instance.disposeAll()
  await resetDatabase()
})

describe("watcher hint endpoint", () => {
  test("stores the current limited watch hint snapshot", async () => {
    const app = Server.Default()
    const res = await app.request("/global/watcher-hint", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "lease-a",
        directory: "/tmp/app",
        files: ["src/main.ts", "README.md"],
        dirs: ["src/components", "docs"],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      directory: "/tmp/app",
      files: ["README.md", "src/main.ts"],
      dirs: ["docs", "src/components"],
      watched: ["/tmp/app", "/tmp/app/docs", "/tmp/app/src", "/tmp/app/src/components"],
    })
  })

  test("drops watcher hints when the lease is released", async () => {
    const app = Server.Default()

    await app.request("/global/watcher-hint", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "lease-a",
        directory: "/tmp/app",
        files: ["src/main.ts"],
        dirs: ["docs"],
      }),
    })

    const ping = await app.request("/global/ping", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "lease-a",
        alive: false,
      }),
    })

    expect(ping.status).toBe(200)
    expect(WatcherHint.get("lease-a")).toBeUndefined()
  })
})
