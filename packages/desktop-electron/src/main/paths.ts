import { app } from "electron"
import { join } from "node:path"
import { CHANNEL } from "./constants"

const APP_NAMES: Record<string, string> = {
  dev: "Aether Desktop Dev",
  beta: "Aether Desktop Beta",
  prod: "Aether Desktop",
}

const APP_IDS: Record<string, string> = {
  dev: "ai.aether.desktop.dev",
  beta: "ai.aether.desktop.beta",
  prod: "ai.aether.desktop",
}

const LEGACY_APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

function id(input: Record<string, string>) {
  return app.isPackaged ? input[CHANNEL] : input.dev
}

export function userDataDir() {
  return join(app.getPath("appData"), id(APP_IDS))
}

export function legacyUserDataDir() {
  return join(app.getPath("appData"), id(LEGACY_APP_IDS))
}

app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : APP_NAMES.dev)
app.setPath("userData", userDataDir())
