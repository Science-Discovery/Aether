import { expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { execute } from "../execute.js"

// Opt-in because nested OS sandboxes are unavailable in some CI/agent environments.
test.skipIf(process.env.LOCA_SANDBOX_TEST !== "1")(
  "real OS execution denies undeclared files, writes, forks and network",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "loca-secret-"))
    const secret = path.join(dir, "secret.txt")
    await writeFile(secret, "must not be visible")
    const code = `import os, socket, json
from pathlib import Path
result = {"answer": 2 + 2, "inputs": json.loads((Path(os.environ["LOCA_INPUTS"]) / "manifest.json").read_text())}
for name, action in [
  ("read", lambda: Path(${JSON.stringify(secret)}).read_text()),
  ("write", lambda: Path(${JSON.stringify(path.join(dir, "unexpected"))}).write_text("bad")),
  ("network", lambda: socket.create_connection(("127.0.0.1", 9), timeout=1)),
  ("fork", lambda: os.fork()),
]:
  try:
    action()
    result[name] = "ALLOWED"
  except PermissionError:
    result[name] = "denied"
  except BlockingIOError:
    result[name] = "denied"
  except OSError as error:
    result[name] = "denied" if error.errno in (1, 11, 13) else str(error)
print(json.dumps(result))
Path("answer.txt").write_text("4")
`
    const result = await execute(
      code,
      [{ id: "data", hash: "fixture", content: "2" }],
      { python: "python3", timeout: 5000, bytes: 10000 },
      new AbortController().signal,
    )
    await rm(dir, { recursive: true, force: true })
    expect(result.exit).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      answer: 4,
      read: "denied",
      write: "denied",
      network: "denied",
      fork: "denied",
    })
    expect(result.files).toEqual([{ name: "answer.txt", content: "4" }])
  },
)

test.skipIf(process.env.LOCA_SANDBOX_TEST !== "1")("sandbox timeout cannot become a successful execution", async () => {
  const result = await execute(
    "while True: pass",
    [],
    { python: "python3", timeout: 200, bytes: 10000 },
    new AbortController().signal,
  )
  expect(result.exit).not.toBe(0)
})
