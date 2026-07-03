import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { sessionKeyForServer, useLayout } from "@/context/layout"
import { useServer } from "@/context/server"

export const useSessionKey = () => {
  const params = useParams()
  const server = useServer()
  const sessionKey = createMemo(() => sessionKeyForServer(params.dir, params.id, server.key))
  return { params, sessionKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey } = useSessionKey()
  return {
    params,
    sessionKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
