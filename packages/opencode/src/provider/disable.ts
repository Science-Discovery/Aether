export namespace ProviderDisable {
  export const defaults = new Set(["github-copilot"])

  export function set(ids?: string[]) {
    return new Set([...defaults, ...(ids ?? [])])
  }

  export function disabled(id: string, ids?: string[]) {
    return set(ids).has(id)
  }
}
