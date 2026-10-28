import path from "node:path"

const root = process.argv[2]
const mode = await Bun.file(path.join(root, "mode")).text()
const out = process.argv[process.argv.indexOf("--out") + 1]
await Bun.write(
  path.join(root, "audit.json"),
  JSON.stringify({
    pid: process.pid,
    home: process.env.CODEX_HOME,
    user: process.env.USERPROFILE,
    token: process.env.AETHER_MODE_TEST_SECRET,
    out,
    args: process.argv.slice(3),
  }),
)
if (mode === "fail") process.exit(2)
if (mode === "hang") {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !(await Bun.file(path.join(root, "release")).exists())) await Bun.sleep(50)
  process.exit(0)
}
const docs = await Bun.file(path.join(root, "schemas.json")).json()
for (const [key, file] of Object.entries({
  steer: "v2/TurnSteerParams.json",
  start: "v2/TurnStartParams.json",
  list: "v2/CollaborationModeListResponse.json",
  requests: "ClientRequest.json",
})) {
  await Bun.write(path.join(out, file), JSON.stringify(mode === "old" ? {} : docs[key]))
}
