import type { GlobalSDKValue } from "@/context/global-sdk"

type Client = GlobalSDKValue["client"]
type File = { mime: string }
type Input = { image: boolean; pdf: boolean }

let decision: "ask" | "started" | "declined" = "ask"

export function needsMineru(input: Input | undefined, files: File[]) {
  if (!input) return files.some((file) => file.mime === "application/pdf" || file.mime.startsWith("image/"))
  return files.some((file) => {
    if (file.mime === "application/pdf") return !input.pdf
    if (file.mime.startsWith("image/")) return !input.image
    return false
  })
}

export async function ensureManagedMineru(input: { client: Client; prompt: boolean; confirm: () => Promise<boolean> }) {
  const result = await input.client.global.mineruManagedStatus({ throwOnError: true }).then((item) => item.data!)
  if (result.run === "running") {
    decision = "started"
    return true
  }
  if (decision === "declined") return false
  if (result.install !== "ready") return false
  if (decision === "ask" && input.prompt && !(await input.confirm())) {
    decision = "declined"
    return false
  }
  await input.client.global.mineruManagedStart({ throwOnError: true })
  decision = "started"
  return true
}

export const MineruManagedTest = {
  reset() {
    decision = "ask"
  },
}
