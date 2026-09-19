import { expect, test } from "bun:test"
import { execute } from "../execute.js"

// OS 沙箱实测：CI 或已处于沙箱内的 agent 环境会禁止嵌套沙箱，显式开启才运行。
const enabled = !!process.env.LOCA_SANDBOX_TEST
const maybe = enabled ? test : test.skip

maybe("sandbox isolates filesystem, network and spawn", async () => {
  const run = await execute(
    `import os, socket, subprocess, sys, json
out = os.environ.get("LOCA_OUTPUTS")
manifest = json.load(open(os.path.join(os.environ["LOCA_INPUTS"], "manifest.json")))
read = open(os.path.join(os.environ["LOCA_INPUTS"], manifest[0]["file"])).read()
open(os.path.join(out, "read.txt"), "w").write(read)
for name, fn in [
    ("spawn", lambda: subprocess.run(["/bin/true"])),
    ("net", lambda: socket.socket().connect(("127.0.0.1", 1))),
    ("home", lambda: open(os.path.expanduser("~/.zshenv"), "rb").read()),
]:
    try:
        fn()
        open(os.path.join(out, name + ".txt"), "w").write("ALLOWED")
    except Exception as error:
        open(os.path.join(out, name + ".txt"), "w").write("BLOCKED " + type(error).__name__)
sys.exit(0)
`,
    [{ id: "input:x", hash: "h", name: "lorem.txt", content: "lorem ipsum" }],
    { python: "python3", bytes: 1000000 },
  )
  expect(run.exit).toBe(0)
  const files = Object.fromEntries(run.files.map((file) => [file.name, file.content]))
  expect(files["read.txt"]).toBe("lorem ipsum")
  expect(files["spawn.txt"]).toContain("BLOCKED")
  expect(files["net.txt"]).toContain("BLOCKED")
  expect(files["home.txt"]).toContain("BLOCKED")
})

maybe("sandbox reports failing exit codes and stderr", async () => {
  const run = await execute("import sys\nsys.stderr.write('boom')\nsys.exit(3)\n", [], {
    python: "python3",
    bytes: 1000000,
  })
  expect(run.exit).toBe(3)
  expect(run.stderr).toContain("boom")
})
