import { release } from "os"
import { which } from "../util/which"

export type Pick = {
  path: string | null
  unavailable?: boolean
  reason?: "missing_picker"
}

const script =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.ShowNewFolderButton = $true; $owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; $owner.WindowState = 'Minimized'; $owner.ShowInTaskbar = $false; $owner.Show(); $owner.Hide(); if ($d.ShowDialog($owner) -eq 'OK') { $d.SelectedPath }; $owner.Dispose()"

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

export function windows(find = which, env: NodeJS.ProcessEnv = process.env) {
  const shell = find("powershell.exe", env)
  if (!shell) return
  return [shell, "-NoProfile", "-NonInteractive", "-Command", script]
}

export function wsl(rel = release(), find = which, env: NodeJS.ProcessEnv = process.env) {
  if (!rel.toUpperCase().includes("WSL")) return
  return windows(find, env)
}

export function wslPath(input: string) {
  const path = input.trim().replaceAll("\\", "/")
  const match = path.match(/^([a-zA-Z]):(?:\/(.*))?$/)
  if (!match) return path
  const rest = match[2] ? `/${match[2]}` : ""
  return `/mnt/${match[1].toLowerCase()}${rest}`
}
