import type { ToolPart } from "@opencode-ai/sdk/v2/client"
import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

const isBash = (part: unknown): part is ToolPart => {
  if (!part || typeof part !== "object") return false
  if (!("type" in part) || part.type !== "tool") return false
  if (!("tool" in part) || part.tool !== "bash") return false
  return "state" in part
}

test("shell mode runs a command in the project directory", async ({ page, project }) => {
  test.setTimeout(120_000)

  const cmd = process.platform === "win32" ? "dir" : "ls"

  await project.open()
  const id = await project.shell(cmd)

  await expect
    .poll(
      async () => {
        const list = await project.sdk.session.messages({ sessionID: id, limit: 50 }).then((x) => x.data ?? [])
        const msg = list.findLast(
          (item) => item.info.role === "assistant" && "path" in item.info && item.info.path.cwd === project.directory,
        )
        if (!msg) return

        const part = msg.parts
          .filter(isBash)
          .find((item) => item.state.input?.command === cmd && item.state.status === "completed")

        if (!part || part.state.status !== "completed") return
        const output = typeof part.state.metadata?.output === "string" ? part.state.metadata.output : part.state.output
        if (!output.includes("README.md")) return

        return { cwd: project.directory, output }
      },
      { timeout: 90_000 },
    )
    .toEqual(expect.objectContaining({ cwd: project.directory, output: expect.stringContaining("README.md") }))

  await expect(page.locator(promptSelector)).toHaveText("")
})
