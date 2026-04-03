import { which } from "../util/which"

export type Pick = {
  path: string | null
  unavailable?: boolean
  reason?: "missing_picker"
}

export function missing(): Pick {
  return {
    path: null,
    unavailable: true,
    reason: "missing_picker",
  }
}

export function linux(env: NodeJS.ProcessEnv = process.env, find = which) {
  const zenity = find("zenity", env)
  if (zenity) return [zenity, "--file-selection", "--directory", "--title=Select Folder"]

  const kdialog = find("kdialog", env)
  if (kdialog) return [kdialog, "--getexistingdirectory", env.HOME || "/"]
}
