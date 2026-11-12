import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSuperagentClient } from "./client"
import { useTaskPermissionCache } from "./permission-cache"

type PermissionRequest = { id: string; permission: string; patterns: string[] }
type TaskPermissions = {
  ticket: string; session: string; directory: string; title: string
  trusted: boolean; available: boolean; trustable: boolean; managed?: boolean; externalFull?: boolean; reason?: string; requests: PermissionRequest[]; error?: string
}

export function SuperagentPermissions(props: { enabled: boolean; stopped: string[] }) {
  const client = createSuperagentClient()
  const cache = useTaskPermissionCache()
  const dialog = useDialog()
  let trigger: HTMLButtonElement | undefined
  let content: HTMLElement | undefined
  let ownedDialog: string | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  const [state, set] = createStore({
    tickets: [] as TaskPermissions[], loaded: false, busy: false, error: "", connection: "", opened: false, expanded: false,
    confirm: undefined as { ticket: string; session: string; trusted: boolean } | undefined,
  })
  let revision = 0, reading = 0
  const disabled = () => !client.valid() || state.busy
  const canTrust = (ticket: TaskPermissions) => props.enabled && ticket.available && ticket.trustable && !!ticket.session && !props.stopped.includes(ticket.ticket)
  async function refresh(force = false) {
    if (!client.valid() || (!force && (reading || state.busy))) return
    const current = ++revision
    reading = current
    try {
      const result = await client.request<{ tickets: TaskPermissions[] }>("/native/permissions", {})
      if (current !== revision || !client.valid()) return
      set("tickets", reconcile(result.tickets, { key: "ticket" }))
      set({ loaded: true, connection: "" })
      if (state.confirm && !result.tickets.some((ticket) => ticket.ticket === state.confirm?.ticket && ticket.session === state.confirm.session && (state.confirm.trusted ? !ticket.trusted && canTrust(ticket) : ticket.trusted || ticket.managed))) set("confirm", undefined)
    } catch (error) { if (current === revision && client.valid()) set("connection", String(error)) }
    finally { if (reading === current) reading = 0 }
  }
  async function action(route: string, body: object) {
    if (disabled()) return
    ++revision // A permissions read started before this decision cannot undo its readback.
    set({ busy: true, error: "", confirm: undefined })
    // The confirmation button is removed by the state change above. Keep
    // keyboard input in our dialog rather than leaving focus on the body.
    queueMicrotask(() => {
      if (state.opened && ownedDialog === dialog.active?.id && content?.isConnected && document.activeElement === document.body)
        content.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('[data-slot="dialog-close-button"]')?.focus()
    })
    try { await client.request(route, body); await refresh(true) }
    catch (error) {
      if (client.valid()) { await refresh(true); if (client.valid()) set("error", String(error)) }
    } finally { if (client.valid()) set("busy", false) }
  }
  function trust(ticket: TaskPermissions) {
    if (disabled() || state.confirm?.ticket !== ticket.ticket || state.confirm.session !== ticket.session) return
    if (state.confirm.trusted && !canTrust(ticket)) return
    const finish = cache.begin(ticket)
    void action("/native/trust", { ticket: ticket.ticket, trusted: state.confirm.trusted, confirm: true }).finally(finish)
  }
  onMount(() => {
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 1500)
    onCleanup(() => { ++revision; clearInterval(timer) })
  })
  createEffect(() => { if (!client.valid() && ownedDialog === dialog.active?.id) dialog.close() })
  onCleanup(() => {
    if (focusTimer) clearTimeout(focusTimer)
    if (ownedDialog === dialog.active?.id) dialog.close()
  })
  const urgent = (ticket: TaskPermissions) => ticket.requests.length > 0 || ticket.trusted || !!ticket.managed
  const row = (ticket: TaskPermissions) => <article class="research-permission-task" data-testid="superagent-permission-task" data-ticket={ticket.ticket} data-trusted={ticket.trusted} hidden={!urgent(ticket) && !state.expanded && state.confirm?.ticket !== ticket.ticket}>
          <div class="research-permission-heading"><div><h3>{ticket.title}</h3><p>{ticket.trusted ? "此任务已信任 · 后续操作自动允许" : ticket.managed ? "任务信任状态待核对，可尝试撤销" : ticket.externalFull ? "此会话已由 Aether 设为完整权限（非此处管理）" : "此任务逐次审批"}</p></div>
            <Show when={ticket.trusted || ticket.managed} fallback={<Button size="small" variant="secondary" disabled={disabled() || !canTrust(ticket)} onClick={() => set("confirm", { ticket: ticket.ticket, session: ticket.session, trusted: true })} data-testid="superagent-trust">信任此任务…</Button>}>
              <Button size="small" variant="secondary" disabled={disabled()} onClick={() => set("confirm", { ticket: ticket.ticket, session: ticket.session, trusted: false })} data-testid="superagent-revoke-trust">撤销信任</Button>
            </Show>
          </div>
          <Show when={state.confirm?.ticket === ticket.ticket && state.confirm.session === ticket.session}>
            <div class="research-permission-confirm" role="group" aria-label={`${state.confirm?.trusted ? "确认信任任务" : "确认撤销信任"}：${ticket.title}`} data-testid="superagent-trust-confirmation">
              <Show when={state.confirm?.trusted} fallback={<><p>撤销“{ticket.title}”的信任并停止当前会话？将恢复逐次审批并中断正在执行的回合，确认停止后完成撤销，已有结果保留。</p><p>已启动的外部后台计算不保证停止；已执行的操作不会撤回。</p></>}>
                <p>确认信任“{ticket.title}”？将允许当前待审批操作，并自动允许此执行会话后续的命令执行和文件读写，不再逐次询问。</p>
                <p>只作用于此任务会话，其他任务不变。这不是操作系统沙箱；可随时撤销信任，已执行的操作不会撤回。</p>
              </Show>
              <div class="research-permission-actions"><Button size="small" variant="primary" disabled={disabled() || !!state.confirm?.trusted && !canTrust(ticket)} onClick={() => trust(ticket)} data-testid="superagent-trust-confirm">{state.confirm?.trusted ? "确认信任此任务" : "撤销信任并停止当前会话"}</Button><Button size="small" variant="ghost" disabled={state.busy} onClick={() => set("confirm", undefined)}>取消</Button></div>
            </div>
          </Show>
          <Show when={ticket.error}><p class="research-permission-error" role="status">{ticket.error}</p></Show>
          <Show when={!ticket.trusted && !canTrust(ticket)}><p class="research-muted">{ticket.reason || "此任务当前不能设为信任。已停止、未建立会话或 Super-agent 停用时不新增信任。"}</p></Show>
          <For each={ticket.requests}>{(request) => <div class="research-permission-request" data-testid="superagent-permission-request" data-request={request.id}>
            <strong>{request.permission}</strong><ul><For each={request.patterns}>{(pattern) => <li><code>{pattern}</code></li>}</For></ul>
            <Show when={!request.patterns.length}><p class="research-muted">此请求未提供匹配范围。</p></Show>
            <div class="research-permission-actions"><Button variant="secondary" size="small" disabled={disabled() || !ticket.available || props.stopped.includes(ticket.ticket)} onClick={() => void action("/native/permission", { ticket: ticket.ticket, request: request.id, reply: "once" })} data-testid="superagent-permission-once">允许一次</Button><Button variant="ghost" size="small" disabled={disabled() || !ticket.available} onClick={() => void action("/native/permission", { ticket: ticket.ticket, request: request.id, reply: "reject" })} data-testid="superagent-permission-reject">拒绝</Button></div>
          </div>}</For>
          <Show when={!ticket.requests.length}><p class="research-muted">暂无待审批请求。</p></Show>
        </article>
  const pending = () => state.tickets.reduce((sum, ticket) => sum + ticket.requests.length, 0)
  const unknown = () => !state.loaded || !!state.connection || state.tickets.some((ticket) => !ticket.available)
  function open() {
    if (state.opened || !client.valid()) return
    set({ opened: true, expanded: false })
    dialog.show(() => <Dialog title="任务权限审批" size="large">
      <section ref={content} class="research-permissions" data-testid="superagent-permissions" aria-label="任务权限审批">
        <p class="research-permissions-intro">可逐次决定，也可只信任某个任务的执行会话。其他任务的权限不变。</p>
        <Show when={state.error || state.connection || !client.valid()}><div class="research-error" role="alert">{state.error || state.connection || "后端已切换，请重新打开工作台。"}<Button variant="ghost" size="small" disabled={disabled()} onClick={() => void refresh()}>重新读取</Button></div></Show>
        <Show when={unknown()}><p class="research-muted" role="status">{state.loaded ? "部分权限状态尚未确认；以下保留最近读取结果。" : "权限状态尚未确认，正在读取…"}</p></Show>
        <Show when={state.loaded}>
          <Show when={state.tickets.length} fallback={<p class="research-muted">暂无执行任务。</p>}>
            <Show when={!unknown() && !pending()}><p class="research-muted">暂无待审批请求。仍可管理已信任任务或展开其他任务。</p></Show>
            <Show when={state.tickets.some((ticket) => !urgent(ticket))}>
              <Button variant="ghost" size="small" aria-expanded={state.expanded} onClick={() => set("expanded", !state.expanded)} data-testid="superagent-permission-other">{state.expanded ? "收起" : "查看"}其他任务权限（{state.tickets.filter((ticket) => !urgent(ticket)).length}）</Button>
            </Show>
            <div class="research-permission-list"><For each={state.tickets}>{row}</For></div>
          </Show>
        </Show>
      </section>
    </Dialog>, () => {
      set({ opened: false, confirm: undefined })
      ownedDialog = undefined
      focusTimer = setTimeout(() => { if (client.valid() && !dialog.active && trigger?.isConnected) trigger.focus() }, 120)
    })
    ownedDialog = dialog.active?.id
  }
  return <Button ref={trigger} variant="secondary" size="small" disabled={!client.valid()} aria-haspopup="dialog" aria-expanded={state.opened}
    data-testid="superagent-permissions-trigger" data-unknown={unknown()} data-pending={pending() > 0} onClick={open}>
    {unknown() ? pending() ? `审批 ${pending()}+ · 状态未知` : "任务权限 · 状态未知" : pending() ? `审批 ${pending()}` : "任务权限"}
  </Button>
}
