import path from "node:path"

type Obj = Record<string, unknown>

const root = path.resolve(import.meta.dir, "../../..")
const local = Bun.argv[2] ?? path.join(root, "packages/opencode/test/tool/fixtures/models-api.json")
const upstream =
  Bun.argv[3] ??
  path.join(process.env.HOME ?? "", "tmp/opencode/packages/opencode/test/tool/fixtures/models-api.json")
const out = Bun.argv[4] ?? path.join(root, "LLM_FIXTURE_DIFF_REPORT.json")

function obj(val: unknown): val is Obj {
  return !!val && typeof val === "object" && !Array.isArray(val)
}

function arr(val: unknown) {
  return Array.isArray(val) ? val : []
}

function sorted(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sorted)
  if (!obj(val)) return val
  return Object.fromEntries(Object.keys(val).sort().map((key) => [key, sorted(val[key])]))
}

function hash(val: unknown) {
  return Bun.hash(JSON.stringify(sorted(val))).toString(16)
}

function keys(val: unknown) {
  return obj(val) ? Object.keys(val).sort() : []
}

function models(provider: unknown) {
  if (!obj(provider)) return {}
  if (!obj(provider.models)) return {}
  return provider.models
}

function meta(provider: unknown) {
  if (!obj(provider)) return {}
  return Object.fromEntries(Object.entries(provider).filter(([key]) => key !== "models"))
}

function shape(val: unknown, depth = 0): unknown {
  if (Array.isArray(val)) {
    return {
      type: "array",
      length: val.length,
      item: val.length && depth < 4 ? shape(val[0], depth + 1) : undefined,
    }
  }
  if (!obj(val)) return { type: val === null ? "null" : typeof val }
  if (depth >= 4) return { type: "object", keys: keys(val) }
  return {
    type: "object",
    keys: keys(val),
    fields: Object.fromEntries(Object.keys(val).sort().map((key) => [key, shape(val[key], depth + 1)])),
  }
}

function hist(list: unknown[]) {
  return Object.fromEntries(
    Array.from(
      list
        .flatMap((item) => keys(item))
        .reduce((map, key) => map.set(key, (map.get(key) ?? 0) + 1), new Map<string, number>()),
    ).sort(([a], [b]) => a.localeCompare(b)),
  )
}

function sample(list: string[], size = 25) {
  return list.slice(0, size)
}

function side(name: string, data: Obj) {
  const providers = keys(data)
  const counts = providers.map((id) => [id, keys(models(data[id])).length] as const)
  const model = counts.reduce((sum, item) => sum + item[1], 0)
  return {
    name,
    path: name === "local" ? local : upstream,
    bytes: Bun.file(name === "local" ? local : upstream).size,
    providers: providers.length,
    models: model,
    provider_keys: hist(providers.map((id) => data[id])),
    model_keys: hist(providers.flatMap((id) => Object.values(models(data[id])))),
    largest_providers: counts
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id, count]) => ({ id, count })),
    structure: shape(data[providers[0]]),
  }
}

function diff(local: Obj, upstream: Obj) {
  const left = new Set(keys(local))
  const right = new Set(keys(upstream))
  const common = keys(local).filter((id) => right.has(id))
  const providers = common.map((id) => {
    const l = models(local[id])
    const r = models(upstream[id])
    const lkeys = new Set(keys(l))
    const rkeys = new Set(keys(r))
    const shared = keys(l).filter((key) => rkeys.has(key))
    const changed = shared.filter((key) => hash(l[key]) !== hash(r[key]))
    return {
      id,
      local_models: keys(l).length,
      upstream_models: keys(r).length,
      missing_models: keys(r).filter((key) => !lkeys.has(key)),
      extra_models: keys(l).filter((key) => !rkeys.has(key)),
      changed_models: changed,
      provider_meta_changed: hash(meta(local[id])) !== hash(meta(upstream[id])),
    }
  })
  return {
    missing_providers: keys(upstream).filter((id) => !left.has(id)),
    extra_providers: keys(local).filter((id) => !right.has(id)),
    changed_provider_meta: providers.filter((item) => item.provider_meta_changed).map((item) => item.id),
    providers,
    totals: {
      missing_providers: keys(upstream).filter((id) => !left.has(id)).length,
      extra_providers: keys(local).filter((id) => !right.has(id)).length,
      missing_models: providers.reduce((sum, item) => sum + item.missing_models.length, 0),
      extra_models: providers.reduce((sum, item) => sum + item.extra_models.length, 0),
      changed_models: providers.reduce((sum, item) => sum + item.changed_models.length, 0),
      changed_provider_meta: providers.filter((item) => item.provider_meta_changed).length,
    },
  }
}

const left = (await Bun.file(local).json()) as unknown
const right = (await Bun.file(upstream).json()) as unknown

if (!obj(left)) throw new Error(`Expected object JSON at ${local}`)
if (!obj(right)) throw new Error(`Expected object JSON at ${upstream}`)

const report = diff(left, right)
const focus = ["google", "deepseek", "vercel", "openrouter", "openai", "anthropic"]
const targets = [
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "gpt-5.5",
  "claude-opus-4-8",
]
const result = {
  generated_at: new Date().toISOString(),
  local: side("local", left),
  upstream: side("upstream", right),
  totals: report.totals,
  samples: {
    missing_providers: sample(report.missing_providers),
    extra_providers: sample(report.extra_providers),
    changed_provider_meta: sample(report.changed_provider_meta),
  },
  focus: Object.fromEntries(
    focus.map((id) => {
      const item = report.providers.find((provider) => provider.id === id)
      return [
        id,
        item
          ? {
              local_models: item.local_models,
              upstream_models: item.upstream_models,
              missing_models: sample(item.missing_models, 80),
              extra_models: sample(item.extra_models, 80),
              changed_models: sample(item.changed_models, 80),
              provider_meta_changed: item.provider_meta_changed,
            }
          : {
              local_models: keys(models(left[id])).length,
              upstream_models: keys(models(right[id])).length,
              missing_models: [],
              extra_models: [],
              changed_models: [],
              provider_meta_changed: false,
            },
      ]
    }),
  ),
  targets: Object.fromEntries(
    focus.map((id) => [
      id,
      Object.fromEntries(
        targets.map((target) => [
          target,
          {
            local: !!models(left[id])[target],
            upstream: !!models(right[id])[target],
            changed:
              !!models(left[id])[target] &&
              !!models(right[id])[target] &&
              hash(models(left[id])[target]) !== hash(models(right[id])[target]),
          },
        ]),
      ),
    ]),
  ),
  providers: Object.fromEntries(
    report.providers.map((item) => [
      item.id,
      {
        local_models: item.local_models,
        upstream_models: item.upstream_models,
        missing_count: item.missing_models.length,
        extra_count: item.extra_models.length,
        changed_count: item.changed_models.length,
        provider_meta_changed: item.provider_meta_changed,
        missing_sample: sample(item.missing_models),
        extra_sample: sample(item.extra_models),
        changed_sample: sample(item.changed_models),
      },
    ]),
  ),
}

await Bun.write(out, `${JSON.stringify(result, null, 2)}\n`)
console.log(out)
