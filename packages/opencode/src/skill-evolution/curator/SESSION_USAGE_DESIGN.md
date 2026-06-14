# Aether Curator 记会话 — 给每次 skill 使用记下「近期使用坐标」设计文档

> 状态：**设计定稿 v2**，可进入实现（实现走 TDD）。
> 读者：团队开发者 + 组会评审 + 照本实现的人（含 yolo 沙盒会话——它没有设计讨论的上下文，本文档即唯一说明书）。
> 出处：2026-06-12 组会，导师要求「先把使用历史记全，再往后做 skill 进化」——每次用 skill 要能回溯它在**哪个项目、哪次会话、什么时候**被用过，供日后判断「它当初有没有真起作用」（转写 `20260612_1432_speakers.txt` 行94/99/102/109/110/189）。
> 关联：本目录 [`CURATOR_DESIGN.md`](./CURATOR_DESIGN.md)（curator 整体设计）、[`IDLE_SCANS_DESIGN.md`](./IDLE_SCANS_DESIGN.md)（归档判据改造，已实现）。本文档**只加「记近期使用坐标」这一块**，归档判据等全部沿用，不重述。
>
> **v2 相对 v1 的关键修订**（实地查 DB + 组会复核后）：①查实**会话 DB 已自动记录每次 skill 调用**（session id + 时间 + skill 名），故 `recent_uses` 从「主数据源」降级为**近期窗口缓存/索引**，DB 才是全量权威源；②`recent_uses` 的上限不是缺陷，是**有意的「近期窗口」**（只看近期、防旧成绩稀释现状）；③v1 的「Q-S 会话能否检索」风险**已查实解决**；④确定**不加**评估字段（`disposition`/`reviewed_at`），留给后续；⑤`bumpUse` 保持 `await`（实测 0.3ms，不 fire-and-forget）。

给 `bumpUse`（每次 skill 被加载时记一次使用的函数）补上「坐标」：除了把累计次数 `use_count` +1，再往该 skill 的账本记录里**追加一条事件** `{ session_id, at }`（哪次会话、什么时候）。项目 id 因为账本本来就按项目分键，无需每条重复。事件列表只保留**最近 N 条**（滑动窗口，满了挤掉最老的）——这既省 token，又让评估只看「近期表现」，不被久远的旧成绩干扰。**本分支只负责「把近期使用坐标攒成一个现成索引」——不改归档行为、不判断 skill 有没有用、不删任何东西**，那些是后续工作。

---

## 目录

- [一个关键前提：会话 DB 已自动记录 skill 调用](#一个关键前提会话-db-已自动记录-skill-调用)
- [设计原则](#设计原则)
- [解决了导师的什么顾虑](#解决了导师的什么顾虑)
- [数据结构](#数据结构)
- [核心机制详解](#核心机制详解)
  - [1. bumpUse 追加事件 + 滑动窗口截断](#1-bumpuse-追加事件--滑动窗口截断)
  - [2. session id 从哪来](#2-session-id-从哪来)
  - [3. 兼容：旧账本缺字段](#3-兼容旧账本缺字段)
- [为什么保持 await、不 fire-and-forget](#为什么保持-await不-fire-and-forget)
- [核心不变量](#核心不变量)
- [决策记录](#决策记录)
- [开放问题](#开放问题)
- [关键文件速查](#关键文件速查)
- [复用组件核实](#复用组件核实实现前必读)
- [命题清单](#命题清单)
- [测试与红绿里程碑](#测试与红绿里程碑)
- [范围说明](#范围说明)
- [用户体验](#用户体验)

---

## 一个关键前提：会话 DB 已自动记录 skill 调用

> 这是 v2 的地基。**先看清这层，才能理解 `recent_uses` 为什么只是「缓存」而非「唯一真相」。**

实地查过磁盘上的真实数据库，确认以下事实（非推测）：

- **会话存储是 SQLite，每个项目一个库**：`~/.local/share/aether/local/aether-<projectId>.db`，**文件名里的 hash 就是 project id**。
- **每次 skill 调用都已落库**：库里 `part` 表（存会话每一片内容的表）有 `tool='skill'` 的行，`data`（JSON 字段）里带齐 `session_id`、`time_created`（时间）、`state.input.name`（**加载的哪个 skill**）、`state.status`。真实样本：`ai-qft-survey` · 会话 `ses_148db4…` · `2026-06-12 01:25` · completed。
- **能按 session id 取回整段会话**：`MessageV2.page(sessionID)` 等函数（[message-v2.ts](../../session/message-v2.ts)）现成可用。
- **一个 skill 的使用，锁在它自己那一个项目库里**：项目专属 skill 的发现逻辑（[skill/index.ts:144](../../skill/index.ts#L144)）只扫「当前项目」的 skill 目录，**跨项目互不可见**；实测 `ai-qft-survey` 被用 20 次、20 次全在自己项目库。所谓「shared 共享 skill」当前**未启用**（`skillEvolutionShared()` 从未被生产代码调用，存储层显式跳过 `shared/`，见 [db.ts:96](../../storage/db.ts#L96)）。→ 给定一个 skill，它的全部使用都在**一个**确定的库里，机械检索很便宜。

**两条推论，决定本设计的形状**：

1. **`recent_uses` 是「便利索引/近期缓存」，不是唯一数据源**：使用坐标的**权威全量记录在会话 DB**。账本里这份是为了「curator 自带一份现成的近期窗口、不必每次去开会话 DB」。**真要全量历史，回 DB 查**。
2. **后续「判好坏」的检索必须机械**：将来评估某 skill 时，从账本拿到它的 projectId → 开那一个项目库 → 机械（确定性代码）查出使用位置 + 拼出上下文窗口 → 喂给 AI 判断。**不让 AI 自己钻 DB 乱找**（这一点比组会转写 行115「AI 自己 grab 搜索」更严，是有意收紧）。本分支不实现「判好坏」，但 `recent_uses` 是它的索引入口。

---

## 设计原则

1. **只记不判**：本分支只把「近期使用坐标」攒成索引，**不**用它做任何归档/淘汰决定。判断「有没有真起作用」是后续独立工作（D14、[范围说明](#范围说明)）。
2. **缓存而非真相源**：`recent_uses` 是近期窗口缓存，会话 DB 才是全量权威源（D19）。允许它与 DB 轻微不一致（best-effort 写失败、cap 丢老记录），代价可接受。
3. **上限是特性不是缺陷**：只留最近 N 条 = 有意的「近期窗口」——省 token、且评估只看近期表现，不被久远旧成绩抬高/拉低判断（D17）。
4. **最小改动、贴现有结构**：在 `bumpUse` 里加一段「追加事件」，复用现有账本读写（`load`/`save`）、范围过滤（`resolveScope`）、原子写入；不新建文件、不引入新存储。
5. **best-effort、永不挡加载、保持 await**：沿用 `bumpUse` 现有契约——记账失败只吞，绝不影响 skill 加载；实测一次仅 0.3ms，保持 `await` 不改 fire-and-forget（D20 / [为什么保持 await](#为什么保持-await不-fire-and-forget)）。

### 对旧文件的修改

> 每处标注 **侵入式**（改了旧行为，有回归风险）还是 **增量式**（只加新字段/新调用）。

| 旧文件:位置 | 改什么 | 性质 | 依据 |
|---|---|:---:|---|
| [`usage.ts :: UsageRecord`](./usage.ts#L13) | 加 `recent_uses: UseEvent[]` 一个字段 + `emptyRecord` 初始化成 `[]` | **增量式**（加字段，旧字段不动）| D15 |
| [`usage.ts :: bumpUse`](./usage.ts#L229) | 签名加可选 `sessionId?`；函数体里追加事件 + 截断到 N | **增量式**（旧 2 参调用仍合法）| D15/D17 |
| [`usage.ts :: load`](./usage.ts#L74) | 读老记录时把缺失的 `recent_uses` 补成 `[]`（防御） | **增量式** | D18 |
| [`tool/skill.ts`](../../tool/skill.ts#L69) | `bumpUse(...)` 调用补传 `ctx.sessionID`（保持 `await`） | **增量式**（多传一个已有的值）| D16/D20 |

> **不动**：归档判据（`idle_scans`，见 IDLE_SCANS_DESIGN）、`use_count` 累加时机、`last_used_at`、`archiveSkill`/`restoreSkill`、孤儿自愈、pinned、`shouldRunNow`、`skill_manage`、`constants.ts`（N 是代码常量见 Q-N）——全部沿用。
> **不加**：评估字段 `disposition`/`reviewed_at`（D14/D21，留给后续「判好坏」）。

---

## 解决了导师的什么顾虑

导师围绕 curator / skill 进化共四条顾虑（完整列表见 [`IDLE_SCANS_DESIGN.md`](./IDLE_SCANS_DESIGN.md#解决了导师的什么顾虑)）。其中 **顾虑 3、4** 上一分支留给「记会话」。本分支是「记会话」的**第一步：铺数据索引**。

### 本分支提供前提的（顾虑 4 的「有数据/能定位」那一半）

| # | 导师的顾虑 | 出处 | 本分支做到哪 |
|---|---|---|---|
| **顾虑 4** | **没法回溯评估**：想改进/进化一个 skill 时，得回去看它当初在那些会话里表现好不好；「没有数据，skill 进化无从谈起」 | 转写 行99/102/110/111 | **本分支产出近期使用索引**：每次使用记下 `{ session_id, at }`，账本键带 `projectId` → 凑齐「project id + session id + 时间」，**能直接定位到该去 DB 翻哪几次会话**。注意：只产出「近期指针」，不产出「判断」 |

> **Q-S（v1 标的风险）已查实解决**：会话确实持久化、skill 调用确实落库、可按 session id 取回（见[关键前提](#一个关键前提会话-db-已自动记录-skill-调用)）。不再是风险。

### 本分支【不】解决、仍留给后续的

| # | 顾虑 / 工作 | 为什么本分支治不了 / 真正的解药 |
|---|---|---|
| **顾虑 3** | 「触发灵敏但啥也没干」的烂 skill 反被保留 | 光记坐标**不会淘汰任何 skill**。要治它，得在坐标之上再做：① **机械**检索 DB、拼出每次使用的上下文窗口；② 喂 AI 判断正面/负面；③ 据判断删/降权。这三步本分支都没有 |
| **「判好坏」本身** | 拿坐标翻回会话、判断 skill 当初有没有起作用 | 本分支只存「近期指针」，不存会话内容、不做自动判断。把指针兑现成「上下文」、再判好坏，是后续工作（D14）。导师明确说「评估是后边的事，先记录，没必要每次都评，代价大」（行189）|

**判定标准（本分支达标）**：账本里**每次在范围内的 skill 加载，都落下一条带 `session_id`+`at` 的事件**，列表按上限保留最近 N 条，且能 `load` 回来、跨「写→读」接力验证。**不要求**本分支能判断 skill 好坏或淘汰任何 skill。

---

## 数据结构

### UseEvent — 一条使用事件（新增）

```ts
interface UseEvent {
  session_id: string  // 这次使用发生在哪次会话（来自 ctx.sessionID）
  at: string          // 使用时刻（UTC ISO 8601 字符串）
}
```

> 不含 `projectId`：账本按 `<projectId>/<name>` 分键，一条记录天然只属于一个项目，项目 id 由键隐含（D16）。
> 不含会话内容：只存「指针」，过程靠 id 去 DB 回查（D16）。

### UsageRecord — 单个 skill 的记录（落盘 `curator/usage.json`，key = `<projectId>/<name>`）

```ts
interface UsageRecord {
  projectId: string
  name: string
  location: string
  use_count: number              // 沿用：累计被加载次数（不封顶，只增）
  use_count_at_last_scan: number // 沿用（归档判据用）
  idle_scans: number             // 沿用（归档判据用）
  last_used_at: string | null    // 沿用：最近一次使用时间（单个值）
  recent_uses: UseEvent[]        // 【新增】最近 N 次使用的坐标，按时间先后排，满 N 挤掉最老的
  state: "active" | "stale" | "archived"
  pinned: boolean
  archived_at: string | null
}
```

**新增字段解释**（▲=本次新增）：

| 字段 | 是什么 | 例子 | 改/不改 |
|---|---|---|:---:|
| ▲ `recent_uses` | 最近 `MAX_RECENT_USES`（默认 50，见 Q-N）次使用的坐标列表（**近期窗口缓存**，DB 是权威全量源）。每次 `bumpUse` 往尾部追加一条 `{ session_id, at }`，长度超 N 就从头部丢最老的 | 见下方 JSON | 新增 |

> 三者分工（别混）：`use_count` = **总量**（用了多少次，不封顶）；`recent_uses` = **最近明细**（最近几次在哪个会话/啥时候，有上限）；`last_used_at` = **最近一次的时间**（就一个值）。

**一条完整记录的例子**（`ai-qft-survey` 累计用 8 次，近期窗口留着最近几条）：

```json
"cd18fbc2…/ai-qft-survey": {
  "projectId": "cd18fbc2…",
  "name": "ai-qft-survey",
  "location": "/home/zheng/.local/share/aether/skill-evolution/cd18fbc2…/skills/ai-qft-survey",
  "use_count": 8,
  "use_count_at_last_scan": 7,
  "idle_scans": 0,
  "last_used_at": "2026-06-12T01:25:00.000Z",
  "recent_uses": [
    { "session_id": "ses_8c1f…", "at": "2026-06-08T14:02:00.000Z" },
    { "session_id": "ses_8c1f…", "at": "2026-06-08T14:40:00.000Z" },
    { "session_id": "ses_148db4…", "at": "2026-06-12T01:25:00.000Z" }
  ],
  "state": "active",
  "pinned": false,
  "archived_at": null
}
```

> 读法：同一 `session_id`（`ses_8c1f…`）出现两条 → 这个 skill 在那次会话里被加载了 2 次（每次加载都记，D17）。回溯时按 `session_id` 去那个项目的会话 DB 翻过程。

### 常量（[`usage.ts`](./usage.ts)）

```ts
const MAX_RECENT_USES = 50  // recent_uses 列表上限；超过从头部丢最老（Q-N 待定值）
```

> 放在 `usage.ts` 模块内、**不**进 `CuratorConfig`：这是存储细节、不是用户该调的归档旋钮（YAGNI）。

---

## 核心机制详解

### 1. bumpUse 追加事件 + 滑动窗口截断

`bumpUse` 在 skill 被加载时调用（[`skill.ts:69`](../../tool/skill.ts#L69)）。改造后流程：

```
① resolveScope(location) → 不在 <projectId>/skills/<name> 范围内则直接 return（沿用）
② load 账本，取/建该 skill 的记录 rec（沿用）
③ rec.use_count += 1                                  （沿用）
④ rec.last_used_at = now.toISOString()                （沿用）
⑤ 【新增】若有 sessionId：
     rec.recent_uses.push({ session_id: sessionId, at: now.toISOString() })
     若 rec.recent_uses.length > MAX_RECENT_USES：
        从头部 splice 掉多出来的（保留最近 N 条）
⑥ save 账本（原子写，沿用）
   —— 整段 try/catch 包住，失败只吞，不挡加载（沿用 X3）
```

**改前**（[`usage.ts:229-242`](./usage.ts#L229)）：
```ts
export async function bumpUse(root: string, location: string, now: Date = new Date()): Promise<void> {
  const scope = resolveScope(root, location)
  if (!scope) return
  try {
    const data = await load(root)
    const rec = data[scope.key] ?? emptyRecord(scope)
    rec.use_count += 1
    rec.last_used_at = now.toISOString()
    data[scope.key] = rec
    await save(root, data)
  } catch {}
}
```

**改后**（伪代码，落地按现有风格）：
```ts
export async function bumpUse(
  root: string, location: string, sessionId?: string, now: Date = new Date(),
): Promise<void> {
  const scope = resolveScope(root, location)
  if (!scope) return
  try {
    const data = await load(root)
    const rec = data[scope.key] ?? emptyRecord(scope)
    rec.use_count += 1
    rec.last_used_at = now.toISOString()
    if (sessionId) {                                   // ← 新增：有会话 id 才记坐标（PB1）
      rec.recent_uses.push({ session_id: sessionId, at: now.toISOString() })
      if (rec.recent_uses.length > MAX_RECENT_USES)
        rec.recent_uses.splice(0, rec.recent_uses.length - MAX_RECENT_USES)
    }
    data[scope.key] = rec
    await save(root, data)
  } catch {}
}
```

- **`sessionId` 为何可选**：生产路径（skill.ts）永远传 `ctx.sessionID`，必有值；可选只是为了不冲掉现有 7 处 2 参测试调用（X1）。无 session id 时只 +1、不记坐标（不写半条没用的事件）。
- **截断用 `splice(0, len-N)`**：一次性把头部多余的全切掉，保留尾部最近 N 条。

### 2. session id 从哪来

skill 加载工具 `SkillTool.execute(params, ctx)` 的上下文对象 `ctx`（工具运行时环境，类型见 [`tool.ts:17-27`](../../tool/tool.ts#L17)）上带 **`ctx.sessionID`**（当前会话 id，类型 `SessionID`，本质是个带品牌的字符串）。当前 [`skill.ts:69`](../../tool/skill.ts#L69) 调 `bumpUse` 时没传它，改造 = 把它传进去：

```ts
// 改前
await Usage.bumpUse(Spawner.skillEvolutionRoot(), skill.location)
// 改后
await Usage.bumpUse(Spawner.skillEvolutionRoot(), skill.location, ctx.sessionID)
```

> `projectId` 不用从 ctx 取——账本靠 `resolveScope` 从 skill 路径 `<root>/<projectId>/skills/<name>` 解析出来，已经有了（X2）。

### 3. 兼容：旧账本缺字段

线上已有账本里的记录没有 `recent_uses`。两处兜底：
- `load`（[`usage.ts:74`](./usage.ts#L74)）读到老记录时，把缺失的 `recent_uses` 补成 `[]`，保证后续 `.push` 不炸。
- `emptyRecord`（[`usage.ts:58`](./usage.ts#L58)）新建记录时初始化 `recent_uses: []`。

→ 升级到本版不会因为老记录缺字段而报错或误删（D18）。

---

## 为什么保持 await、不 fire-and-forget

> 这是一个被问到、用实测拍板的决定。结论：**保持 `await`。**

- **实测开销极小**：账本 `usage.json` 仅 ~1.8KB；一轮「读+解析+写回+原子 rename」实测 **0.337 ms/次**。多记 `recent_uses` 仅加几百字节，量级不变（仍亚毫秒）。
- **不是瓶颈**：`bumpUse` 的 `await` 位于 [skill.ts:69](../../tool/skill.ts#L69)——在 `ctx.ask`（权限弹窗，可能等用户）之后、`ripgrep`（扫 skill 目录文件）之前。这两样才是大头；0.3ms 在它们面前忽略不计，更别提整体夹在一次大模型往返（以秒计）中。
- **fire-and-forget 反而引入风险**：`bumpUse` 是读-改-写。不 await 的并发写会**互相覆盖**（丢 `use_count`/丢事件）；curator 已知有一个并发竞态，裸 fire-and-forget 会加重它；还有「写没落盘就被读」。拿这些风险换看不见的 0.3ms，不划算（D20）。
- **真嫌慢的正解**（目前不需要、YAGNI）：串行化写队列（调用方不等、底层保证不打架），而非裸 fire-and-forget。

---

## 核心不变量

> 在前两份设计文档不变量基础上，新增：

1. **只记不判** — `recent_uses` 不参与任何归档/淘汰决定；归档仍只看 `idle_scans`（D14）。
2. **缓存非真相源** — 会话 DB 是 skill 使用的权威全量记录；`recent_uses` 是近期窗口缓存，允许轻微不一致（D19）。
3. **每次在范围内加载都落一条坐标** — 生产路径有 `sessionId` → 必追加（顾虑 4 数据完整性）。
4. **事件列表有界** — `recent_uses.length ≤ MAX_RECENT_USES`，超出丢最老（D17）。
5. **坐标只存指针不存内容** — 事件里只有 `session_id`+`at`（D16）。
6. **缺字段不炸不误删** — 老账本缺 `recent_uses` 当 `[]` 处理（D18）。
7. **不挡加载、保持 await** — best-effort 吞错；0.3ms 不优化成 fire-and-forget（D20）。

> 沿用前两份文档不变量：归档判据零日历依赖、被用即清零无死亡螺旋、归档可恢复、pinned 跳过、原子写入、`skill_manage` 零触点。

---

## 决策记录

> 编号接续 `IDLE_SCANS_DESIGN.md`（其到 D13 + D-A），本文档新增 D14–D21。

- **D14：本分支只「记坐标」，不做「判好坏 / 淘汰」。** 判断没有现成判据、且依赖先有数据；记录是低风险增量，判断是高风险侵入，分步走。**已与用户对齐。**
- **D15：`UsageRecord` 加 `recent_uses: UseEvent[]`；`bumpUse` 加可选 `sessionId?`。** 增量式，旧字段/旧 2 参调用不动。
- **D16：每条事件只存 `session_id`+`at`，不存 `projectId`、不存会话内容。** projectId 由账本键隐含；会话过程靠 id 去 DB 回查。
- **D17：粒度＝「每次加载记一条」，列表截断到最近 `MAX_RECENT_USES` 条（滑动窗口）。** **已对齐**：上限是有意的「近期窗口」——省 token + 评估只看近期、不被久远旧成绩干扰（用户提出的好处）。同会话多次加载 → 多条同 `session_id` 事件。
- **D18：旧账本缺 `recent_uses` → 当 `[]` 处理（`load` + `emptyRecord` 兜底）。** 升级兼容，防报错/误删。
- **D19：`recent_uses` 是近期窗口缓存，会话 DB 是权威全量源。** 查实 DB 已自动记录每次 skill 调用（[关键前提](#一个关键前提会话-db-已自动记录-skill-调用)）。账本这份为「现成索引/省得每次开 DB」，真要全量历史回 DB。
- **D20：`bumpUse` 保持 `await`，不改 fire-and-forget。** 实测 0.3ms、非瓶颈；fire-and-forget 引入并发丢更新风险，不值（[为什么保持 await](#为什么保持-await不-fire-and-forget)）。
- **D21：本分支不加评估字段（`disposition`/`reviewed_at`）。** 评估是后续工作（导师行189「评估是后边的事」），现在加 = 空占位（YAGNI）。**已与用户对齐**——顺导师「别一次性解决完、先记录」的增量风格。

---

## 开放问题

- **Q-N：`MAX_RECENT_USES` 取多少？** 暂定 **50**、放 `usage.ts` 模块常量（不进 `CuratorConfig`，YAGNI）。50 够覆盖「最近一批会话」做近期评估，且账本不臃肿。**待用户最终拍板数值。**
- **Q-M：要不要连 `message_id` 一起记？** 默认**不记**（YAGNI）。导师用「时间」就能定位到会话里具体哪条 user message（行113）；`ctx.messageID` 现成可取，日后若回溯需精确到「会话里第几步」再加。
- ~~**Q-S：session id 能否定位回会话？**~~ **已查实解决**：能（DB 持久化、skill 调用落库、按 id 可取回）。

> 实现按 YAGNI：只加「记坐标」这一处，核心逻辑走 TDD 先红后绿。

---

## 关键文件速查

| 文件 | 本次职责 | 性质 |
|------|------|:---:|
| [`curator/usage.ts`](./usage.ts#L13) | `UsageRecord` 加 `recent_uses` + `UseEvent` 类型；`bumpUse` 加 `sessionId?` + 追加/截断；`emptyRecord`/`load` 兜底 `[]`；`MAX_RECENT_USES` 常量 | ⚠️ 增量改 |
| [`tool/skill.ts`](../../tool/skill.ts#L69) | `bumpUse(...)` 补传 `ctx.sessionID`（保持 `await`） | ⚠️ 增量改 |
| [`curator/usage.test.ts`](./usage.test.ts) | 加「追加事件 / 滑动窗口截断 / 缺字段兜底 / 无 sessionId」用例；现有用例补断言 `recent_uses` 默认 `[]` | ⚠️ 改测试 |
| [`curator/constants.ts`](./constants.ts) | **不动**（N 是代码常量，非配置项） | — |
| 归档判据 / `idle_scans` / `archiveSkill` / 孤儿自愈 / `shouldRunNow` / `skill_manage` | **不碰** | — |

---

## 复用组件核实（实现前必读）

- **X1：`bumpUse` 调用点全部已知。** grep `bumpUse`：生产代码仅 [`skill.ts:69`](../../tool/skill.ts#L69) 一处；其余 7 处在 `usage.test.ts`/`curator.test.ts`，均为 2 参 `bumpUse(root, loc)` 形式 → `sessionId` 设为**可选第 3 参**，旧调用零破坏。
- **X2：`projectId` 已由 `resolveScope` 提供。** 不需要从 ctx 另取项目 id（D16）。
- **X3：`bumpUse` 的 best-effort 契约不变。** 仍整段 `try/catch` 吞错，记坐标失败绝不影响 skill 加载；保持 `await`（D20）。
- **X4（已查实）：会话 DB 可按 id 检索、已记 skill 调用。** SQLite 每项目一库 `aether-<projectId>.db`，`part` 表 `data` JSON 含 `tool='skill'` + session_id + 时间 + skill 名；按 `session_id` 可取回（[关键前提](#一个关键前提会话-db-已自动记录-skill-调用)）。

---

## 命题清单

> 把全文压成可判定真假的断言，分组、组内按重要度递减。

### PA. 定位与边界
- PA1. 本分支只往账本追加「近期使用坐标」，**不**改归档/淘汰任何行为（D14）。
- PA2. `recent_uses` 是近期窗口缓存，会话 DB 是权威全量源；二者可轻微不一致（D19）。
- PA3. 每次在范围内的 skill 加载（生产路径必带 `sessionId`）→ `recent_uses` 追加一条 `{ session_id, at }`（顾虑 4）。

### PB. 写入机制
- PB1. `bumpUse` 有 `sessionId` → push 一条事件；无则只 `use_count+1`、不记坐标。
- PB2. `recent_uses.length > MAX_RECENT_USES` → 从头部丢最老的，长度恒 ≤ N（D17）。
- PB3. 同一 `session_id` 多次加载 → 多条同 id 事件（每次加载记一条，不去重）。
- PB4. `use_count`/`last_used_at`/`idle_scans` 写入时机与值完全不变。
- PB5. `bumpUse` 保持 `await`（D20）。

### PC. 兼容
- PC1. 老账本记录缺 `recent_uses` → `load` 当 `[]`，`.push` 不炸（D18）。
- PC2. `emptyRecord` 新建记录 `recent_uses` 初始为 `[]`。
- PC3. 旧 2 参 `bumpUse(root, loc)` 调用仍合法（X1）。

### PD. 数据结构
- PD1. `UsageRecord` 含 `recent_uses: UseEvent[]`；`UseEvent = { session_id, at }`（D15）。
- PD2. 不含评估字段 `disposition`/`reviewed_at`（D21）。

### PH. 边界与失败用例（测试必须覆盖）
- PH1. **写→读接力**：连调 `bumpUse` 两次（带不同 session id）→ `load` 回来 `recent_uses` 有 2 条、id/时间对得上（核心接缝）。
- PH2. **滑动窗口**：调 `bumpUse` N+1 次 → `recent_uses` 恰好 N 条、头部最老被挤掉、尾部最新。
- PH3. **缺字段兜底**：手写无 `recent_uses` 的老记录 → `bumpUse` 一次 → 不炸、`recent_uses` 变 1 条。
- PH4. **范围外不记**：非 `<projectId>/skills/` 下 → 不产生任何记录/事件。
- PH5. **无 sessionId**：`bumpUse(root, loc)` 不传 session → `use_count+1` 但 `recent_uses` 仍空。

---

## 测试与红绿里程碑

> 核心逻辑走 TDD（先红后绿、婴儿步）。**每个里程碑独立走红→绿**，交付展示两次跑测输出（红：实现没写时失败；绿：写完通过）。从 `packages/opencode` 目录内跑 `usage.test.ts`。

### ⚠️ 假绿陷阱与依赖顺序

- **S1（写→读接力）是核心接缝、最该先看到红**：真的连调 `bumpUse` 两次再 `load` 回来断言 `recent_uses` 明细——验证「写进事件 → 读得出事件」这条接缝。旧实现没 `recent_uses` 字段，`load` 回来 `undefined` → 断言「有 2 条」自然红。**禁止手填 recent_uses 再只测读**——必须让写和读在测里接力跑（CLAUDE.md 写读接缝铁律）。
- **S2（滑动窗口）有假绿陷阱**：断言要写**恰好 == N** 且**头部最老那条已不在、尾部是最新那条**，双向钉死；写成「长度 ≥ N」会恒真假绿。

### 红绿总览（按依赖排序）

| 次序 | 里程碑 | 红（先写失败测试）| 绿（实现）| 命题/边界 | 接缝 |
|---|---|---|---|---|:---:|
| **S1** | **写→读接力（核心，先停点）** | `bumpUse(root, loc, "ses_A")`、`bumpUse(root, loc, "ses_B")` → `load` → `recent_uses` 恰 2 条、`session_id` 依次 A/B、`at` 非空 | push 事件 | PA3/PB1/PH1 | ★★写读接力 |
| S2 | 滑动窗口截断 | `bumpUse` 跑 `MAX_RECENT_USES+1` 次 → `recent_uses` 恰 N 条、头部最老被挤掉、尾部最新还在 | splice 截断 | PB2/PH2 | ★ |
| S3 | 同会话多次记多条 | 同一 session id 连调 2 次 → 2 条同 id 事件（不去重）| 不去重 | PB3 | |
| S4 | 缺字段兜底 | 手写无 `recent_uses` 的老记录入账本 → `bumpUse` 一次 → 不抛、`recent_uses` 变 1 条 | load/emptyRecord 兜 `[]` | PC1/PH3 | 防崩 |
| S5 | 无 sessionId 不记坐标（防回归）| `bumpUse(root, loc)` 不传 session → `use_count==1` 且 `recent_uses` 为空 | 可选参数分支 | PB1/PH5 | 防回归 |
| S6 | 范围外不记 | 非 `skills/` 下 skill → load 无记录、无事件 | 沿用 resolveScope | PH4 | |

> 顺序：S1 先停点（接缝跑通）。S2 验有界。S3 验粒度。S4/S5 防崩/防回归。S6 沿用既有边界。

### 收尾验证（实现完成后）

- `bun --cwd packages/opencode typecheck`，贴结果。
- 从 `packages/opencode` 跑 `usage.test.ts`，贴 **S1 / S2** 的「红→绿」两次输出。
- 现有 `curator.test.ts`（归档判据那批）不受影响，回归跑一遍确认全绿。
- 归档判据 / `idle_scans` / `skill_manage` 一行不改。

---

## 范围说明

本块（「记会话」）承接组会顾虑 3、4，**但本分支只做其中第一步**：

1. **【本分支】记近期坐标**：每次用 skill 把 `session id + 时间` 攒进账本 `recent_uses`（近期窗口缓存/索引）。只攒索引，不判好坏、不淘汰。
2. **【后续】机械检索 + 拼上下文**：评估某 skill 时，从账本拿 projectId → 开那一个项目库 `aether-<projectId>.db` → **机械（确定性代码）**查出使用位置 + 拼出每处上下文窗口。**不让 AI 自己钻 DB**（已验证：`part`+`message` 两表一条 SQL 就能把一次 skill 调用前后的会话过程按顺序拉出来）。
3. **【后续】AI 判好坏 + 据判断删/降权**：把机械拼好的上下文喂 AI，判断「这个被频繁调的 skill 是正面还是负面」→ 留/降权/归档（顾虑 3）。评估专门批量做，不每次都做（导师行189）。

> 另：组会还提到「给 skill 发 ID（git commit 时分配），解决靠名字重名」（导师注「暂时不关键」），与本块无关，不在此。

---

## 用户体验

| | 体验 |
|---|---|
| **本分支前** | 账本只知道每个 skill「一共用过几次、最近一次什么时候」，**不知道**它具体在哪些会话里被用过；想回头评估某个 skill 当初有没有真帮上忙，curator 手里没有现成的「去翻哪几次会话」的索引。|
| **本分支后** | 账本额外记下每个 skill「最近若干次分别在哪次会话、什么时候被用」。对你来说：**为日后「回看某个 skill 近期表现好不好、该不该留」备好了一份现成的近期索引**——评估时只看近期、省 token，也不会被它很久以前的旧表现误导。|

**边界（诚实说清）**：① 本分支**纯后台记录，界面无任何变化、无新功能**——你现在看不到、也用不到这些坐标，它只是被悄悄存进账本当索引。② 本分支**不会自动判断或删除任何 skill**——「烂 skill 反被保留」要等后续「机械检索 + AI 判好坏 + 删/降权」做完才治得了。③ 这份 `recent_uses` 是**近期窗口缓存**，全量权威记录在会话 DB；真要完整历史，回 DB 查。
