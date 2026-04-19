import { base64Encode } from "@opencode-ai/util/encode"
import type { SshLanding } from "@/utils/remote-ssh"

export function remoteHref(landing: SshLanding) {
  const slug = base64Encode(landing.directory || landing.rootDirectory)
  if (landing.sessionID) return `/${slug}/session/${landing.sessionID}`
  return `/${slug}/session`
}
