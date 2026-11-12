import { Aether } from "./aether"
import type { Engine } from "./engine"
import type { Ticket } from "./store"
import { LifecycleError } from "./lifecycle"

type Rule = { permission: string; pattern: string; action: string }
type Preference = { mode?: string; autoAccept?: boolean }
type Pending = { id: string; sessionID: string; permission: string; patterns: string[] }
type Journal = { session: string; directory: string; phase: "granting" | "trusted" | "revoking" | "revoked"; rules: Rule[]; mode?: string }
const full: Rule[] = [{ permission: "*", pattern: "*", action: "allow" }]
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const conflict = (message: string): never => { throw new LifecycleError(message) }

/** Session-scoped grants. Never uses project-wide `always` approvals. */
export class TaskPermissions {
  private locks = new Map<string, Promise<unknown>>()
  private reader: Aether
  constructor(readonly engine: Engine) {
    this.reader = new Aether(engine.aether.url, engine.aether.authorization, 8000)
  }
  private key(id: string) { return `permission:task:${id}` }
  private journal(ticket: Ticket): Journal | undefined {
    const text = this.engine.store.setting(this.key(ticket.id))
    if (!text) return
    let value: Journal
    try { value = JSON.parse(text) as Journal } catch { return conflict("任务授权记录损坏，已暂停自动审批。") }
    if (!value || !["granting", "trusted", "revoking", "revoked"].includes(value.phase) ||
      !Array.isArray(value.rules) || value.rules.length !== 0 || (value.mode !== undefined && value.mode !== "off"))
      return conflict("任务授权记录无效，已暂停自动审批。")
    if (value.session !== ticket.session || value.directory !== ticket.directory) conflict("授权记录与工单会话不匹配。")
    return value
  }
  private save(ticket: Ticket, journal: Journal) { this.engine.store.setting(this.key(ticket.id), JSON.stringify(journal)) }
  private ticket(id: unknown) {
    if (typeof id !== "string") return conflict("需要工单 ID。")
    const ticket = this.engine.store.ticket(id)
    if (!ticket) return conflict("工单不存在。")
    return ticket
  }
  private enabled(ticket: Ticket) {
    const settings = JSON.parse(this.engine.store.setting("native:settings") ?? "{}")
    if (settings.enabled === false || this.engine.store.setting("native:uninstalled") === "true" || this.engine.closed || ticket.state === "stopped")
      conflict("停用、卸载或已停止的任务不能新增授权。")
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id)
    const next = (async () => { await previous?.catch(() => {}); return action() })()
    this.locks.set(id, next)
    try { return await next } finally { if (this.locks.get(id) === next) this.locks.delete(id) }
  }
  private async remote(ticket: Ticket) {
    const session = await this.reader.request<{ id: string; directory: string; engine?: unknown; permission?: Rule[] }>(ticket.directory, `/session/${ticket.session}`)
    if (session.id !== ticket.session || session.directory !== ticket.directory || session.engine) conflict("Aether 会话身份或引擎与工单不匹配。")
    const pref = await this.reader.request<Preference | null>(ticket.directory, `/session/${ticket.session}/preference`)
    return { rules: session.permission ?? [], mode: pref?.mode ?? (pref?.autoAccept ? "full" : undefined) }
  }
  private async pending(ticket: Ticket) {
    const requests = await this.reader.request<Pending[]>(ticket.directory, "/permission")
    return requests.filter((item) => item.sessionID === ticket.session)
  }
  private owned(journal: Journal | undefined) { return journal && journal.phase !== "revoked" }
  private matches(remote: { rules: Rule[]; mode?: string }) { return equal(remote.rules, full) && (remote.mode === "full" || remote.mode === undefined) }
  private async item(ticket: Ticket) {
    const remote = await this.remote(ticket)
    const journal = this.journal(ticket)
    const managed = !!this.owned(journal)
    const trusted = managed && journal?.phase !== "revoking" && this.matches(remote)
    const trustable = !managed && remote.rules.length === 0 && (!remote.mode || remote.mode === "off")
    return { ticket: ticket.id, session: ticket.session, directory: ticket.directory, title: ticket.title,
      available: true, managed, trusted, trustable, externalFull: !managed && this.matches(remote),
      ...(!trustable && !trusted ? { reason: managed ? "授权状态需恢复或原生权限已变更；不会覆盖手动设置。" : "当前策略不是默认逐项确认；请在原会话调整。" } : {}),
      requests: (await this.pending(ticket)).map(({ id, permission, patterns }) => ({ id, permission, patterns })) }
  }
  async list() {
    return { tickets: await Promise.all(this.engine.store.tickets().map(async (ticket) => {
      try { return await this.item(ticket) } catch {
        return { ticket: ticket.id, session: ticket.session, directory: ticket.directory, title: ticket.title,
          trusted: false, managed: !!this.engine.store.setting(this.key(ticket.id)), trustable: false, available: false, requests: [], error: "无法确认 Aether 会话权限，请检查连接。" }
      }
    })) }
  }
  async reply(id: unknown, request: unknown, reply: unknown) {
    const ticket = this.ticket(id)
    if (typeof request !== "string" || !["once", "reject"].includes(String(reply))) conflict("仅支持本次允许或拒绝。")
    return this.serial(ticket.id, async () => {
      const check = () => {
        if (reply === "once" && (this.engine.closed || this.ticket(ticket.id).state === "stopped"))
          conflict("已停止的任务不能继续批准执行。")
      }
      check()
      await this.remote(ticket)
      if (!(await this.pending(ticket)).some((item) => item.id === request)) conflict("该请求已处理或不属于此工单。")
      check()
      await this.reader.request(ticket.directory, `/permission/${encodeURIComponent(request as string)}/reply`, { reply })
      if ((await this.pending(ticket)).some((item) => item.id === request)) conflict("尚未确认权限审批已生效，请刷新状态。")
      return this.item(ticket)
    })
  }
  private async sweep(ticket: Ticket) {
    for (const request of await this.pending(ticket)) {
      const live = this.engine.store.ticket(ticket.id)
      if (!live || live.state === "stopped" || this.engine.closed) return
      const journal = this.journal(ticket)
      if (journal?.phase !== "trusted" || !this.matches(await this.remote(ticket))) return
      if (this.engine.store.ticket(ticket.id)?.state === "stopped" || this.engine.closed) return
      // A reply consumes exactly this request. A transport failure is surfaced;
      // future polls re-read pending IDs, never replay a model request.
      await this.reader.request(ticket.directory, `/permission/${encodeURIComponent(request.id)}/reply`, { reply: "once" })
    }
  }
  private async revoke(ticket: Ticket, journal: Journal) {
    journal.phase = "revoking"; this.save(ticket, journal)
    let remote = await this.remote(ticket)
    const original = equal(remote.rules, journal.rules) && (!remote.mode || remote.mode === "off")
    if (!original && !this.matches(remote)) conflict("原生权限已被手动修改，拒绝覆盖；请在原会话恢复逐项确认后再次撤销。")
    // Tighten future turns first; then abort the old turn whose tool
    // closures may still retain full permissions from its start.
    if (!original) {
      await this.reader.request(ticket.directory, `/session/${ticket.session}/preference`, { mode: "off" }, "PATCH")
      remote = await this.remote(ticket)
      if (!equal(remote.rules, journal.rules) || (remote.mode && remote.mode !== "off")) conflict("尚未确认撤销生效，请刷新后重试。")
    }
    if (await this.reader.status(ticket.directory, ticket.session) !== "idle") {
      await this.reader.abort(ticket.directory, ticket.session)
      if (await this.reader.status(ticket.directory, ticket.session) !== "idle")
        conflict("权限已恢复但会话尚未停止，保留撤销记录；请重试。")
    }
    remote = await this.remote(ticket)
    if (!equal(remote.rules, journal.rules) || (remote.mode && remote.mode !== "off")) conflict("最终读回未确认撤销，保留恢复记录。")
    journal.phase = "revoked"; this.save(ticket, journal)
  }
  private async stopped(ticket: Ticket, journal: Journal) {
    if (this.engine.store.ticket(ticket.id)?.state !== "stopped") return false
    await this.revoke(ticket, journal)
    return true
  }
  async trust(id: unknown, trusted: unknown, confirm: unknown) {
    const ticket = this.ticket(id)
    if (typeof trusted !== "boolean" || confirm !== true) conflict("本任务授权或撤销需要明确确认。")
    return this.serial(ticket.id, async () => {
      let journal = this.journal(ticket)
      let remote = await this.remote(ticket)
      if (trusted) {
        this.enabled(this.ticket(ticket.id))
        if (this.owned(journal)) {
          if (journal?.phase === "revoking" || !this.matches(remote)) conflict("权限与授权记录不一致，请先恢复；不会覆盖手动策略。")
        } else {
          if (remote.rules.length || (remote.mode && remote.mode !== "off")) conflict("当前策略不是默认逐项确认，不能安全恢复；请使用原会话权限设置。")
          journal = { session: ticket.session, directory: ticket.directory, phase: "granting", rules: remote.rules, mode: remote.mode }
          this.save(ticket, journal)
          try {
            await this.reader.request(ticket.directory, `/session/${ticket.session}/preference`, { mode: "full" }, "PATCH")
          } catch (error) {
            await this.stopped(ticket, journal).catch(() => {})
            throw error
          }
          remote = await this.remote(ticket)
          if (!this.matches(remote)) conflict("尚未确认授权生效，请刷新后恢复。")
        }
        if (await this.stopped(ticket, journal!)) conflict("授权期间任务已停止，已撤销自动授权。")
        journal!.phase = "trusted"; this.save(ticket, journal!)
        await this.sweep(ticket)
        if (await this.stopped(ticket, journal!)) conflict("授权期间任务已停止，已撤销自动授权。")
      } else {
        if (!this.owned(journal)) return this.item(ticket)
        await this.revoke(ticket, journal!)
      }
      return this.item(ticket)
    })
  }
  async tick() {
    await Promise.all(this.engine.store.tickets().map(async (ticket) => {
      try {
        const journal = this.journal(ticket)
        if (!this.owned(journal) || this.locks.has(ticket.id) || this.engine.closed) return
        // Revocations are resumed explicitly, except when an actual stopped
        // ticket needs cleanup after a concurrent or interrupted grant.
        if (journal!.phase === "revoking" && ticket.state !== "stopped") return
        await this.serial(ticket.id, async () => {
          if (await this.stopped(ticket, journal!)) return
          if (journal!.phase === "granting") {
            if (!this.matches(await this.remote(ticket))) return
            if (await this.stopped(ticket, journal!)) return
            journal!.phase = "trusted"; this.save(ticket, journal!)
          }
          await this.sweep(ticket)
        })
      } catch { /* Keep the journal; one unavailable/corrupt task cannot break the others. */ }
    }))
  }
  assertUninstallable() {
    if (this.locks.size) conflict("任务权限操作正在进行，请稍后卸载。")
    if (this.engine.store.tickets().some((ticket) => this.owned(this.journal(ticket))))
      conflict("请先撤销所有本任务授权；卸载不会遗留自动执行权限。")
  }
}
