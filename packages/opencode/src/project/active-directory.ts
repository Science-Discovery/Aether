import { Filesystem } from "@/util/filesystem"

const subs = new Set<(directory: string | undefined) => void>()

let current: string | undefined

export const ActiveDirectory = {
  get() {
    return current
  },
  set(directory?: string) {
    const next = directory ? Filesystem.resolve(directory) : undefined
    if (next === current) return current
    current = next
    for (const sub of subs) sub(current)
    return current
  },
  subscribe(sub: (directory: string | undefined) => void) {
    subs.add(sub)
    return () => subs.delete(sub)
  },
}
