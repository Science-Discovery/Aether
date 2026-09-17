import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createResource, onCleanup } from "solid-js"
import type { GlobalSDKValue } from "@/context/global-sdk"

export function createModelsStatus(sdk: {
  client: Pick<OpencodeClient, "provider">
  event: Pick<GlobalSDKValue["event"], "listen">
}) {
  const [status, { refetch }] = createResource(() =>
    sdk.client.provider.models
      .status()
      .then((x) => x.data)
      .catch(() => undefined),
  )
  const [codex, { refetch: subscription }] = createResource(() =>
    sdk.client.provider.models.codex
      .status()
      .then((x) => x.data)
      .catch(() => undefined),
  )
  const refresh = () => {
    if (!status.loading) void refetch()
    if (!codex.loading) void subscription()
  }
  const unsub = sdk.event.listen((event) => {
    if (event.name !== "global") return
    if (event.details.type !== "provider.models.updated" && event.details.type !== "provider.updated") return
    refresh()
  })
  // Successful checks without catalog changes do not emit model update events.
  const timer = setInterval(refresh, 15_000)
  onCleanup(() => {
    clearInterval(timer)
    unsub()
  })
  return { status, codex }
}
