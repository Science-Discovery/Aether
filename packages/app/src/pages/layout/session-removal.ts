import type { Session } from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import { produce, type SetStoreFunction, type Store } from "solid-js/store"
import { dropSessionCaches, dropSessionStatus } from "@/context/global-sync/session-cache"
import { clearSessionPrefetch } from "@/context/global-sync/session-prefetch"
import type { State } from "@/context/global-sync/types"
import { collectSessionSubtree } from "@/utils/session-tree"

export async function remove(input: {
  session: Session
  store: Store<State>
  set: SetStoreFunction<State>
  current: () => string | undefined
  send: () => Promise<void>
  navigate: (id?: string) => void
  todo: (id: string) => void
}) {
  const snapshot = [...input.store.session, input.session]
  await input.send()
  const rows = [...new Map([...snapshot, ...input.store.session].map((session) => [session.id, session])).values()]
  const ids = new Set([input.session.id, ...collectSessionSubtree(rows, input.session.id).map((session) => session.id)])
  const active = input.store.session.filter((session) => !ids.has(session.id) && !session.time.archived)
  const parent = active.find((session) => session.id === input.session.parentID)
  const roots = active.filter((session) => !session.parentID)
  const next = parent ?? roots.find((session) => session.id > input.session.id) ?? roots.at(-1)
  const current = input.current()

  batch(() => {
    clearSessionPrefetch(input.session.directory, ids)
    ids.forEach(input.todo)
    input.set(
      produce((draft) => {
        draft.session = draft.session.filter((session) => !ids.has(session.id))
        dropSessionCaches(draft, ids)
        dropSessionStatus(draft, ids)
        ids.forEach((id) => delete draft.preference[id])
      }),
    )
  })
  if (current && ids.has(current)) input.navigate(next?.id)
}
