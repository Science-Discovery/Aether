# Aether Curator 归档判据改造 — 从「按天数」到「连续空闲巡检数」设计文档

> 状态：**设计草案 v1**，待团队对齐后进入实现（实现走 TDD）。
> 读者：团队开发者 + 组会评审。
> 出处：2026-06-12 组会，导师对 curator 当前的「90 天没用就归档」提意见，要求改用「相对使用次数」（转写 `20260612_1432_speakers.txt` 行90/行93）。
> 关联：本目录 [`CURATOR_DESIGN.md`](./CURATOR_DESIGN.md)（curator 整体设计）。本文档**只改归档判据这一处**，其余（范围、拉模式、归档不删、触发门控）全部沿用，不重述。

把 curator（skill 自动归档机制）决定「该不该归档」的尺子，从「**现实世界过了多少天没用**」换成「**连续多少次巡检都没被用过**」（`idle_scans`）。**调度间隔（7 天跑一次巡检）保持不动**——导师担心的是「判据」绑死时间，不是「调度」。判据里不再有任何日历日期，因此改错系统时间不会成片误删；且每个 skill 只跟自己比、被用一次清零，不存在「排名垫底被删光」的死亡螺旋。

---

## 目录

- [设计原则](#设计原则)
- [解决了导师的什么顾虑](#解决了导师的什么顾虑)
- [与现状（CURATOR_DESIGN.md）的差异](#与现状curator_designmd的差异)
- [为什么不用「相对排名砍末位」](#为什么不用相对排名砍末位)
- [数据结构](#数据结构)
- [核心机制详解](#核心机制详解)
  - [1. 判据：连续空闲巡检数](#1-判据连续空闲巡检数)
  - [2. 兼容：旧账本缺字段建基线](#2-兼容旧账本缺字段建基线)
- [核心不变量](#核心不变量)
- [决策记录](#决策记录)
- [开放问题](#开放问题)
- [关键文件速查](#关键文件速查)
- [命题清单](#命题清单)
- [测试与红绿里程碑](#测试与红绿里程碑)
- [范围说明](#范围说明)
- [用户体验](#用户体验)

---

## 设计原则

1. **判据去时间化，但调度不动**：归档「判据」（该不该归档）改成数巡检次数，零日历依赖；归档「调度」（多久跑一次）仍是 7 天间隔。两者是两件事，导师的顾虑只指向前者。
2. **每个 skill 只跟自己比**：判据是「这个 skill 自己连续几次没被碰」，不跟别的 skill 比排名 → 不会死亡螺旋（D11）。
3. **最小改动、贴 Hermes 结构**：在现有 `applyAutomaticTransitions` 框架内换掉判据那段，不引入「使用率（次数÷总会话数）」那种要加分母、改动外溢的重方案（D10）。
4. **改动局限 `curator/` 目录**：要改的字段全部只被 `curator/` 内部引用，外部零调用点（已 grep 核实，见 X1）。
5. **不误伤存量**：线上已有账本无新字段，首次巡检当基线、不判归档（D13）。

### 对旧文件的修改

> 每处标注 **侵入式**（改了旧行为，有回归风险）还是 **增量式**（只加新调用）。

| 旧文件:位置 | 改什么 | 性质 | 依据 |
|---|---|:---:|---|
| [`curator.ts :: applyAutomaticTransitions`](./curator.ts#L146) | 把 `daysSince`（按天）那段判据换成 `idle_scans`（按巡检次数）| **侵入式**（改归档行为，但正是本次目标）| D10 |
| [`constants.ts`](./constants.ts#L5) | `staleAfterDays`/`archiveAfterDays` → `staleAfterIdleScans`/`archiveAfterIdleScans`；`intervalHours` 不动 | **侵入式**（字段改名，仅 curator 内引用）| D10 |
| [`usage.ts :: UsageRecord`](./usage.ts#L13) | 加 `use_count_at_last_scan`、`idle_scans` 两字段 + `emptyRecord` 初始化 | **增量式**（加字段，旧字段不动）| D12 |

> **不动**：`bumpUse`（计数写入）、`archiveSkill`/`restoreSkill`（归档/恢复）、孤儿自愈、pinned 跳过、`shouldRunNow`（7 天门控）、`skill_manage`（仍零触点）——全部沿用 `CURATOR_DESIGN.md`。

---

## 解决了导师的什么顾虑

导师围绕 curator / skill 进化的顾虑**一共四条**。**本分支（归档判据改造）只解决前两条；顾虑 3、4 本分支不覆盖，属第二块「记会话」工作**（见[范围说明](#范围说明)）。下面分开列，避免误以为本版改动一并解决了它们。

### 本分支解决的（顾虑 1、2）

| # | 导师的顾虑 | 出处 | 本方案怎么解决 |
|---|---|---|---|
| **顾虑 1** | **硬时间标签不公平**：有人一月用一次、有人一天用十几次，统一卡「N 天没用」对低频用户不公 | 转写 行90 | 判据改成「这个 skill **自己**连续几次巡检没被碰」，与使用频率高低无关，一视同仁；且巡检本身要「用了 app 才触发」，用得少 → 巡检少 → skill 不会无辜变老 |
| **顾虑 2** | **绝对时间不安全**：电脑系统时间设错（年份拉到 2027）会一次性误删一大片 | 转写 行93（导师真正在意的灾难）| 判据里**没有日历日期**。系统时间跳一下，最多多触发一次巡检、让 `idle_scans` +1，**绝不成片误删** |

**判定标准**：导师给的解法原话是「改用相对使用次数，比较**安全**」——他要的是安全，不是要个复杂算法。**只要这两条解掉，本分支就达标**，不必上「使用率」那套重方案。

### 本分支【不】解决、留给第二块「记会话」的（顾虑 3、4）

> ⚠️ 这两条本分支不碰。列在此处是为把导师的完整意图记全、并说清「为什么 idle_scans 治不了它们」。

| # | 导师的顾虑 | 出处 | 为什么本分支治不了 / 真正的解药 |
|---|---|---|---|
| **顾虑 3** | **「触发灵敏但啥也没干」的烂 skill 反被保留**：一个差劲 skill 只要触发特别灵敏、被一直调用，就显得「很重要」、被提权、再也不删 → 进化方向跑偏成「更多地展示自己」而非「把事做好」。被调用多 ≠ 该留；调用后啥也没做成 → 该删 | 转写 行100、行101 | **idle_scans 治不了**：这种 skill 一直被触发 → `use_count` 一直涨 → `idle_scans` 永远是 0 → **永不归档**，照样赖着。解药是「记会话 + 回看它当初有没有真起作用」，靠删/降权而非靠「没用」淘汰 |
| **顾虑 4** | **没法回溯评估**：想改进/进化一个 skill 时，得回去看它当初在那十次会话里表现好不好；不重跑、只看当初的会话过程就能判断它有没有真起作用。没有「在哪被用过」的记录，这一步无从谈起——「没有数据，skill 进化无从谈起」 | 转写 行99、行102、行111、行110 | **本分支没产出这份数据**。解药 = 第二块工作：每次用 skill 记下 project id + session id + 时间，供日后回溯。导师强调「先把使用历史记全，再往后做」 |

**判定标准（顾虑 3、4）**：达标 = **能记录并回溯「每个 skill 在哪个会话被用过」**，从而判断它当初有没有真起作用——这是第二块「记会话」的目标，不在本分支。

---

## 与现状（CURATOR_DESIGN.md）的差异

| | 现状（已发布 / CURATOR_DESIGN.md）| 本方案 |
|---|---|---|
| 归档判据 | `now - max(last_used_at, 文件mtime) ≥ archiveAfterDays(90 天)` | `idle_scans ≥ archiveAfterIdleScans` |
| stale 判据 | 同上 ≥ staleAfterDays(30 天) | `idle_scans ≥ staleAfterIdleScans` |
| 「被用过」怎么判 | 看活动锚点时间是否新 | 本轮 `use_count` 是否比上轮巡检时大 |
| 「编辑文件」算活动吗 | **算**（mtime 新 → 不归档）| **默认不算**（只认被加载/使用，见 Q-A）|
| 调度间隔 | 7 天（`intervalHours`）| **不变** |
| 时间安全性 | ❌ 改错系统时间会成片误删 | ✅ 不受系统时间影响 |

---

## 为什么不用「相对排名砍末位」

一个直觉的「相对使用次数」实现是「每次巡检删掉使用次数排末位的 skill」——**这个方案错的，不能用**：

- 相对排名**永远有个末位**。只要规则是「砍末位」，哪怕一批 skill 全都有用、都常被调用，也会每轮砍掉垫底的，最后只剩使用最多的那一个 → **有用的 skill 也被删光**（死亡螺旋）。
- 根因：「排名」是比出来的、没有下限；判据必须让每个 skill **凭自己的使用情况**活，而不是跟别人比高低。

`idle_scans` 正是「只跟自己比」：被用一次就清零，**只要还在用就永不归档**（D11）。

---

## 数据结构

### UsageRecord — 单个 skill 的记录（落盘 `curator/usage.json`，key = `<projectId>/<name>`）

```ts
interface UsageRecord {
  projectId: string
  name: string
  location: string
  use_count: number              // 沿用：被加载使用的累计次数（bumpUse 累加）
  use_count_at_last_scan: number // 【新增】上一次巡检时的 use_count，用于比「这轮有没有新增使用」
  idle_scans: number             // 【新增】连续多少次巡检没被用过；被用一次清零
  last_used_at: string | null    // 沿用：保留作信息/后续 session 工作用，不再参与归档判据
  state: "active" | "stale" | "archived"
  pinned: boolean
  archived_at: string | null
}
```

**逐字段解释**（▲=本次新增，其余沿用 `CURATOR_DESIGN.md`）：

| 字段 | 是什么 | 例子 | 改/不改 |
|---|---|---|:---:|
| `projectId` | 这个 skill 属于哪个项目（项目的 hex 哈希 id） | `"a3f91c8e..."` | 不改 |
| `name` | skill 的名字（SKILL.md frontmatter 里的 `name`） | `"qft-helper"` | 不改 |
| `location` | skill 文件夹的绝对路径，归档/恢复时靠它定位往哪搬 | `".../skill-evolution/a3f91c8e/skills/qft-helper"` | 不改 |
| `use_count` | 被加载使用的**累计**次数（每次 agent 加载它，`bumpUse` +1） | `7`（一共被用过 7 次） | 不改 |
| ▲ `use_count_at_last_scan` | **上一次巡检时** `use_count` 的快照，下一轮拿它跟当前 `use_count` 比，看「这轮有没有新增使用」 | `7`（上轮也是 7 → 说明这轮没被用过） | 新增 |
| ▲ `idle_scans` | **连续**多少次巡检都没被用过的计数；被用一次就清零 | `2`（连着 2 次巡检没人用它） | 新增 |
| `last_used_at` | 最后一次被加载的时间（UTC ISO）；从未用过为 `null`。**本方案保留作信息，但不再参与归档判据** | `"2026-05-01T08:30:00.000Z"` | 不改（降级为纯信息） |
| `state` | 当前生命周期状态：`active`（活跃）/ `stale`（冷落，仅标记）/ `archived`（已归档搬走） | `"active"` | 不改 |
| `pinned` | 钉住：为 true 则跳过全部自动流转，永不被归档（只读，无设置入口） | `false` | 不改 |
| `archived_at` | 被归档的时间；未归档为 `null` | `null` | 不改 |

**一条完整记录的例子**（`qft-helper` 已连着 2 次巡检没被用，还在活跃、离 stale(4 次) 还差 2 次）：

```json
"a3f91c8e/qft-helper": {
  "projectId": "a3f91c8e",
  "name": "qft-helper",
  "location": "/home/zheng/.local/share/aether/skill-evolution/a3f91c8e/skills/qft-helper",
  "use_count": 7,
  "use_count_at_last_scan": 7,
  "idle_scans": 2,
  "last_used_at": "2026-05-01T08:30:00.000Z",
  "state": "active",
  "pinned": false,
  "archived_at": null
}
```

> 读法：`use_count(7) == use_count_at_last_scan(7)` → 上一轮到这一轮没新增使用 → 这轮 `idle_scans` 会从 2 累加到 3。若哪轮 `use_count` 涨到 8 → `idle_scans` 立刻清零回 0。

### CuratorConfig — 字段改名（[`constants.ts`](./constants.ts#L1)）

```ts
interface CuratorConfig {
  enabled: boolean
  intervalHours: number          // 沿用：两次巡检最小间隔（默认 168 = 7 天），不动
  staleAfterIdleScans: number    // 【改名自 staleAfterDays】连续几次空闲巡检标 stale
  archiveAfterIdleScans: number  // 【改名自 archiveAfterDays】连续几次空闲巡检归档
}
```

可调参数（**已定：选项 A**，Q-B）：

| 参数 | 含义 | **取值（选项 A）** |
|---|---|---|
| `intervalHours` | 巡检最小间隔 | 168（7 天，不动） |
| `staleAfterIdleScans` | 连续几次空闲 → 标 stale（仅贴标签，不搬文件） | **4**（≈30 天） |
| `archiveAfterIdleScans` | 连续几次空闲 → 归档（搬到 archive/，加载器扫不到，可恢复） | **12**（≈90 天） |

> 选 A 是为了让行为变化最小、沿用旧 30/90 天的节奏感。（备选 B `stale=2 / archive=4` 更激进、约 1 个月就归档，本次不采用。）

### stale 和 archive 的区别（两道关卡）

同一条「衰老」路上**先到 stale、再到 archive**，动作完全不同：

| | 到 `staleAfterIdleScans`(4≈30天) | 到 `archiveAfterIdleScans`(12≈90天) |
|---|---|---|
| 干什么 | 账本里**贴个「冷落」标签** `state="stale"` | **把 skill 文件夹搬到** `<projectId>/archive/` |
| 文件 | 原地没动 | 搬走（可恢复，非删） |
| 还能加载用吗 | 能，照常进系统提示词 | 不能，加载器扫不到 |
| 自动复活 | 能（再被用一次退回 active） | 不会自动（手动 `restoreSkill` 恢复） |

> stale = 黄牌警告（只标记、不动文件、还能用）；archive = 真请出场（搬走、不再加载、可恢复）。stale 是 archive 前的缓冲带。按 `CURATOR_DESIGN.md` Q3，stale 目前除「能复活」外无其它后果（不隐藏、不降权）。

---

## 核心机制详解

### 1. 判据：连续空闲巡检数

`applyAutomaticTransitions()` 在 7 天门控通过后跑，对每个 in-scope skill：

```
① 账本没这条 → 补一条（建基线：use_count_at_last_scan=当前 use_count，idle_scans=0），本轮不判归档（见 §2）
② pinned==true → 跳过
③ 本轮 use_count > use_count_at_last_scan ?
     是（这轮被用过） → idle_scans = 0；若是 stale → 复活成 active
     否（这轮没用）   → idle_scans += 1
                        idle_scans ≥ archiveAfterIdleScans 且 非archived → archiveSkill()，state=archived
                        idle_scans ≥ staleAfterIdleScans  且 active     → state=stale
④ use_count_at_last_scan = 当前 use_count   （为下一轮留基线）
对账本里每条：location 目录已不存在 → 孤儿自愈（沿用，不变）
写 lastRunAt=now、runCount+1
```

- 「被用过」= `use_count`（被加载时由 `bumpUse` 累加）比上一轮巡检时大。
- `now` 参数保留——归档时间戳 `archived_at` 仍要用它，只是不再拿它算「过了几天」。

#### 「90 天」那块旧代码怎么处理（改前 → 改后）

旧代码里「90」只活在**一处**：判断「过了多少天该归档」那行。处理 = 整段按天算的逻辑替换成按次数算，`90/30` 两个常量改名成次数。

**改前**（[`curator.ts:146-158`](./curator.ts#L146)，现线上跑的）：
```ts
const lastUsedMs = rec.last_used_at ? new Date(rec.last_used_at).getTime() : -Infinity
const daysSince = (now.getTime() - Math.max(lastUsedMs, s.mtimeMs)) / DAY   // ← 算「过了几天」

if (daysSince >= config.archiveAfterDays && rec.state !== "archived") {     // ← archiveAfterDays = 90
  if (await Usage.archiveSkill(root, s.key, now)) counts.archived++
} else if (daysSince >= config.staleAfterDays && rec.state === "active") {  // ← staleAfterDays = 30
  await Usage.setState(root, s.key, "stale", now); counts.marked_stale++
} else if (daysSince < config.staleAfterDays && rec.state === "stale") {
  await Usage.setState(root, s.key, "active", now); counts.reactivated++
}
```

**改后**（换成数次数；伪代码，落地时按现有 setState/archiveSkill 接口）：
```ts
const used = rec.use_count > (rec.use_count_at_last_scan ?? rec.use_count)  // ← 这轮被用过没
if (used) {
  rec.idle_scans = 0                                       // 被用 → 清零；若 stale 则复活
  if (rec.state === "stale") { /* setState active */ counts.reactivated++ }
} else {
  rec.idle_scans = (rec.idle_scans ?? 0) + 1               // 没用 → 攒一次
  if (rec.idle_scans >= config.archiveAfterIdleScans && rec.state !== "archived") {  // ← 12
    /* archiveSkill */ counts.archived++
  } else if (rec.idle_scans >= config.staleAfterIdleScans && rec.state === "active") {  // ← 4
    /* setState stale */ counts.marked_stale++
  }
}
rec.use_count_at_last_scan = rec.use_count                 // 留给下一轮当基线
```

三处被「处理」掉：
- ① `daysSince`（算过了几天）整段删除——**这就是「90 天」的本体**。
- ② `Math.max(lastUsedMs, s.mtimeMs)` 删除——`last_used_at`（上次使用时间）与 `s.mtimeMs`（文件改动时间）**不再参与归档决定**（`last_used_at` 字段保留作信息，见数据结构表）。
- ③ `DAY` 常量（[`curator.ts:122`](./curator.ts#L122)）删除；`archiveAfterDays:90`/`staleAfterDays:30` 改名为 `archiveAfterIdleScans:12`/`staleAfterIdleScans:4`（含义从「天」变「巡检次数」）。

### 2. 兼容：旧账本缺字段建基线

线上已有账本里的记录没有 `use_count_at_last_scan`/`idle_scans`。首次巡检读到这种记录：把缺失的 `use_count_at_last_scan` 视为「当前 use_count」、`idle_scans` 视为 0（建基线），**这一轮不判归档**。从第二轮起才正常累加。→ 升级不会因为缺字段误删任何人（D13）。

---

## 核心不变量

> 在 `CURATOR_DESIGN.md` 8 条不变量基础上，新增/调整：

1. **归档判据零日历依赖** — 只看 `idle_scans`，改系统时间不影响判据（顾虑 2）。
2. **被用一次即清零，永不死亡螺旋** — 还在用的 skill 不会被归档，与别的 skill 用得多频繁无关（顾虑 1 / D11）。
3. **idle_scans 每次巡检最多 +1** — 系统时间跳变最多多触发一次巡检，单 skill 计数最多 +1，不成片。
4. **缺字段建基线、不误删** — 旧账本首次巡检只立基线（D13）。
5. **调度仍是 7 天间隔** — `shouldRunNow` 逻辑与 `intervalHours` 完全不动。

> 沿用 `CURATOR_DESIGN.md` 不变量：归档可恢复、pinned 跳过、首次推迟、计数最优努力、原子写入、`skill_manage` 零触点。

---

## 决策记录

> 编号接续 `CURATOR_DESIGN.md`（其到 D8），本文档新增 D10–D13。

- **D10：判据改 `idle_scans`（连续空闲巡检数），不用「使用率」。** 「使用率 = 次数 ÷ 总会话数」要引入会话总数当分母、改动外溢、偏离 Hermes 结构；`idle_scans` 在现有框架内最小改动，同样解掉两条顾虑。**待用户拍板。**
- **D11：判据「只跟自己比」，不做相对排名。** 排名砍末位会死亡螺旋（删光有用 skill）；`idle_scans` 被用即清零，每个 skill 凭自己存活。
- **D12：`UsageRecord` 加 `use_count_at_last_scan` + `idle_scans` 两字段，不动旧字段。** 增量式；`last_used_at` 保留作信息但不再参与判据。
- **D13：旧账本缺字段 → 首次巡检建基线、不判归档。** 升级兼容，防误删存量。
- **D-A（待定）：「编辑 SKILL.md」是否算活动？** 现状算（mtime 新→不归档）。本方案默认**不算**，只认被加载/使用——导师要砍的正是「触发灵敏但啥也没干」的 skill，「光改不用」属此类。保留则需多存「上次见到的文件 mtime」字段、编辑过一并清零 `idle_scans`。**见 Q-A。**

---

## 开放问题

- **Q-A：「编辑 skill」算不算活动？** 默认**不算**（只认使用，D-A）。风险低：新建/在改的 skill `idle_scans` 从 0 起，要连熬好几周不被加载才归档，正常开发期都会加载它。要保留「编辑也算」则多加一字段。**待用户拍板。**
- ~~**Q-B：两个阈值取值？**~~ **已定：选项 A `stale=4 / archive=12`（≈30/90 天，行为变化最小）。** 备选 B（更激进、≈1 个月归档）不采用。
- **Q-C：`idle_scans` 巡检节奏受「用 app 才触发」影响。** 用得越少，巡检越稀疏，归档越慢——这正是顾虑 1 想要的「对低频用户公平」，**视为特性，不做修正**。

> 实现按 YAGNI：只改判据这一处，核心逻辑走 TDD 先红后绿。

---

## 关键文件速查

| 文件 | 本次职责 | 性质 |
|------|------|:---:|
| [`curator/curator.ts`](./curator.ts#L146) | `applyAutomaticTransitions` 判据段：`daysSince` → `idle_scans` 算法 | ⚠️ 侵入改 |
| [`curator/constants.ts`](./constants.ts#L1) | 配置字段改名：`*AfterDays` → `*AfterIdleScans`；`intervalHours` 不动 | ⚠️ 侵入改 |
| [`curator/usage.ts`](./usage.ts#L13) | `UsageRecord` 加两字段 + `emptyRecord` 初始化 | ⚠️ 增量改 |
| [`curator/curator.test.ts`](./curator.test.ts) | 按天造场景的用例改成「连跑 N 次巡检」/ 预置 `idle_scans`；`shouldRunNow` 那批不动 | ⚠️ 改测试 |
| [`curator/usage.test.ts`](./usage.test.ts) | 核对新字段默认值不破坏旧用例 | ♻️ 核对 |
| [`CURATOR_DESIGN.md`](./CURATOR_DESIGN.md) | 同步更新判据描述 | 📄 文档 |
| `bumpUse` / `archiveSkill` / `restoreSkill` / 孤儿自愈 / `shouldRunNow` | **不碰** | — |

---

## 复用组件核实（实现前必读）

- **X1：要改的字段外部零调用点。** `grep staleAfterDays\|archiveAfterDays` 与 `UsageRecord` 引用均只落在 `curator/` 内（constants/curator/usage + 两测试），无任何外部 caller → 改名/加字段不破坏外部。
- **X2：配置块是死配置，改名安全。** [`hook.ts:57`](../hook.ts#L57) 调 `maybeRun` 时只传 `{ ...DEFAULT_CURATOR_CONFIG, enabled }`，**不读** `~/.config/aether/aether.jsonc` 里的 `curator` 块（其中的 `intervalHours`/`*AfterDays` 从不被读）→ 字段改名不影响任何运行时配置读取。
- **X3：`bumpUse` 写 `use_count` 的路径不变。** 判据改造只读 `use_count`，不改其写入时机（仍在 skill 加载工具里 +1），故计数侧零改动。

---

## 命题清单

> 把全文压成可判定真假的断言，分组、组内按重要度递减。

### PA. 定位与边界
- PA1. 只改「归档判据」一处；调度（7 天间隔）、归档/恢复、孤儿自愈、pinned、`skill_manage` 零触点全部沿用。
- PA2. 判据里无任何日历日期；仅依赖 `idle_scans`（顾虑 2）。
- PA3. 要改字段外部零调用点，改动局限 `curator/`（X1）。

### PB. 判据算法
- PB1. 本轮 `use_count > use_count_at_last_scan` → `idle_scans=0`；否则 `idle_scans+1`。
- PB2. `idle_scans ≥ archiveAfterIdleScans` 且非 archived → `archiveSkill` + state=archived。
- PB3. `idle_scans ≥ staleAfterIdleScans` 且 active → state=stale。
- PB4. 本轮被用过且当前 stale → 复活 active（`idle_scans` 同时清零）。
- PB5. 每轮末 `use_count_at_last_scan = 当前 use_count`（留下一轮基线）。
- PB6. pinned → 跳过全部流转（沿用）。

### PC. 安全与兼容
- PC1. 系统时间跳变 → 单 skill `idle_scans` 最多 +1，不成片误删（顾虑 2 / 不变量 3）。
- PC2. 被用一次即清零 → 还在用的 skill 永不归档，无死亡螺旋（顾虑 1 / D11）。
- PC3. 旧账本缺 `use_count_at_last_scan`/`idle_scans` → 首次巡检建基线、不判归档（D13）。
- PC4. 「编辑文件」默认不算活动（D-A / Q-A）。

### PD. 数据结构
- PD1. `UsageRecord` 含 `use_count_at_last_scan`、`idle_scans`（D12）。
- PD2. `CuratorConfig` 字段为 `staleAfterIdleScans`/`archiveAfterIdleScans`；`intervalHours` 保留（D10）。

### PH. 边界与失败用例（测试必须覆盖）
- PH1. 连续未用满 N 次才归档：连跑 N-1 次不归档、第 N 次归档（核心接缝）。
- PH2. 中途被用：第 k 轮 use_count 增长 → `idle_scans` 清零、不归档。
- PH3. pinned：`idle_scans` 爆表仍 active。
- PH4. 旧账本缺字段：首次巡检不归档、只建基线。
- PH5. 跨项目同名：两项目各有 `foo`，各算各的 `idle_scans`。

---

## 测试与红绿里程碑

> 核心逻辑走 TDD（先红后绿、婴儿步）。**每个里程碑独立走红→绿**，交付展示两次跑测输出（红：实现没写时失败；绿：写完通过）。从 `packages/opencode` 目录内跑。

### ⚠️ 假绿陷阱与依赖顺序

- **N1（连续 N 次才归档）是核心接缝、先停点、最该先看到红**——它真连跑 N 次 `applyAutomaticTransitions`、不手填中间 `idle_scans`，证明「上一轮写 `use_count_at_last_scan` → 下一轮读它判增长」这条写读接力跑得通。旧实现按天数判，连跑 N 次也不会归档（mtime 不变）→ 自然红。
- **N3（pinned）/ N4（缺字段不误删）有假绿陷阱**：若归档完全不工作，「断言没被归档」会恰好成立而假绿 → 必须排在 N1 之后，红来自「普通的会被归档、而 pinned/缺字段的没被」的对比。

### 红绿总览（按依赖排序）

| 次序 | 里程碑 | 红（先写失败测试）| 绿（实现）| 命题/边界 | 接缝 |
|---|---|---|---|---|:---:|
| **N1** | **连续 N 次才归档（核心，先停点）** | 一个 skill，连跑 `archiveAfterIdleScans` 次巡检、期间 use_count 不增长 → 前 N-1 次未归档、第 N 次移进 `<projectId>/archive/`、archived | `idle_scans` 累加 + 阈值归档 | PB1/PB2/PH1 | ★★写读接力 |
| N2 | 中途被用清零 | 攒到 N-1 次后，把该 skill 的 use_count +1，再跑一次 → `idle_scans` 归 0、未归档 | use_count 比较清零 | PB1/PB4/PH2 | ★写读接力 |
| N3 | 标 stale | 连跑 `staleAfterIdleScans` 次未用 → state=stale、文件还在（未到归档阈值）| 阈值标 stale | PB3 | |
| N4 | stale 复活 | stale 后被用一次 → 退回 active | PB4 复活分支 | PB4 | |
| N5 | pinned 跳过（排 N1 后）| 写账本 pinned:true、`idle_scans` 预置超阈值 → 跑 → 仍 active | pinned 跳过 | PB6/PH3 | 防假绿 |
| N6 | 旧账本缺字段不误删（排 N1 后）| 写账本一条无 `idle_scans`/`use_count_at_last_scan` 的旧记录 → 首次跑 → 仍 active、字段被补基线 | 缺字段建基线 | PC3/PH4 | 防假绿 |
| N7 | 跨项目同名各算各 | proj1/foo 攒满阈值、proj2/foo idle_scans=0 → 跑 → 仅 proj1/foo 归档 | 复合键独立累加 | PH5 | |

> 顺序：N1 先停点（接缝跑通）。N2 验「清零」防死亡螺旋。N3/N4 验三态流转。N5/N6 强制排 N1 后防假绿。N7 验复合键。
> **改测试要点**：现有 `curator.test.ts` 里靠 `mtimeAgoMs`（如 M11 的 100*DAY）制造「该归档」的用例要改写——归档不再由 mtime 触发，而由「连跑多次 / 预置 `idle_scans`」触发；`shouldRunNow` 那批（M6–M9）测调度间隔，与本次无关，**保持不动**。

### 收尾验证（实现完成后）

- `bun --cwd packages/opencode typecheck`，贴结果。
- 从 `packages/opencode` 跑 `curator.test.ts` + `usage.test.ts`，贴 N1/N6 的「红→绿」两次输出。
- `skill_manage` 一行不改；`bumpUse` 写入路径不改，无需额外回归。

---

## 范围说明

本分支（`feat/curator-relative-usage`）**只做归档判据改造**（解决顾虑 1、2）。组会还要求的另外两项是**后续独立工作**，不在本分支：

1. **记会话**（承接顾虑 3、4）：每次用 skill 记下 project id + session id + 时间，供 skill 进化回溯「它当初有没有真起作用」，进而识别并淘汰「触发灵敏但啥也没干」的烂 skill（转写 行99/102/111；行113）。这是顾虑 3、4 的真正解药——靠「回看表现 + 删/降权」，而非靠本分支的「没用就归档」。
2. **给 skill 发 ID**（git commit 时分配），解决靠名字重名问题（转写 行103/行105；导师注明「暂时不关键」）。

---

## 用户体验

| | 体验 |
|---|---|
| **改造前（已发布）** | 归档按「现实过了 90 天」算。后果：① 电脑时间设错（年份拉错）可能一次性误删一大片 skill；② 一月才用一次的低频用户，skill 容易被按日历误判成「没用」。|
| **改造后** | 归档按「连续多少次巡检没被用过」算。对你来说：① **再也不会因为系统时间设错而被成片误删**；② 你用得少、巡检就少，**冷门但你偶尔要用的 skill 不会被无辜清掉**；③ 真正连着一个多月（默认）你用 app 都没碰过的 skill，才会被悄悄挪进可恢复的归档区。|

**边界（诚实说清）**：仍**无界面、无通知**，后台静默发生；用户可直接感知的只有「技能列表保持干净、且不再出现莫名其妙的误删」。
