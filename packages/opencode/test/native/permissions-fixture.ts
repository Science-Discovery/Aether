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
    token: process.env.AETHER_PERMISSION_TEST_SECRET,
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
for (const name of ["ThreadStartParams", "ThreadResumeParams", "TurnStartParams"]) {
  await Bun.write(
    path.join(out, "v2", `${name}.json`),
    JSON.stringify({
      properties: { approvalsReviewer: { anyOf: [{ $ref: "#/definitions/ApprovalsReviewer" }, { type: "null" }] } },
      definitions: {
        ApprovalsReviewer: { enum: mode === "old" && name === "TurnStartParams" ? ["user"] : ["user", "auto_review"] },
      },
    }),
  )
}
