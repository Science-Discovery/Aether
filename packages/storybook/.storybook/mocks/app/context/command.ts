const keybinds: Record<string, string> = {
  "file.attach": "mod+u",
  "prompt.mode.shell": "mod+shift+x",
  "prompt.mode.normal": "mod+shift+e",
  "permissions.autoaccept": "mod+shift+a",
  "agent.cycle": "mod+.",
  "model.choose": "mod+m",
  "model.variant.cycle": "mod+shift+m",
}

export function useCommand() {
  return {
    options: [],
    register() {
      return () => undefined
    },
    trigger() {},
    keybind(id: string) {
      return keybinds[id]
    },
  }
}

export function parseKeybind(config: string) {
  if (!config || config === "none") return []
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
  return config.split(",").map((combo: string) => {
    const parts = combo.trim().toLowerCase().split("+")
    const kb: Record<string, unknown> = { key: "", ctrl: false, meta: false, shift: false, alt: false }
    for (const part of parts) {
      if (part === "ctrl" || part === "control") kb.ctrl = true
      else if (part === "meta" || part === "cmd" || part === "command") kb.meta = true
      else if (part === "mod") {
        if (isMac) kb.meta = true
        else kb.ctrl = true
      } else if (part === "shift") kb.shift = true
      else if (part === "alt" || part === "option") kb.alt = true
      else kb.key = part
    }
    return kb
  })
}
