import net from "node:net"

async function port() {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("failed to allocate port")))
        return
      }
      srv.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(addr.port)
      })
    })
  })
}

export async function serve(opts: Parameters<typeof Bun.serve>[0]) {
  return Bun.serve({
    ...opts,
    port: opts.port === 0 ? await port() : opts.port,
  } as any)
}
