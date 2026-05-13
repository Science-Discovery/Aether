export async function serve(opts: Parameters<typeof Bun.serve>[0]) {
  return Bun.serve({
    hostname: "127.0.0.1",
    ...opts,
  } as any)
}
