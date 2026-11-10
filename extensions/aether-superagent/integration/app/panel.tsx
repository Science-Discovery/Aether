import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Title } from "@solidjs/meta"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { createSuperagentClient, type NativeState } from "./client"
import { SuperagentPermissions } from "./permissions"
import "./styles.css"

type Research = {
  objective: string; stage: string; summary: string; next: string; blockers: string[]
  milestones: { id: string; title: string; state: string }[]; evidence: { label: string; path: string }[]
  updated: number; revision: number; input: string | null
}
type Ticket = { id: string; title: string; directory: string; session: string; state: string; result: string; research?: Research }
type Input = { id: string; key: string; mode: string; ticket: string | null; text: string; result: string; state: string }
type Event = { id: number; ticket: string; input: string | null; kind: string; at: number; research: Research }
type Snapshot = { native: NativeState; tickets: Ticket[]; inputs: Input[]; events: Event[]; config: { repo: string; aether: string; workers: number } }
const stages: Record<string, string> = { planning: "规划路径", research: "文献与调研", deriving: "推导中", computing: "计算中", verifying: "验证中", blocked: "需要关注", review: "待验收" }
const execution: Record<string, string> = { queued: "等待执行", running: "执行中", waiting: "本轮已结束", attention: "执行待核对", stopped: "已停止" }
const filters = [{ id: "all", name: "全部课题" }, { id: "active", name: "推进中" }, { id: "attention", name: "需要关注" }, { id: "review", name: "待验收" }]
const attention = (ticket: Ticket) => ticket.state !== "stopped" && (ticket.research?.stage === "blocked" || ticket.state === "attention")
const stamp = (time?: number) => time ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""

export default function SuperagentPanel() {
  const client = createSuperagentClient()
  const { valid, request } = client
  const [state, set] = createStore({
    snapshot: undefined as Snapshot | undefined, selected: "", filter: "all",
    error: "", connection: "", busy: false, polling: false, received: 0,
  })
  const tickets = () => state.snapshot?.tickets ?? []
  const notices = () => state.snapshot?.native?.outbox?.filter((notice) => ["unknown", "failed"].includes(notice.state)) ?? []
  const selected = createMemo(() => tickets().find((ticket) => ticket.id === state.selected))
  const visible = createMemo(() => tickets().filter((ticket) => {
    if (state.filter === "attention") return attention(ticket)
    if (state.filter === "review") return ticket.research?.stage === "review" && ticket.state !== "stopped"
    if (state.filter === "active") return ticket.state !== "stopped" && !attention(ticket) && ticket.research?.stage !== "review"
    return true
  }).slice().sort((a, b) => Number(attention(b)) - Number(attention(a)) || (b.research?.updated ?? 0) - (a.research?.updated ?? 0)))
  const events = createMemo(() => (state.snapshot?.events ?? []).filter((event) => ["created", "progress", "stopped"].includes(event.kind) && (!state.selected || event.ticket === state.selected)).slice(-6).reverse())
  async function refresh() {
    if (!valid() || state.polling) return
    set("polling", true)
    try {
      const snapshot = await request<Snapshot>("/panel/state")
      set("snapshot", reconcile(snapshot))
      set("connection", ""); set("received", Date.now())
    } catch (error) { if (valid()) set("connection", String(error)) }
    finally { if (valid()) set("polling", false) }
  }
  async function action(route: string, body = {}) {
    if (state.busy || !valid()) return
    set("busy", true); set("error", "")
    try { await request(route, body); await refresh() }
    catch (error) { if (valid()) set("error", String(error)) }
    finally { if (valid()) set("busy", false) }
  }
  async function open(ticket?: Ticket) {
    if (state.busy || !valid()) return
    set("busy", true); set("error", "")
    try {
      const target = await request<{ directory: string; session: string }>(ticket ? `/tickets/${ticket.id}/open` : "/native/open", ticket ? undefined : {})
      client.open(target)
    } catch (error) { if (valid()) set("error", String(error)) }
    finally { if (valid()) set("busy", false) }
  }
  onMount(() => {
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 1500)
    onCleanup(() => clearInterval(timer))
  })
  const status = (ticket: Ticket) => ticket.state === "stopped" ? "已停止" : stages[ticket.research?.stage ?? "planning"] ?? "规划路径"
  return (
    <div class="research-workbench" data-testid="superagent-panel">
      <Title>研究工作台 · Aether</Title>
      <div class="research-topbar"><span><Icon name="task" /> Super-agent <span class="research-slash">/</span> 研究工作台</span>
        <span class="research-connection" data-offline={!!state.connection}><i />{state.connection ? "连接中断" : state.received ? "进展同步中" : "正在连接"}</span>
      </div>
      <div class="research-scroll">
        <div class="research-page">
          <header class="research-heading">
            <div><p class="research-eyebrow">RESEARCH WORKSPACE</p><h1>把研究向前推进。</h1><p>你来决定方向，Super-agent 负责安排执行、续接课题与汇报进展。</p></div>
            <div class="research-count"><strong>{tickets().filter((ticket) => ticket.state !== "stopped").length}</strong><span>个研究课题</span></div>
          </header>
          <Show when={state.connection || state.error || !valid()}><div class="research-error" role="alert">{state.error || state.connection || "后端已切换，请重新打开工作台。"}<Button size="small" variant="ghost" onClick={() => void refresh()}>重新连接</Button></div></Show>
          <div class="research-layout">
            <div class="research-main">
              <section class="research-controller" data-testid="superagent-controller">
                <div><h2>主控会话</h2><p>在原生会话中讨论目标、安排工作、回答待决问题。这里跟踪课题进展。</p></div>
                <div class="research-controller-actions">
                  <SuperagentPermissions enabled={!!state.snapshot?.native?.enabled} stopped={tickets().filter((ticket) => ticket.state === "stopped").map((ticket) => ticket.id)} />
                  <Button variant="primary" disabled={!valid() || state.busy || !state.snapshot?.native?.installed || !state.snapshot.native.enabled} onClick={() => void open()} data-testid="superagent-master">打开主控会话 ↗</Button>
                </div>
              </section>
              <Show when={state.snapshot?.native && !state.snapshot.native.enabled}><p class="research-note" role="status" data-testid="superagent-disabled">Super-agent 已停用，不再调度新工作。已有任务仍可回收结果，课题记录继续保留。可在 Aether 设置中重新启用。</p></Show>
              <Show when={notices().length}><section class="research-blockers" data-testid="superagent-notification-errors" aria-live="polite">
                <strong>主控汇报需要关注</strong><p>研究记录已保留。请打开主控会话核对，系统不会因汇报异常自动重派任务。</p>
                <For each={notices()}>{(notice) => <p data-state={notice.state}>{notice.ticket ? tickets().find((ticket) => ticket.id === notice.ticket)?.title ?? "研究课题" : "定时检查"}：{notice.state === "failed" ? "主控汇报失败" : "主控汇报待核对"}</p>}</For>
              </section></Show>
              <nav class="research-filters" aria-label="课题筛选"><For each={filters}>{(filter) => <Button variant="ghost" data-selected={state.filter === filter.id} aria-pressed={state.filter === filter.id} onClick={() => set("filter", filter.id)}>{filter.name}<Show when={filter.id === "attention" && tickets().some(attention)}><span class="research-attention-count">{tickets().filter(attention).length}</span></Show></Button>}</For></nav>
              <Show when={visible().length} fallback={<div class="research-empty"><span class="research-empty-icon"><Icon name="task" /></span><h2>{tickets().length ? "这里暂时没有课题" : "从一个值得研究的问题开始"}</h2><p>{tickets().length ? "切换筛选，查看其他课题的进展。" : "打开主控会话交代研究目标；这里会呈现研究路径、阶段成果和待决问题。"}</p></div>}>
                <div class="research-grid"><For each={visible()}>{(ticket) => <article class="research-card" data-selected={state.selected === ticket.id} data-attention={attention(ticket)}>
                  <div class="research-card-top"><span class="research-stage" data-stage={ticket.research?.stage}>{status(ticket)}</span><span class="research-time">{stamp(ticket.research?.updated)}</span></div>
                  <button class="research-card-title" onClick={() => set("selected", ticket.id)} data-testid="superagent-ticket" aria-pressed={state.selected === ticket.id}>{ticket.title}<span aria-hidden="true">↗</span></button>
                  <p class="research-summary" data-testid="superagent-summary">{ticket.research?.summary || "尚未收到执行 agent 的进展报告。"}</p>
                  <Show when={ticket.research?.milestones.length}><div class="research-steps" aria-label="里程碑进度"><For each={ticket.research?.milestones}>{(milestone) => <span data-state={milestone.state} title={milestone.title} />}</For></div></Show>
                  <div class="research-card-footer"><span>{ticket.research?.milestones.length ? `${ticket.research.milestones.filter((milestone) => milestone.state === "done").length} / ${ticket.research.milestones.length} 里程碑` : "等待研究计划"}</span><span class="research-execution" data-running={ticket.state === "running"}><i />{execution[ticket.state] ?? ticket.state}</span></div>
                  <Show when={ticket.research?.next}><div class="research-next"><span>下一步</span>{ticket.research?.next}</div></Show>
                </article>}</For></div>
              </Show>
            </div>
            <aside class="research-aside">
              <Show when={selected()} fallback={<section class="research-brief research-welcome"><p class="research-eyebrow">研究概览</p><h2>{tickets().some(attention) ? "有课题需要关注" : "把精力留给关键判断"}</h2><p>{tickets().some(attention) ? "选择课题查看当前阻碍，然后在主控会话中讨论下一步。" : "选择一项课题，查看里程碑、证据和下一步。执行记录随时可以在原会话中展开。"}</p><div class="research-note">阶段与里程碑来自执行 agent 的报告；“待验收”表示已有结果和证据，仍需要核对。</div></section>}>
                {(ticket) => <section class="research-brief" data-testid="superagent-brief"><div class="research-section-heading"><p class="research-eyebrow">课题简报</p><Button variant="ghost" size="small" aria-label="取消关注课题" onClick={() => set("selected", "")}>×</Button></div><h2>{ticket().title}</h2><p>{ticket().research?.objective}</p>
                  <Show when={ticket().research?.summary}><h3>当前进展</h3><p class="research-full-summary">{ticket().research?.summary}</p></Show>
                  <Show when={ticket().research?.next}><h3>下一步</h3><p>{ticket().research?.next}</p></Show>
                  <Show when={ticket().research?.blockers.length}><div class="research-blockers"><strong>待决事项</strong><For each={ticket().research?.blockers}>{(blocker) => <p>{blocker}</p>}</For></div></Show>
                  <Show when={ticket().research?.milestones.length}><h3>研究路径</h3><ol class="research-milestones" data-testid="superagent-milestones"><For each={ticket().research?.milestones}>{(milestone) => <li data-state={milestone.state}><span aria-label={milestone.state === "done" ? "已完成" : milestone.state === "active" ? "进行中" : "待开展"}>{milestone.state === "done" ? "✓" : ""}</span><div><span class="sr-only">{milestone.state === "done" ? "已完成：" : milestone.state === "active" ? "进行中：" : "待开展："}</span>{milestone.title}<Show when={milestone.state === "active"}><small>正在推进</small></Show></div></li>}</For></ol></Show>
                  <Show when={ticket().research?.evidence.length}><h3>成果与证据</h3><ul class="research-evidence"><For each={ticket().research?.evidence}>{(item) => <li><span>{item.label}</span><code>{item.path}</code></li>}</For></ul></Show>
                  <div class="research-brief-actions"><Button variant="secondary" size="small" disabled={state.busy || !valid()} onClick={() => void open(ticket())} data-testid="superagent-open">查看执行会话 ↗</Button><Show when={ticket().state !== "stopped"}><Button variant="ghost" size="small" disabled={state.busy || !valid()} onClick={() => { if (confirm("停止这个课题的后续执行？已有成果会保留。")) void action(`/tickets/${ticket().id}/stop`) }}>停止</Button></Show></div>
                </section>}
              </Show>
              <section class="research-activity" data-testid="superagent-activity"><div class="research-section-heading"><h2>最近进展</h2><span>{state.selected ? "当前课题" : "所有课题"}</span></div><Show when={events().length} fallback={<p class="research-muted">新的研究进展会出现在这里。</p>}><ol><For each={events()}>{(event) => <li><i /><div><time>{stamp(event.at)}</time><strong>{tickets().find((ticket) => ticket.id === event.ticket)?.title ?? "研究课题"}</strong><p>{event.kind === "created" ? "课题已建立，正在安排研究工作。" : event.kind === "stopped" ? "已停止执行，保留既有成果。" : event.research.summary || stages[event.research.stage] || "进展已更新"}</p></div></li>}</For></ol></Show></section>
              <Show when={state.snapshot?.inputs.some((input) => input.state === "uncertain")}><section class="research-brief"><h3>投递待核对</h3><For each={state.snapshot?.inputs.filter((input) => input.state === "uncertain")}>{(input) => <div class="research-pending"><p>{input.text.slice(0, 120)}</p><Button size="small" variant="secondary" disabled={state.busy || !valid()} onClick={() => void action(`/inputs/${input.id}/reconcile`)}>核对执行结果</Button><Button size="small" variant="ghost" disabled={state.busy || !valid()} onClick={() => { if (confirm("已检查执行会话？放弃只解除等待，不会撤销已执行的操作。")) void action(`/inputs/${input.id}/dismiss`, { confirm: true }) }}>放弃</Button></div>}</For></section></Show>
              <details class="research-settings"><summary>运行设置</summary><p>仓库：{state.snapshot?.config.repo ?? "连接中"}</p><p>并发执行：{state.snapshot?.config.workers ?? "—"}</p><p>启用与定时检查可在 Aether 设置的 Super-agent 页面调整。</p></details>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
