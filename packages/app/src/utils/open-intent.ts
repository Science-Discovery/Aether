const intents = new Map<string, string>()

export const OpenIntent = {
  mark(server: string, dir: string) {
    if (!server || !dir) return
    intents.set(server, dir)
  },
  consume(server: string, dir: string) {
    const ok = intents.get(server) === dir
    intents.delete(server)
    return ok
  },
  clear(server: string) {
    intents.delete(server)
  },
}
