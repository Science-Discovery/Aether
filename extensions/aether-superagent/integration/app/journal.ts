type Pending = { target: string; text: string; key: string }

export class Journal {
  private entries = new Map<string, Pending>()
  constructor(private namespace: string, private storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage) {
    try {
      const values: unknown = JSON.parse(storage.getItem(namespace) ?? "[]")
      if (Array.isArray(values)) for (const value of values)
        if (value && [value.target, value.text, value.key].every((x) => typeof x === "string")) this.entries.set(value.target, value)
    } catch {}
  }
  all() { return [...this.entries.values()] }
  get(target: string) { return this.entries.get(target) }
  claim(target: string, text: string) {
    const previous = this.get(target)
    if (previous && previous.text !== text) throw new Error("该对话上次发送尚未确认。请保留原文重试，或先核对任务记录。")
    if (previous) return previous
    const value = { target, text, key: crypto.randomUUID() }
    this.entries.set(target, value)
    try { this.persist() }
    catch (error) { this.entries.delete(target); throw error }
    return value
  }
  accepted(target: string, key: string) {
    const previous = this.get(target)
    if (previous?.key !== key) return
    this.entries.delete(target)
    try { this.persist() }
    catch (error) { this.entries.set(target, previous); throw error }
  }
  private persist() { this.storage.setItem(this.namespace, JSON.stringify(this.all())) }
}
