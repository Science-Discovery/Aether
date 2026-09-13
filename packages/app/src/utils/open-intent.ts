const intents = new Set<string>()

const key = (server: string, dir: string) => `${server}\n${dir}`

export const OpenIntent = {
  mark(server: string, dir: string) {
    if (!server || !dir) return
    intents.add(key(server, dir))
  },
  consume(server: string, dir: string) {
    const id = key(server, dir)
    const ok = intents.has(id)
    if (ok) intents.delete(id)
    return ok
  },
}
