export async function serve(opts: Parameters<typeof Bun.serve>[0]) {
  return Bun.serve(opts)
}
