import { onCleanup, onMount } from "solid-js"
import { reconcile } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { createSuperagentClient } from "./client"

type Task = { session: string; directory: string; available: boolean; managed?: boolean; trusted: boolean }
// All add-on views on this backend share one read barrier. A late bootstrap
// must not overwrite an SSE preference update or a grant/revoke in progress.
const barriers = new WeakMap<object, { revision: number; changing: number; refresh: Set<() => void> }>()

export function useTaskPermissionCache(bootstrap = false) {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
  const client = createSuperagentClient()
  let barrier = barriers.get(sdk)
  if (!barrier) { barrier = { revision: 0, changing: 0, refresh: new Set() }; barriers.set(sdk, barrier) }
  const state = barrier
  let reading = false
  let timer: ReturnType<typeof setTimeout> | undefined
  function schedule() {
    if (!bootstrap || !client.valid() || timer) return
    timer = setTimeout(() => { timer = undefined; void refresh() }, 200)
  }
  const unsubscribe = sdk.event.listen((event) => {
    if (String(event.details?.type) !== "session.preference.updated") return
    ++state.revision
    schedule()
  })
  onCleanup(() => { unsubscribe(); if (timer) clearTimeout(timer) })

  async function refresh() {
    if (!client.valid() || reading) return
    if (state.changing) { schedule(); return }
    reading = true
    const revision = state.revision
    const current = () => client.valid() && !state.changing && revision === state.revision
    try {
      const result = await client.request<{ tickets: Task[] }>("/native/permissions", {})
      if (!current()) return
      // Include revoked tasks: a missed "off" event must clear an older full
      // cache even though the coordinator no longer marks the grant managed.
      await Promise.all(result.tickets.filter((task) => task.available).map(async (task) => {
        // Existing background sessions do not emit session.created on reload.
        // Create their cache before the read so subsequent SSE is retained.
        const [, set] = sync.child(task.directory, { bootstrap: false })
        try {
          const response = await sdk.createClient({ directory: task.directory, throwOnError: true })
            .session.preference.get({ sessionID: task.session })
          if (!current()) return
          const preference = response.data
          if (!preference) { set("preference", task.session, undefined!); return }
          if (preference.sessionID !== task.session) return
          // This cache also drives native auto-response, not just notification
          // styling. Never restore full for an unconfirmed/revoking grant.
          const mode = preference.mode ?? (preference.autoAccept ? "full" : "off")
          if (mode === "full" && !task.trusted) {
            // Hold native frontend auto-response while our grant is being
            // revoked or cannot be confirmed; leave external full grants alone.
            if (task.managed) set("preference", task.session, { ...preference, variant: preference.variant ?? undefined, mode: "off", autoAccept: false })
            return
          }
          set("preference", task.session, reconcile({ ...preference, variant: preference.variant ?? undefined }))
        } catch { /* Unknown remains unknown; never grant from a failed read. */ }
      }))
    } catch { /* An unavailable/uninstalled add-on must not alter native policy. */ }
    finally {
      reading = false
      if (revision !== state.revision) schedule()
    }
  }

  if (bootstrap) {
    state.refresh.add(schedule)
    onCleanup(() => state.refresh.delete(schedule))
    onMount(() => { void refresh() })
    onCleanup(sync.onReconnect(() => { ++state.revision; schedule() }))
  }
  return {
    begin(task: Pick<Task, "session" | "directory">) {
      // The native reducer drops preference events for uncached directories.
      // Prepare the exact worker before asking the coordinator to change it.
      sync.child(task.directory, { bootstrap: false })
      ++state.revision
      ++state.changing
      let finished = false
      return () => {
        if (finished) return
        finished = true
        --state.changing
        ++state.revision
        for (const refresh of state.refresh) refresh()
      }
    },
  }
}
