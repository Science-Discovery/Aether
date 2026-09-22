import { expect, test } from "bun:test"
import net from "node:net"
import { freePort } from "./port"

function occupy() {
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to occupy a port")))
        return
      }
      resolve({ port: address.port, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

test("freePort returns a valid bindable port", async () => {
  const port = await freePort()
  expect(Number.isInteger(port)).toBe(true)
  expect(port).toBeGreaterThan(0)
  expect(port).toBeLessThan(65536)
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()))
  })
})

test("freePort never returns a port that is already in use", async () => {
  const busy = await occupy()
  for (let i = 0; i < 25; i++) {
    expect(await freePort()).not.toBe(busy.port)
  }
  await busy.close()
})

test("freePort is safe to call concurrently", async () => {
  const ports = await Promise.all(Array.from({ length: 8 }, () => freePort()))
  for (const port of ports) {
    expect(port).toBeGreaterThan(0)
  }
})
