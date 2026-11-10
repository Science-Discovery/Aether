import { onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSuperagentClient, type NativeState } from "./client"

export function SettingsSuperagent() {
  const client = createSuperagentClient()
  const [state, set] = createStore({ native: undefined as NativeState | undefined, minutes: "30", busy: false, error: "", confirm: false })
  const disabled = () => !client.valid() || state.busy || !state.native?.installed
  async function load() {
    const value = await client.request<{ native: NativeState }>("/panel/state")
    set({ native: value.native, minutes: String(value.native.schedule.minutes) })
  }
  async function refresh() {
    if (state.busy || !client.valid()) return
    set({ busy: true, error: "" })
    try { await load() }
    catch (error) { if (client.valid()) set("error", String(error)) }
    finally { if (client.valid()) set("busy", false) }
  }
  async function update(body: { enabled?: boolean; schedule?: { enabled: boolean; minutes: number } }) {
    if (disabled()) return
    set({ busy: true, error: "", confirm: false })
    try { await client.request("/native/settings", body); await load() }
    catch (error) { if (client.valid()) set("error", String(error)) }
    finally { if (client.valid()) set("busy", false) }
  }
  function schedule(enabled: boolean) {
    const minutes = Number(state.minutes)
    if (!/^\d+$/.test(state.minutes.trim()) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
      set("error", "检查间隔须为 1–1440 的整数分钟。")
      return
    }
    void update({ schedule: { enabled, minutes } })
  }
  async function uninstall() {
    if (disabled() || !state.confirm) return
    set({ busy: true, error: "" })
    try {
      await client.request("/native/uninstall", { confirm: true })
      set({ native: { enabled: false, installed: false, schedule: { enabled: false, minutes: Number(state.minutes) || 30 } }, confirm: false })
    } catch (error) {
      // A refused uninstall may already have disabled scheduling on the server.
      if (client.valid()) {
        try { await load() } catch { /* Keep the actionable uninstall error. */ }
        if (client.valid()) set("error", String(error))
      }
    }
    finally { if (client.valid()) set("busy", false) }
  }
  onMount(() => void refresh())
  return (
    <div class="flex flex-col gap-6 px-6 py-6 max-w-[720px]" data-testid="superagent-settings">
      <div><h2 class="text-16-medium text-text-strong">Super-agent</h2><p class="mt-2 text-13-regular text-text-weak">在主控会话中安排研究工作，在研究工作台查看进展与待决事项。</p></div>
      <Show when={state.error || !client.valid()}><div role="alert" class="text-13-regular text-text-critical-base">{client.valid() ? state.error : "后端已切换，请重新打开设置。"}<Show when={client.valid()}><Button size="small" variant="ghost" disabled={state.busy} onClick={() => void refresh()}>重新读取</Button></Show></div></Show>
      <Show when={state.native} fallback={<p class="text-13-regular text-text-weak">正在读取设置…</p>}>{(native) => <>
        <Show when={native().installed} fallback={<p role="status" class="text-13-regular text-text-weak" data-testid="superagent-uninstalled">Super-agent 已卸载。研究数据与已有会话保留；刷新 Aether 后更新导航入口。</p>}>
          <div class="rounded-lg border border-border-base p-4 flex flex-col gap-4">
            <div class="flex items-center justify-between gap-6">
              <div class="min-w-0 flex flex-col gap-1">
                <div class="text-14-medium text-text-strong">启用 Super-agent</div>
                <p class="text-13-regular text-text-weak">停用后不再调度新任务，已有执行可继续回收结果，研究数据保留。</p>
              </div>
              <Switch class="shrink-0" hideLabel checked={native().enabled} disabled={disabled()} onChange={(enabled) => void update({ enabled })}
                data-testid="superagent-enabled">启用 Super-agent</Switch>
            </div>
            <Show when={!native().enabled}><p class="text-13-regular text-text-weak" role="status">当前已停用。</p></Show>
          </div>
          <div class="rounded-lg border border-border-base p-4 flex flex-col gap-4">
            <h3 class="text-14-medium text-text-strong">定时检查</h3>
            <div class="flex items-center justify-between gap-6">
              <div class="min-w-0 flex flex-col gap-1">
                <div class="text-14-medium text-text-strong">定时检查课题进展</div>
                <p class="text-13-regular text-text-weak">默认关闭。启用后定时唤醒主控检查已有课题；可能产生模型用量。停用 Super-agent 时不触发。</p>
              </div>
              <Switch class="shrink-0" hideLabel checked={native().schedule.enabled} disabled={disabled()} onChange={schedule}
                data-testid="superagent-schedule-enabled">定时检查课题进展</Switch>
            </div>
            <div class="flex items-end gap-3 flex-wrap">
              <TextField label="检查间隔（分钟）" type="number" min="1" max="1440" step="1" value={state.minutes} onChange={(value) => set("minutes", value)} disabled={disabled()} data-testid="superagent-schedule-minutes" />
              <Button variant="secondary" disabled={disabled() || state.minutes === String(native().schedule.minutes)} onClick={() => schedule(native().schedule.enabled)} data-testid="superagent-schedule-save">保存间隔</Button>
            </div>
          </div>
          <div class="rounded-lg border border-border-base p-4 flex flex-col gap-4">
            <h3 class="text-14-medium text-text-strong">卸载集成</h3><p class="text-13-regular text-text-weak">移除 Aether 中的 Super-agent 集成，保留研究数据与会话。如果仍有任务运行，请先在工作台停止任务并等待执行结束。</p>
            <Show when={state.confirm} fallback={<Button variant="secondary" disabled={disabled()} onClick={() => set("confirm", true)} data-testid="superagent-uninstall">卸载 Super-agent…</Button>}>
              <div role="group" aria-label="确认卸载 Super-agent" class="flex flex-col gap-3" data-testid="superagent-uninstall-confirmation">
                <p class="text-13-regular text-text-strong">确认移除 Super-agent 集成？这会关闭主控调度并移除工作台与设置入口。</p>
                <div class="flex gap-2"><Button variant="primary" disabled={disabled()} onClick={() => void uninstall()} data-testid="superagent-uninstall-confirm">确认卸载</Button><Button variant="ghost" disabled={state.busy} onClick={() => set("confirm", false)}>取消</Button></div>
              </div>
            </Show>
          </div>
        </Show>
      </>}</Show>
    </div>
  )
}
