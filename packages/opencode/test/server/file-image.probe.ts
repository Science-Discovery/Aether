import path from "node:path"

const root = process.env.AETHER_IMAGE_ROOT
const output = process.env.AETHER_IMAGE_OUTPUT
if (!root || !output) throw new Error("Image probe paths are required")

// Import the real server only after supplying its credentials in this isolated process.
process.env.OPENCODE_SERVER_PASSWORD = "image-test-secret"
process.env.OPENCODE_SERVER_USERNAME = "image-test-user"
process.env.OPENCODE_DISABLE_MOBILE = "1"

await using upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/proxy-image.html") return new Response(null, { status: 404 })
    return new Response("<!doctype html><title>Image preview CSP probe</title>", {
      headers: { "Content-Type": "text/html" },
    })
  },
})
process.env.AETHER_WEB_ORIGIN = upstream.url.origin

const { Server } = await import("../../src/server/server")
const { Instance } = await import("../../src/project/instance")
const { Database } = await import("../../src/storage/db")
const { Log } = await import("../../src/util/log")
await Log.init({ print: false, dev: true, level: "ERROR" })

const files: string[] = await Bun.file(path.join(root, "files.json")).json()
const directory = path.join(root, "project")
await Instance.provide({ directory, fn: () => {} })
const app = Server.createApp({})
const auth = `Basic ${Buffer.from("image-test-user:image-test-secret").toString("base64")}`
const results: Record<string, { status: number; headers: Record<string, string>; body: string }> = {}

const read = async (key: string, target: string, authorization?: string, method = "GET") => {
  const res = await app.request(target, {
    method,
    headers: { origin: "null", ...(authorization ? { authorization } : {}) },
  })
  results[key] = {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    body: Buffer.from(await res.arrayBuffer()).toString("base64"),
  }
}

const query = (file: string) => `path=${encodeURIComponent(file)}&directory=${encodeURIComponent(directory)}`
for (const file of files) {
  await read(`raw:${file}`, `/file/raw?${query(file)}`, auth)
  await read(`unauthorized:${file}`, `/file/raw?${query(file)}`)
  await read(`metadata:${file}`, `/file/metadata?${query(file)}`, auth)
  if (/\.(jpe|jfif)$/i.test(file)) await read(`content:${file}`, `/file/content?${query(file)}`, auth)
}
await read(
  "wrong-password",
  `/file/raw?${query(files[0])}`,
  `Basic ${Buffer.from("image-test-user:wrong").toString("base64")}`,
)
await read("traversal", `/file/raw?${query("../outside.png")}`, auth)
await read("absolute", `/file/raw?${query(path.join(root, "outside.png"))}`, auth)
await read("missing", `/file/raw?${query("missing.png")}`, auth)
await read("preflight", `/file/raw?${query(files[0])}`, undefined, "OPTIONS")

// Force the remote-web route even when the real executable has local web assets.
const executable = process.execPath
Object.defineProperty(process, "execPath", { value: path.join(root, "bin", "aether"), configurable: true })
try {
  await read("web-policy", `/proxy-image.html?directory=${encodeURIComponent(directory)}`, auth)
} finally {
  Object.defineProperty(process, "execPath", { value: executable, configurable: true })
}

await Instance.disposeAll()
Database.close()
await Bun.write(output, JSON.stringify(results))
