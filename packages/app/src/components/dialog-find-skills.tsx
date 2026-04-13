import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, createSignal, createEffect, For, Match, Show, Switch, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"

type Item = {
  id: string
  name: string
  provider: "registry" | "external"
  description?: string
  installs?: string
  url?: string
  registry?: string
  version?: string
  package?: string
  source?: string
  installed?: boolean
  scope?: "project" | "global"
  update_available?: boolean
  summary_zh?: string
  summary_source?: "skills_summary" | "skill_md"
  why_recommended?: string
  relevance?: "high" | "medium" | "low"
  tier?: "main" | "more"
}

type Search = {
  main: Item[]
  more: Item[]
  meta: {
    model?: string
    latency_ms?: number
    local?: {
      status: "success" | "timeout" | "error" | "pending"
      count?: number
      message?: string
    }
    external?: {
      status: "success" | "timeout" | "error" | "pending"
      count?: number
      message?: string
    }
  }
}

type Note = {
  install?: "queued" | "running" | "success" | "error"
  install_job?: string
  install_message?: string
}

type Job = {
  job_id: string
  id: string
  provider: "registry" | "external"
  name: string
  registry?: string
  package?: string
  source?: string
  scope?: "project" | "global"
  status: "queued" | "running" | "success" | "error"
  message?: string
  started_at?: number
  finished_at?: number
}

function text(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function norm(value?: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

function source(value?: Item["summary_source"]) {
  if (value === "skills_summary") return "官方摘要"
  if (value === "skill_md") return "SKILL.md"
  return "暂无简介"
}

export function DialogFindSkills(props: { directory: string }) {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const searchFetch = createMemo(() => {
    const cur = server.current
    if (!platform.fetch || !cur) return fetch
    try {
      const url = new URL(cur.http.url)
      const loop = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loop) return platform.fetch
    } catch {
      return fetch
    }
    return fetch
  })
  const client = createMemo(() =>
    sdk.createClient({
      directory: props.directory,
      throwOnError: true,
    }),
  )
  const [q, setQ] = createSignal("")
  const [submitted, setSubmitted] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  const [hits, setHits] = createSignal<Search>({ main: [], more: [], meta: {} })
  const [searching, setSearching] = createSignal(false)
  const [semantic, setSemantic] = createSignal(false)
  const [more, setMore] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [note, setNote] = createStore({} as Record<string, Note>)
  const [job, setJob] = createSignal<Record<string, Job>>({})
  let seq = 0
  let poll: ReturnType<typeof setTimeout> | undefined

  const [base, { refetch: refetchBase, mutate: setBase }] = createResource<Item[]>(async () => {
    const result = await client().skill.installed()
    return (result.data ?? []).map((item) => ({ ...item, installed: !!item.installed }))
  })

  const itemFromJob = (item: Job): Item => ({
    id: item.id,
    name: item.name,
    provider: item.provider,
    registry: item.registry,
    package: item.package,
    source: item.source,
    scope: item.scope,
    installed: item.status === "success",
    update_available: false,
  })

  const installText = (item: Job) => {
    if (item.status === "queued") return "排队中"
    if (item.status === "running") return "安装中..."
    if (item.status === "success") return "安装成功"
    return item.message ?? "安装失败"
  }

  const sync = (items: Job[]) => {
    const prev = job()
    setJob(Object.fromEntries(items.map((item) => [item.id, item])))
    const done = items.some((item) => item.status === "success" && prev[item.id]?.status !== "success")
    for (const item of items) {
      setNote(item.id, {
        ...note[item.id],
        install: item.status,
        install_job: item.job_id,
        install_message: installText(item),
      })
      if (item.status === "success") mark(itemFromJob(item))
    }
    if (done) void refresh()
  }

  const stop = () => {
    if (!poll) return
    clearTimeout(poll)
    poll = undefined
  }

  const jobs = async () => {
    stop()
    const result = await client().skill.jobs().catch(() => undefined)
    const data = result?.data ?? []
    sync(data)
    if (data.some((item) => item.status === "queued" || item.status === "running")) {
      poll = setTimeout(() => void jobs(), 1000)
    }
  }

  createEffect(() => {
    if (q().trim()) return
    if (!submitted()) return
    setSubmitted("")
    setHits({ main: [], more: [], meta: {} })
    setError(null)
    setSearching(false)
    setSemantic(false)
    setMore(false)
  })

  const post = <T,>(url: string, body: unknown) => {
    const cur = server.current
    if (!cur) return Promise.reject(new Error("Server unavailable"))
    const head: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": /[^\x00-\x7F]/.test(props.directory) ? encodeURIComponent(props.directory) : props.directory,
    }
    if (cur.http.password) {
      head.Authorization = `Basic ${btoa(`${cur.http.username ?? "opencode"}:${cur.http.password}`)}`
    }
    return searchFetch()(new URL(url, cur.http.url), {
      method: "POST",
      headers: head,
      body: JSON.stringify(body),
    }).then(async (res) => {
      const data = await res.json().catch(() => undefined)
      if (res.ok) return data as T
      const msg =
        typeof data === "object" && data && "message" in data && typeof data.message === "string"
          ? data.message
          : res.statusText || "Request failed"
      return Promise.reject(new Error(msg))
    })
  }

  const searcher = (value: string, semantic: boolean) =>
    post<Search>("/skill/search", { query: value, semantic }).then((data) => ({
      ...data,
      main: data.main.map((item) => ({ ...item, installed: !!item.installed })),
      more: data.more.map((item) => ({ ...item, installed: !!item.installed })),
    }))

  createEffect(() => {
    client()
    void jobs()
    onCleanup(stop)
  })

  const run = async (value: string) => {
    const id = ++seq
    setSubmitted(value)
    setError(null)
    setSearching(true)
    setSemantic(false)
    setMore(false)
    await searcher(value, false)
      .then(async (result) => {
        if (id !== seq) return
        setHits(result)
        setSemantic(true)
        return searcher(value, true).then((next) => {
          if (id !== seq) return
          setHits(next)
        })
      })
      .catch((err) => {
        if (id !== seq) return
        setHits({ main: [], more: [], meta: {} })
        setError(text(err))
        setSearching(false)
        setSemantic(false)
      })
      .finally(() => {
        if (id !== seq) return
        setSemantic(false)
        if (searching()) setSearching(false)
      })
  }

  const list = createMemo(() => {
    const source = submitted()
      ? hits()
      : {
          main: Array.from(
            [
              ...Object.values(job())
                .filter((item) => item.status === "queued" || item.status === "running" || item.status === "error")
                .map(itemFromJob),
              ...(base() ?? []),
            ]
              .reduce((acc, item) => (acc.has(item.id) ? acc : acc.set(item.id, item)), new Map<string, Item>())
              .values(),
          ).map((item) => ({ ...item, tier: "main" as const })),
          more: [],
          meta: {},
        }
    if (submitted() && q().trim() === submitted().trim()) return source
    const value = norm(q())
    if (!value) return source
    const filter = (items: Item[]) =>
      items.filter((item) =>
        [item.name, item.description, item.source, item.registry, item.package, item.installs]
          .filter((item): item is string => !!item)
          .some((item) => norm(item).includes(value)),
      )
    return {
      ...source,
      main: filter(source.main),
      more: filter(source.more),
    }
  })

  const loading = createMemo(() => (submitted() ? searching() : base.loading))
  const supplementing = createMemo(() => !!submitted() && searching() && semantic())
  const tip = createMemo(() => {
    if (!submitted()) return "当前显示已安装技能；点击检查更新获取最新状态"
    if (supplementing()) return "本地结果已显示，正在补充外网查找"
    if (searching()) return "正在搜索已安装与可用 Skills"
    const state = hits().meta.external?.status
    if (state === "timeout") {
      return list().main.length || list().more.length
        ? "外网 Skill 搜索超时，当前显示本地与已获取结果"
        : "外网 Skill 搜索超时，当前没有可显示结果"
    }
    if (state === "error") {
      return list().main.length || list().more.length
        ? "外网 Skill 搜索失败，当前显示本地与已获取结果"
        : "外网 Skill 搜索失败，当前没有可显示结果"
    }
    return "已完成本地与外网 Skill 搜索"
  })
  const empty = createMemo(() => {
    if (!submitted()) return "暂无可显示的 Skills"
    const state = hits().meta.external?.status
    if (state === "timeout") return "外网 Skill 搜索超时，且没有找到本地匹配结果"
    if (state === "error") return "外网 Skill 搜索失败，且没有找到本地匹配结果"
    return "没有找到匹配的 Skills"
  })

  const refresh = async () => {
    const result = await client().skill.installed()
    const next = (result.data ?? []).map((item) => ({ ...item, installed: !!item.installed }))
    setBase(next)
    return next
  }

  const match = (a: Item, b: Item) => {
    if (a.id === b.id) return true
    if (a.provider !== b.provider) return false
    if (a.provider === "registry") return a.registry === b.registry && a.name === b.name
    return a.package === b.package || (a.source === b.source && a.name === b.name)
  }

  const mark = (item: Item) => {
    setHits((list) =>
      ({
        ...list,
        main: list.main.map((hit) =>
          match(hit, item)
            ? {
                ...hit,
                installed: true,
                scope: "project" as const,
                update_available: false,
              }
            : hit,
        ),
        more: list.more.map((hit) =>
          match(hit, item)
            ? {
                ...hit,
                installed: true,
                scope: "project" as const,
                update_available: false,
              }
            : hit,
        ),
      }),
    )
    setBase((list) => {
      const next = (list ?? []).map((hit) =>
        match(hit, item)
          ? {
              ...hit,
              installed: true,
              scope: "project" as const,
              update_available: false,
            }
          : hit,
      )
      if (next.some((hit) => match(hit, item))) return next
      return [
        {
          ...item,
          installed: true,
          scope: "project" as const,
          update_available: false,
        },
        ...next,
      ]
    })
  }

  const clear = (names: string[]) => {
    if (names.length === 0) return
    const set = new Set(names)
    setHits((list) =>
      ({
        ...list,
        main: list.main.map((item) =>
          set.has(item.name)
            ? {
                ...item,
                installed: true,
                scope: (item.scope ?? "project") as "project" | "global",
                update_available: false,
              }
            : item,
        ),
        more: list.more.map((item) =>
          set.has(item.name)
            ? {
                ...item,
                installed: true,
                scope: (item.scope ?? "project") as "project" | "global",
                update_available: false,
              }
            : item,
        ),
      }),
    )
    setBase((list) =>
      (list ?? []).map((item) =>
        set.has(item.name)
          ? {
              ...item,
              installed: true,
              scope: (item.scope ?? "project") as "project" | "global",
              update_available: false,
            }
          : item,
      ),
    )
  }

  const check = async () => {
    setBusy("check")
    await client()
      .skill.check()
      .then((result) => {
        setBase((result.data ?? []).map((item) => ({ ...item, installed: !!item.installed })))
      })
      .catch((err) => {
        showToast({
          variant: "error",
          icon: "circle-x",
          title: "检查更新失败",
          description: text(err),
        })
      })
      .finally(() => {
        setBusy(null)
      })
  }

  const search = () => {
    const value = q().trim()
    if (!value) {
      seq += 1
      setSubmitted("")
      setHits({ main: [], more: [], meta: {} })
      setError(null)
      setSearching(false)
      setSemantic(false)
      void refetchBase()
      return
    }
    void run(value)
  }

  const install = async (item: Item) => {
    const task =
      item.provider === "registry" && item.registry
        ? client().skill.install({
            body: {
              kind: "registry",
              registry: item.registry,
              name: item.name,
            },
          })
        : item.package
          ? client().skill.install({
              body: {
                kind: "external",
                package: item.package,
                scope: "project",
              },
            })
          : Promise.reject(new Error("Skill 缺少安装信息"))

    await task
      .then((result) => {
        const data = result.data
        if (!data) throw new Error("安装任务创建失败")
        sync([data, ...Object.values(job()).filter((job) => job.id !== data.id)])
        showToast({
          icon: "download",
          title: data.status === "queued" ? "已加入安装队列" : "开始安装",
          description: item.name,
        })
        void jobs()
      })
      .catch((err) => {
        showToast({
          variant: "error",
          icon: "circle-x",
          title: "安装失败",
          description: text(err),
        })
      })
  }

  const update = async (names?: string[]) => {
    const key = names?.length ? `update:${names[0]}` : "update:all"
    setBusy(key)
    await client().skill
      .update(names?.length ? { names } : {})
      .then(async (result) => {
        const updated = result.data?.updated ?? []
        showToast({
          variant: "success",
          icon: "check",
          title: updated.length ? "更新完成" : "已是最新",
          description: updated.length ? updated.join(", ") : "没有可更新的 Skills",
        })
        clear(updated)
        await refresh()
      })
      .catch((err) => {
        showToast({
          variant: "error",
          icon: "circle-x",
          title: "更新失败",
          description: text(err),
        })
      })
      .finally(() => {
        setBusy(null)
      })
  }

  const cards = (items: Item[], more = false) => (
    <For each={items}>
      {(item) => (
        <div class="flex items-start justify-between gap-3 px-3 py-3 rounded-lg border border-border-weak-base bg-surface-base hover:border-border-base transition-colors">
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-13-medium text-text-strong truncate">{item.name}</span>
              <Show when={item.version}>
                <span class="text-11-regular text-text-subtle shrink-0">v{item.version}</span>
              </Show>
            </div>

            <div class="flex flex-wrap items-center gap-1.5">
              <Tag>{item.provider === "registry" ? "Registry" : "External"}</Tag>
              <Show when={more}>
                <Tag>More</Tag>
              </Show>
              <Show when={item.scope}>
                <Tag>{item.scope === "project" ? "Project" : "Global"}</Tag>
              </Show>
              <Show when={item.installed}>
                <Tag>{item.scope === "global" ? "Installed globally" : "Installed"}</Tag>
              </Show>
              <Show when={item.update_available}>
                <Tag>Update available</Tag>
              </Show>
              <Show when={item.installs}>
                <Tag>{item.installs} installs</Tag>
              </Show>
            </div>

            <Show when={item.description}>
              <div class="text-12-regular text-text-weak leading-5 whitespace-pre-wrap break-words">
                {item.description}
              </div>
            </Show>

            <Show when={submitted()}>
              <Show when={item.why_recommended}>
                <div class="text-12-medium text-text-strong leading-5 whitespace-pre-wrap break-words">
                  {item.why_recommended}
                </div>
              </Show>
            </Show>

            <Show when={submitted()}>
              <div class="text-12-regular text-text-weak leading-5 whitespace-pre-wrap break-words">
                {semantic() && !item.summary_zh ? "正在读取 SKILL.md..." : item.summary_zh ?? "暂无简介"}
              </div>
            </Show>

            <Show when={submitted()}>
              <div class="text-11-regular text-text-subtle">
                简介来源：{semantic() && !item.summary_zh ? "加载中" : source(item.summary_source)}
              </div>
            </Show>

            <Show when={item.source || item.registry || item.package}>
              <div class="text-11-regular text-text-subtle break-all">
                {item.source ?? item.registry ?? item.package}
              </div>
            </Show>

            <Show when={note[item.id]?.install}>
              <div
                classList={{
                  "text-11-regular": true,
                  "text-text-subtle":
                    note[item.id]?.install === "queued" ||
                    note[item.id]?.install === "running" ||
                    note[item.id]?.install === "success",
                  "text-danger": note[item.id]?.install === "error",
                }}
              >
                {note[item.id]?.install_message}
              </div>
            </Show>

          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            <Show when={item.url}>
              <Button
                variant="ghost"
                size="small"
                onClick={() => window.open(item.url, "_blank", "noopener,noreferrer")}
              >
                <Icon name="square-arrow-top-right" size="small" />
                查看
              </Button>
            </Show>
            <Show when={item.update_available && item.scope !== "global"}>
              <Button
                variant="primary"
                size="small"
                disabled={busy() === `update:${item.name}` || busy() === "update:all"}
                onClick={() => void update([item.name])}
              >
                <Icon name="arrow-down-to-line" size="small" />
                更新
              </Button>
            </Show>
            <Show when={note[item.id]?.install === "queued" || note[item.id]?.install === "running"}>
              <Button variant="secondary" size="small" disabled={true}>
                <Icon name="download" size="small" />
                安装中...
              </Button>
            </Show>
            <Show
              when={
                !(note[item.id]?.install === "queued" || note[item.id]?.install === "running") &&
                (!item.installed && !!item.package || !item.installed && !!item.registry)
              }
            >
              <Button variant="secondary" size="small" disabled={false} onClick={() => void install(item)}>
                <Icon name="download" size="small" />
                安装
              </Button>
            </Show>
          </div>
        </div>
      )}
    </For>
  )

  return (
    <Dialog
      title="Find Skills"
      size="large"
      action={
        <div class="flex items-center gap-1.5 -my-1">
          <Button
            variant="secondary"
            size="small"
            disabled={busy() === "check" || busy() === "update:all"}
            onClick={() => void check()}
          >
            <Icon name="check-small" size="small" />
            检查更新
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={busy() === "update:all"}
            onClick={() => void update()}
          >
            <Icon name="arrow-down-to-line" size="small" />
            全部更新
          </Button>
        </div>
      }
    >
      <div class="flex flex-col gap-3 min-h-0">
        <div class="flex items-center gap-2">
          <TextField
            value={q()}
            onChange={setQ}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key !== "Enter" || e.isComposing) return
              e.preventDefault()
              search()
            }}
            placeholder="搜索技能，例如 auto updater"
            class="flex-1"
            autofocus
          />
          <Button variant="primary" size="small" onClick={search}>
            <Icon name="brain" size="small" />
            搜索
          </Button>
        </div>

        <div class="flex items-center justify-between text-12-regular text-text-weak px-1">
          <span>
            <Show
              when={supplementing()}
              fallback={<span>{tip()}</span>}
            >
              <TextShimmer text={tip()} />
            </Show>
          </span>
          <Show when={submitted()}>
            <span>查询：{submitted()}</span>
          </Show>
        </div>

        <Switch>
          <Match when={loading() && list().main.length === 0 && list().more.length === 0}>
            <div class="text-12-regular text-text-weak px-1">加载中...</div>
          </Match>
          <Match when={!!error()}>
            <div class="text-12-regular text-danger px-1">{error()}</div>
          </Match>
          <Match when={list().main.length === 0 && list().more.length === 0}>
            <div class="text-12-regular text-text-weak px-1">{empty()}</div>
          </Match>
          <Match when={true}>
            <div class="flex flex-col gap-3 overflow-y-auto max-h-[26rem] pr-0.5">
              <Show when={list().main.length > 0}>
                <div class="px-1 text-12-medium text-text-subtle">{submitted() ? "推荐结果" : "已安装"}</div>
              </Show>
              <div class="flex flex-col gap-2">{cards(list().main)}</div>
              <Show when={submitted() && list().more.length > 0}>
                <div class="pt-1">
                  <button
                    class="w-full flex items-center justify-between px-1 py-1 text-12-medium text-text-subtle hover:text-text-strong transition-colors"
                    onClick={() => setMore((value) => !value)}
                  >
                    <span>更多相关 ({list().more.length})</span>
                    <Icon name={more() ? "chevron-down" : "chevron-right"} size="small" />
                  </button>
                </div>
              </Show>
              <Show when={submitted() && list().more.length > 0 && more()}>
                <div class="flex flex-col gap-2">{cards(list().more, true)}</div>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
