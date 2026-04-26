import type { UpdateAction, UpdateStatus } from "@/context/platform"

export type WebUpdate = {
  os: string
  currentVersion: string
  version: string
  updateAvailable: boolean
  downloaded: boolean
  status: "available" | "downloading" | "downloaded" | "installing" | "failed"
  updateError: string
  updateAction?: UpdateAction
  workDir: string
}

type Req = (path: string, init?: RequestInit) => Promise<Response>
type View = "up-to-date" | "available" | "downloading" | "downloaded" | "installing" | "failed"

export const action = (value: unknown): UpdateAction | undefined => {
  if (value === "recover" || value === "mirror") return value
  return
}

export const issue = (message: string, next?: UpdateAction) => {
  const err = new Error(message) as Error & { updateAction?: UpdateAction }
  err.updateAction = next
  return err
}

export const actionOf = (err: unknown, next?: UpdateAction) => {
  if (next) return next
  if (!(err instanceof Error)) return
  return action((err as Error & { updateAction?: unknown }).updateAction)
}

export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const viewOf = (data: Pick<UpdateStatus, "updateAvailable" | "status">): View => {
  if (!data.updateAvailable) return "up-to-date"
  if (data.status === "downloading") return "downloading"
  if (data.status === "downloaded") return "downloaded"
  if (data.status === "installing") return "installing"
  if (data.status === "failed") return "failed"
  return "available"
}

const cmp = (a: string, b: string) => {
  const norm = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((x) => Number.parseInt(x || "0", 10) || 0)
  const x = norm(a)
  const y = norm(b)
  const len = Math.max(x.length, y.length, 3)
  for (let i = 0; i < len; i++) {
    const p = x[i] ?? 0
    const q = y[i] ?? 0
    if (p < q) return -1
    if (p > q) return 1
  }
  return 0
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const statusOf = (value: unknown): WebUpdate["status"] => {
  if (value === "downloading") return "downloading"
  if (value === "downloaded") return "downloaded"
  if (value === "installing") return "installing"
  if (value === "failed") return "failed"
  return "available"
}

const post = async (req: Req, path: string, body: Record<string, unknown>) => {
  const res = await req(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.success) throw issue(data.error, action(data.action))
}

export const createWebUpdate = (req: Req, detectOS: () => string) => {
  const check = async (): Promise<WebUpdate> => {
    const os = detectOS()
    const res = await req(`/global/web-update/check?os=${os}`)
    const data = await res.json()
    if (typeof data.checkError === "string" && data.checkError) throw new Error(data.checkError)
    return {
      os,
      currentVersion: typeof data.currentVersion === "string" ? data.currentVersion.trim() : "",
      version: typeof data.remoteVersion === "string" ? data.remoteVersion.trim() : "",
      updateAvailable: !!data.updateAvailable,
      downloaded: !!data.downloaded,
      status: statusOf(data.status),
      updateError: typeof data.updateError === "string" ? data.updateError.trim() : "",
      updateAction: action(data.updateAction),
      workDir: typeof data.workDir === "string" ? data.workDir.trim() : "",
    }
  }

  const current = async () => {
    const data = await check()
    if (!data.updateAvailable) return
    return data
  }

  const waitFor = async (ver: string) => {
    let last: Error | undefined
    for (let i = 0; i < 45; i++) {
      const data = await check().catch((err) => {
        last = err instanceof Error ? err : new Error(String(err))
        return
      })
      if (data) {
        if (data.status === "failed") {
          throw issue(data.updateError || "Update failed", data.updateAction)
        }
        if (data.currentVersion && cmp(data.currentVersion, ver) >= 0) return
      }
      await wait(1000)
    }
    throw last ?? issue("Timed out while waiting for the update to finish")
  }

  const download = async (input: Pick<WebUpdate, "os" | "version">, force = false) => {
    await post(req, "/global/web-update/download", { os: input.os, version: input.version, force })
  }

  const install = async (input: Pick<WebUpdate, "os" | "version">) => {
    await post(req, "/global/web-update/install", { os: input.os, version: input.version })
  }

  const mirror = async (input: Pick<WebUpdate, "os" | "version">, mirrorRoot?: string) => {
    await post(req, "/global/web-update/mirror", { os: input.os, version: input.version, mirrorRoot })
  }

  const ready = async (force = false, error = "Update did not finish downloading") => {
    const data = await current()
    if (!data) return
    if (data.status === "failed") {
      throw issue(data.updateError || "Update needs to restart from scratch", data.updateAction)
    }
    if (!force && data.downloaded) return data
    await download(data, force)
    const next = await current()
    if (!next || next.status !== "downloaded") {
      throw issue(next?.updateError || error, next?.updateAction)
    }
    return next
  }

  const finish = async (data: Pick<WebUpdate, "os" | "version">) => {
    await install(data)
    await waitFor(data.version)
  }

  return {
    check,
    current,
    download,
    update: async () => {
      const data = await current()
      if (!data) return
      if (data.status === "failed") {
        if (data.updateAction === "mirror") return { kind: "mirror" as const }
        return { kind: "recover" as const }
      }
      const next = data.downloaded ? data : await ready()
      if (!next) return { kind: "done" as const }
      await finish(next)
      return { kind: "done" as const }
    },
    downloadUpdate: async () => {
      const data = await current()
      if (!data) return
      if (data.status === "failed") {
        throw issue(data.updateError || "Update needs to restart from scratch", data.updateAction)
      }
      await download(data)
    },
    recoverUpdate: async () => {
      const data = await current()
      if (!data) return
      await download(data, true)
      const next = await current()
      if (!next || next.status !== "downloaded") {
        throw issue(next?.updateError || "Update restart did not finish downloading", next?.updateAction)
      }
      await finish(next)
    },
    retryUpdateMirror: async (mirrorRoot?: string) => {
      const data = await current()
      if (!data) return
      if (data.status !== "failed" || data.updateAction !== "mirror") {
        throw issue(data.updateError || "Mirror retry is not available", data.updateAction)
      }
      await mirror(data, mirrorRoot)
      await waitFor(data.version)
    },
  }
}
