import { app } from "electron"
import { join } from "node:path"
import { CHANNEL } from "./constants"

const APP_NAMES: Record<string, string> = {
  dev: "Aether Desktop Dev",
  beta: "Aether Desktop Beta",
  prod: "Aether Desktop",
}

function home() {
  return process.env.OPENCODE_TEST_HOME || app.getPath("home")
}

export function userDataDir() {
  return join(aetherDataDir(), "desktop")
}

export function aetherDataDir() {
  const root = process.env.XDG_DATA_HOME || join(home(), ".local", "share")
  return join(root, "aether")
}

app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : APP_NAMES.dev)
app.setPath("userData", userDataDir())
app.setAppLogsPath(join(userDataDir(), "logs"))
