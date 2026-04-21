import { describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

describe("file.download endpoint", () => {
  test("serves uploaded-style unicode filenames without 500", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "测试.txt"), "hello")
      },
    })

    const app = Server.Default()
    const res = await app.request(`/file/download?path=${encodeURIComponent("测试.txt")}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Disposition")).toContain("filename*=")
    expect(await res.text()).toBe("hello")
  })
})
