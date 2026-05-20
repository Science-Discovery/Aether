const ranked = ["tatu-maas", "opencode", "opencode-go", "openai", "github-copilot", "anthropic", "google"]

export function rank(id: string) {
  const index = ranked.indexOf(id)
  return index >= 0 ? index : ranked.length
}
