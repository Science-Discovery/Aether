import { useLocation, useNavigate } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useTaskPermissionCache } from "./permission-cache"

export function SuperagentEntry() {
  useTaskPermissionCache(true)
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <Tooltip placement="right" value="研究工作台 · Super-agent">
      <IconButton icon="task" variant="ghost" size="large" aria-label="研究工作台 · Super-agent"
        data-testid="superagent-entry" data-selected={location.pathname.replace(/\/+$/, "").endsWith("/superagent")}
        onClick={() => navigate("/superagent")} />
    </Tooltip>
  )
}
