import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WolframMCP } from "../../src/mcp/wolfram"
import { tmpdir } from "../fixture/fixture"

test("builds WolframLanguage local MCP config", async () => {
  await using tmp = await tmpdir()
  const bin = path.join(tmp.path, "wolfram")
  await fs.writeFile(bin, "")
  await fs.chmod(bin, 0o755)

  const cfg = WolframMCP.config({
    binary: bin,
    server: "WolframLanguage",
    timeout: 12_345,
  })

  expect(cfg).toEqual({
    type: "local",
    command: [bin, "-run", WolframMCP.START, "-noinit", "-noprompt"],
    enabled: true,
    timeout: 12_345,
    environment: {
      MCP_SERVER_NAME: "WolframLanguage",
    },
  })
})
