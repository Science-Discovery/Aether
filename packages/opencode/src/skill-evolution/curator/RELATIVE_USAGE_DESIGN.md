# Curator 归档判据 — 「相对调用占比 + 出生曝光窗口」设计文档

> 状态：**设计草案 v1**，待团队 / 导师对齐后进入实现（实现走 TDD）。
> 读者：团队开发者 + 组会评审 + 照本实现的人（含 yolo 沙盒会话——它没有讨论上下文，本文档即唯一说明书）。
> 出处：2026-06-16 周会，导师否掉「按固定时间归档」，要求改成**按调用占比**判归档（见 `/home/zheng/code/transcribe/2026-06-16/skill归档机制分析-2026-06-16.md` 的红线 R1/R2、军令 M1/M2）。会后与用户对齐：用「出生水位 + 曝光窗口」给新建 skill 一段公平试用期，且**用调用量计、不用天数计**，以免再踩固定时间红线。
> 关联：本目录 [`CURATOR_DESIGN.md`](./CURATOR_DESIGN.md)（curator 整体设计）、[`SESSION_USAGE_DESIGN.md`](./SESSION_USAGE_DESIGN.md)（`recent_uses` 近期使用坐标，**已实现**）。本文档**只改「归档判据」这一块**——调度（多久跑一次）、孤儿清理、钉住保护、`recent_uses` 记录、归档搬移动作全部沿用，不重述。
>
> **基线说明（重要）**：本文档基于当前分支的**真实代码**，已 `git diff upstream/dev..HEAD` 核实——`constants.ts` / `curator.ts` 相对上游**零改动**，归档判据是**最原始的「按日历天数」**（`archiveAfterDays=90` / `staleAfterDays=30`）；`usage.ts` 仅由 [`SESSION_USAGE_DESIGN.md`](./SESSION_USAGE_DESIGN.md) 那个 commit 加了 `recent_uses`。**本分支从未引入过 `idle_scans`（曾有一个改 idle_scans 的 commit 已被完全丢弃，当它不存在）**，故 `SESSION_USAGE_DESIGN.md` 文中残留的 `idle_scans` / `IDLE_SCANS_DESIGN.md` 引用对当前代码无效——本文档替换的是更早的「按日历天数」判据，不涉及 idle_scans。

---

## 目录

- [设计原则](#设计原则)
- [解决了什么问题](#解决了什么问题)
- [现状 → 改后](#现状--改后)
- [对旧文件的修改](#对旧文件的修改)
- [核心机制详解](#核心机制详解)
  - [1. 出生水位 born_at_project_total](#1-出生水位-born_at_project_total)
  - [2. 曝光窗口 + 试用期闸门](#2-曝光窗口--试用期闸门)
  - [3. 占比判归档](#3-占比判归档)
- [数值走查（对齐导师的例子）](#数值走查对齐导师的例子)
- [格式样例](#格式样例)
- [核心不变量](#核心不变量)
- [决策记录](#决策记录)
- [开放问题](#开放问题)
- [关键文件速查](#关键文件速查)
- [复用组件核实（实现前必读）](#复用组件核实实现前必读)
- [命题清单](#命题清单)
- [测试与红绿里程碑](#测试与红绿里程碑)
- [范围说明](#范围说明)
- [用户体验](#用户体验)

---

## 设计原则

1. **判据只看「相对调用量」，绝不看时间**：归档与否，只由"某 skill 的调用占比"决定，不掺任何"几天没用"的口径。这是导师军令 M1（"归档判据不准用固定时间"）的硬约束——连保护新 skill 的"试用期"也用**调用次数**计、不用天数计。
2. **绝对低占比截断，不是删末位**：占比低于阈值才归档；若所有 skill 占比都在阈值之上，**一个都不归档**（导师军令 M2）。不存在"每轮把当前用得最少的那个删掉"。
3. **新 skill 有公平试用期**：新建 skill 占比天然≈0，不能一出生就被秒归档。给每个 skill 一段"出生后曝光窗口"，窗口没满之前不判——窗口用调用量度量（原则 1）。
4. **最小改动、贴现有结构**：只改 [`curator.ts`](./curator.ts)（归档判定段）、[`constants.ts`](./constants.ts)（配置字段）、[`usage.ts`](./usage.ts)（账本加一个字段 + 出生记水位 + 一个求和函数）三个文件；调度、孤儿清理、`recent_uses`、`archiveSkill` 搬移一律复用。
5. **best-effort、永不挡会话**：账本读不到 / 字段缺失 → 退化成安全默认（老记录当"从一开始就在"处理），绝不让 curator 失败拖垮会话（沿用 `maybeRun` 的 try/catch）。

---

## 解决了什么问题

### 问题 A：现状判据是「按日历天数」，撞导师红线 M1

- **现状（真实代码）**：[`applyAutomaticTransitions`](./curator.ts#L116) 用 `daysSince`（活动锚点到现在多少天，[curator.ts:147-158](./curator.ts#L147)）驱动 `active → stale → archived`：
  - `daysSince ≥ archiveAfterDays(90)` 且非 archived → 归档；
  - `daysSince ≥ staleAfterDays(30)` 且 active → 标 `stale`（陈旧）；
  - `daysSince < staleAfterDays` 且 stale → 复活回 active。
  - 活动锚点 = `max(last_used_at, SKILL.md 文件 mtime)`。
- **后果**：本质是"多久没用就归档"，是**固定时间判据**。导师 6/16 明确否掉"归档判据用固定时间"（分析文档 M1 / R1）。
- **要换成**：按相对调用占比，见[核心机制](#核心机制详解)。

### 问题 B：纯占比会「秒删」新建 skill（须避免）

- 假想现状（若只做"占比 < 阈值就归档"）：刚生成的 skill `use_count = 0`，占比必然 = 0 < 任意阈值 → 下一次扫描立刻归档，哪怕它 5 分钟前才被造出来。
- 后果：违背"给新 skill 机会"，易误杀 AI 刚进化出的好 skill。对应分析文档 Q3。
- 解法：见[核心机制 2](#2-曝光窗口--试用期闸门)的"出生曝光窗口"。

### 问题 C：全局分母会「稀释」闲置项目里的好 skill（须避免）

- 若分母用**全局**总数：项目 A 闲置、项目 B/C 在猛跑 → 全局总数被 B/C 顶飞，A 里 skill X 的 `use_count` 冻住 → X 占比一路缩水到归档。
- 后果：X 一点不烂，掉占比纯因**它所在项目最近没人碰**；而把分母顶上去的 B/C 调用，X **够都够不着**（skill 项目隔离，[skill/index.ts:151](../../skill/index.ts#L151)）。等于拿它没机会接的调用判它死刑。
- 解法：分母改成**本项目内**总数（D2）。项目闲置 → 本项目总数也冻住 → X 占比稳住不被稀释。**用户提出的漏洞，本次修掉。**

### 本次【不】解决（留给后续，见[范围说明](#范围说明)）

- 导师的**第二条线**——"被频繁调用但其实是烂 skill（触发太灵敏、叫起来没帮上忙）"，要进会话看 transcript 交 AI 判正负作用（分析文档 I4/Q4）。**这正是 commit 已加的 [`recent_uses`](./SESSION_USAGE_DESIGN.md) 坐标将来要喂的那条线**——与本文档的占比法并列、数据可复用，但本次不实现。
- **分母含不含用户手动装 / 内置 skill**（见[开放问题 Q2](#开放问题)）——当前数据只统计进化区 skill，扩范围是更大改动，回去与导师确认后另做。
- 归档**能否自动复活**（分析文档 Q5）——当前 `archiveSkill` 是单向搬移、只能手动 `restoreSkill`，本次维持，见[开放问题 Q4](#开放问题)。

---

## 现状 → 改后

| 维度 | 现状（真实代码） | 改后 |
|---|---|---|
| 归档判据 | `daysSince ≥ archiveAfterDays(90)`（按日历天数） | `use_count / 出生后曝光量 < archiveUsageShare(0.001)`（按相对调用占比） |
| 中间态 `stale` | `daysSince ≥ staleAfterDays(30)` 标陈旧，回暖再复活 | **取消按时间的标陈旧/复活**（导师只要"归档"一档；多一档是 YAGNI） |
| 新 skill 保护 | 无（靠"刚建 mtime 新、daysSince 小"自然延迟） | **出生曝光窗口**：出生后累计曝光 < `minExposureCalls(1000)` 不判 |
| 分母（占比的总数） | — | **本项目内**（同 projectId）所有 skill 的 `use_count` 之和（含已 archived 的历史计数） |
| 配置字段 | `staleAfterDays` / `archiveAfterDays` | `archiveUsageShare` / `minExposureCalls`（删掉前两个） |
| `recent_uses` / 钉住 / 孤儿清理 / 7 天巡查 | 有 | **保留不动** |

---

## 对旧文件的修改

> 每处标注 **侵入式**（改了旧行为，有回归风险）还是 **增量式**（只加内容、旧路径不变）。

| 旧文件:位置 | 改什么 | 性质 | 依据 |
|---|---|:---:|---|
| [`constants.ts :: CuratorConfig`](./constants.ts#L1) | 删 `staleAfterDays`/`archiveAfterDays`，加 `archiveUsageShare`(默认 0.001)、`minExposureCalls`(默认 1000)；同步改 `DEFAULT_CURATOR_CONFIG` | **侵入式**（配置形状变，连带 [`hook.ts:63`](../hook.ts#L63) 的 spread） | D1/D3 |
| [`usage.ts :: UsageRecord`](./usage.ts#L26) | 新增字段 `born_at_project_total: number`（出生时**本项目**总调用数） | **增量式**（加字段；老记录缺它时 `load` 回填 0，D4） | D2/D4 |
| [`usage.ts :: emptyRecord`](./usage.ts#L81) / [`seedIfMissing`](./usage.ts#L180) / [`bumpUse`](./usage.ts#L238) | 记录首次创建时，把"当前**本项目**总调用数"算出来写进 `born_at_project_total` | **侵入式**（建记录这一步多算一次本项目总数、多写一个字段） | D2/D5 |
| [`usage.ts`](./usage.ts) **新增** `projectUseCount(data, projectId)` | 纯函数：把账本里**同一 projectId 下**所有记录的 `use_count` 求和 | **增量式**（新函数） | D6 |
| [`curator.ts :: applyAutomaticTransitions`](./curator.ts#L116) 判定段 [147-158](./curator.ts#L147) | 删掉 `daysSince` 那套 active/stale/archived/复活；换成"按项目分组先算各项目总数 → 逐 skill 用本项目曝光窗口 → 占比判归档" | **侵入式**（核心判据整段替换） | D1/D3/D7 |
| [`curator.ts`](./curator.ts) 孤儿清理 [168-183](./curator.ts#L168) / 钉住跳过 / `scanSkills` / 调度 `shouldRunNow` | **保留不动** | 不改 | D7 |

> **不碰**：`usage.ts` 里 `recent_uses` 那套（commit 已实现，服务第二条线）、`archiveSkill`/`restoreSkill` 搬移逻辑、`bumpUse` 的 `recent_uses`/`use_count`/`last_used_at` 现有写入、`resolveScope` 范围过滤。

---

## 核心机制详解

### 1. 出生水位 born_at_project_total

- 账本记录 `UsageRecord`（[usage.ts:26](./usage.ts#L26)，每个 skill 一条，存在 `<root>/curator/usage.json`）新增字段 `born_at_project_total: number`。
- **写入时机**：这条记录**第一次被创建**时（`seedIfMissing` 种入，或 `bumpUse` 首次 upsert），把"此刻账本里**同一项目**（同 projectId）所有 skill 的 `use_count` 之和"算出来写进 `born_at_project_total`，**之后永不改**。
- 含义：这条 skill"出生"那一刻，**它所在的那个项目**已累计发生了多少次 skill 调用。例：它出生时本项目已 50000 次 → `born_at_project_total = 50000`。
- 老记录兼容：早于本功能的记录没有这个字段，`load`（[usage.ts:96](./usage.ts#L96)）回填为 `0`，等价于"从一开始就在"（D4）。

### 2. 曝光窗口 + 试用期闸门

- **出生后曝光量** = `当前本项目总数 − born_at_project_total`。含义：自这条 skill 出生以来，**它所在项目**又发生了多少次 skill 调用——也就是它"本来有多少次机会被选中"。这才是判它的**公平分母**。
- **为什么是本项目、不是全局**：skill 是**项目隔离**的——进化区 skill 只在自己项目里能被加载（[skill/index.ts:151](../../skill/index.ts#L151)），别的项目的调用它**够都够不着**。若用全局总数当分母，一个项目闲置、别的项目在猛跑，闲置项目里好好的 skill 占比会被别人的调用**稀释到归档**——拿它没机会接的调用判它的死刑。改成本项目后：项目闲置 → 本项目总数也一起冻住 → 它的曝光量/占比稳住不被稀释（D2）。
- **试用期闸门**：曝光量 `< minExposureCalls`（默认 1000）→ 这条 skill 跳过，不判、不归档。等于给每个新 skill 一段"**本项目**再跑 1000 次调用"的试用期。
- 关键：窗口用**调用次数**度量、不是天数——所以它不是固定时间判据，不踩 M1（D3）。

### 3. 占比判归档

- 曝光量 `≥ minExposureCalls` 后，算 **占比 = `use_count / 出生后曝光量`**，`< archiveUsageShare`（默认 0.001 = 千分之一）→ 归档。
- 归档动作复用现有 [`archiveSkill`](./usage.ts#L158)：把 skill 目录**搬到** `<root>/<projectId>/archive/<name>/`、记录标 `archived`——**搬移不删除**，可手动 `restoreSkill` 复活，但自动逻辑不会复活它（搬走后它不在可加载目录里，`use_count` 不再涨）。
- `pinned`（钉住）记录永远跳过；`archived` 记录不重复判（沿用现有 `state !== "archived"` 守卫）。
- **本项目总数里包含同项目 archived skill 的历史 `use_count`**：那些调用真实发生过，计入才让本项目总数单调、`born_at_project_total` 锚点一致（D6）。但 archived 记录本身不参与"被判归档"。

---

## 数值走查（对齐导师的例子）

> 设 `archiveUsageShare = 0.001`、`minExposureCalls = 1000`。「当前本项目总数」「曝光量」都只算 skill **自己那个项目**内的调用。

| 场景 | born_at_project_total | 当前本项目总数 | 曝光量 | 它的 use_count | 占比 | 结果 |
|---|---|---|---|---|---|---|
| 导师原例：老 skill 没人用 | 0 | 1000 | 1000 | 0 | 0 | **归档** ✅ |
| 老 skill 偶尔用 | 0 | 1000 | 1000 | 5 | 0.005 | 留 |
| 5 个 skill 平分（M2 反例） | 0 | 1000 | 1000 | 200 | 0.2 | 留（一个都不删）|
| 刚出生的新 skill | 50000 | 50300 | 300 | 0 | — | **跳过**（试用期未满）|
| 新 skill 熬过试用期仍没人用 | 50000 | 51000 | 1000 | 0 | 0 | **归档** |
| 新 skill 试用期内被用起来 | 50000 | 51000 | 1000 | 7 | 0.007 | 留 |
| **闲置项目的好 skill**（别的项目在猛跑） | 0 | 1000（本项目冻住） | 1000 | 5 | 0.005 | **留** ✅ |

> 第 4 行是出生窗口相对"纯占比"的增量价值（没窗口它会被秒删）；**末行是本次"单项目分母"的增量价值**：哪怕别的项目又跑了几万次，本项目总数冻在 1000，它的占比稳在 0.005、不被稀释——换全局分母它早被冲到归档。

---

## 格式样例

**改后的账本记录（`usage.json` 里一条；`born_at_project_total` 是本次新增、`recent_uses` 是上个 commit 已有）**：

```json
{
  "<projectId>/my-skill": {
    "projectId": "<projectId>",
    "name": "my-skill",
    "location": "/home/.../skill-evolution/<projectId>/skills/my-skill",
    "use_count": 0,
    "born_at_project_total": 50000,
    "last_used_at": null,
    "recent_uses": [],
    "state": "active",
    "pinned": false,
    "archived_at": null
  }
}
```

**改后的配置（`CuratorConfig`，删两个加两个）**：

```ts
export interface CuratorConfig {
  enabled: boolean
  intervalHours: number        // 保留：多久跑一次扫描（默认 7×24）——调度，非判据
  archiveUsageShare: number    // 新增：占比阈值，默认 0.001（千分之一）
  minExposureCalls: number     // 新增：出生后曝光量门槛，默认 1000
  // 删除：staleAfterDays / archiveAfterDays（按天数的旧判据）
}
```

---

## 核心不变量

1. **判据零时间** — 归档与否只由相对调用占比决定；保护新 skill 的窗口也用调用量计，无任何"天数/日历"口径（M1）。
2. **绝对截断、非删末位** — 占比都在阈值之上时一个都不归档（M2）。
3. **新 skill 必有窗口** — 出生后曝光量 `< minExposureCalls` 的记录绝不被归档。
4. **搬移不删除** — 归档只把目录搬进 `archive/`，可手动复活（沿用 `archiveSkill`）。
5. **best-effort** — 账本损坏 / 字段缺失 → 安全退化，curator 失败不拖垮会话。
6. **分母按项目隔离** — 占比的分母只算 skill 自己项目（同 projectId）内的调用；别的项目的调用不进它的分母（D2）。
7. **范围不变** — 仍只统计 / 只归档进化区（`<root>/<projectId>/skills/`）的 skill，不新增扫描面。
8. **不动 recent_uses** — 上个 commit 的 `recent_uses` 记录逻辑一行不改（它服务第二条线）。

---

## 决策记录

> 本文档**自有编号 D1…，与 CURATOR / SESSION_USAGE 的 D 编号互不干扰**（不接续——因为本文档替换的判据与那些是另一主题）。

- **D1：归档判据换成「相对调用占比」，彻底删掉按日历天数那套（`staleAfterDays`/`archiveAfterDays` + `daysSince` 逻辑）。** 原因：导师军令 M1。占比 = `use_count / 出生后曝光量`，`< archiveUsageShare` 归档。属侵入式（核心判据整段替换 + 配置字段换）。
- **D2：给每条记录加「出生水位 `born_at_project_total`」，分母用「本项目出生后曝光量 = 当前本项目总数 − 本项目出生水位」——既不算它出生前的调用、也不算别的项目的调用。** 原因：公平分母 = "它真正有机会被选中的次数"，须同时扣掉两类够不着的机会：①**时间维度**——它出生前发生的调用（用 `born_at_project_total` 扣）；②**项目维度**——别的项目的调用（用"本项目"扣，因为 skill 项目隔离、[skill/index.ts:151](../../skill/index.ts#L151) 只加载当前项目进化区）。漏掉②就会出现"闲置项目的好 skill 被别项目的调用稀释到归档"的误杀。**已与用户对齐（用户提出项目维度这一漏洞）。**
- **D3：新 skill 的"试用期"用调用量计（`minExposureCalls`，默认 1000），不用天数计。** 原因：用天数就又变成固定时间判据、踩 M1。用"出生后世界再跑 1000 次调用"既给了保护，又全程是相对调用量。门槛是超参数（分析文档 I3：导师明说阈值是"你自己调的超参数"）。
- **D4：老记录缺 `born_at_project_total` → `load` 回填 0（视为"从一开始就在"）。** 原因：向后兼容；`born=0` 时曝光量=本项目总数，公式退化回导师原例，对老 skill 行为一致（见走查表第 1 行）。
- **D5：出生水位在"记录第一次创建"时写死（`seedIfMissing` / `bumpUse` 首次 upsert）。** 原因：这是唯一能拿到"出生那一刻本项目总数"的时机；之后不改，否则窗口口径会漂。
- **D6：分母（本项目总数）= 账本里**同一 projectId 下**所有记录（含 `archived`）的 `use_count` 求和；新增纯函数 `projectUseCount(data, projectId)`。** 原因：archived skill 的调用真实发生过，计入才让本项目总数单调、出生水位锚点自洽；但 archived 记录本身不参与被判归档。抽成纯函数便于单测（不碰文件 I/O）。
- **D7：保留钉住跳过、孤儿清理 / heal、`scanSkills`、7 天调度间隔、`recent_uses`。** 原因：这些与"归档判据"正交，导师没要求动；`intervalHours` 是"多久巡一次"的调度、不是判据，不踩 M1（删了反而每次会话都跑、费性能）。中间态 `stale` 的**按时间标记/复活**取消（D1 连带），但 `stale` 值保留在类型 union 里以兼容老记录 + 给第二条线预留。
- **D8：本次只做"占比归档"（导师第一条线），不做"灵敏烂 skill"（第二条线 I4）。** 原因：第二条线要进会话读 transcript 交 AI 判正负作用，是另一套机制，且正好复用上个 commit 的 `recent_uses` 坐标，独立设计独立实现，避免一次摊太大又踩 I6（别私自扩方案）。

---

## 开放问题

> 这几条是导师**只给了方向、没给可执行细节**的地方，或须回去对齐口径的。动手前最好先要个准话（对应分析文档 Q1–Q5）。

- **Q1：`archiveUsageShare` / `minExposureCalls` 初值定多少？** 暂定 0.001 / 1000（贴导师举的"1000 次"例子）。导师明说阈值是超参数自己调，但没给初值范围。**待确认初值是否合理。**
- ~~**Q2-a：分母算全局还是单项目？**~~ **已定：单项目**（同 projectId 内求和，见 D2 / [问题 C](#解决了什么问题)）。理由：skill 项目隔离，全局分母会稀释闲置项目的好 skill。用户拍板。
- **Q2-b（地基，仍开放）：单项目分母里含不含用户手动装 / 内置 skill？** 当前数据**只统计进化区 skill**——`bumpUse` 虽对每个 skill 加载都调，但 `resolveScope`（[usage.ts:68](./usage.ts#L68)）对不在 `<root>/<projectId>/skills/` 下的 skill 直接 no-op，所以 `~/.claude/skills` 下手装的、内置的都不计。导师说"包含其它 skill"若指"连手装/内置也进分母"，需先扩统计范围（改 `resolveScope` 口径 + 落盘位置），是更大改动。**须回去与导师确认。**
- **Q3：试用期闸门用「出生后曝光量」对不对，还是用别的口径？** 备选：①出生后本项目曝光量（本文方案）；②干脆"本项目总数 ≥ 某固定值才开始判"（更糙，老/新 skill 不分开）。本文选①。**待确认。**
- **Q4：归档是「硬搬走、只能手动复活」还是「软降权、自动可复活」？** 当前 `archiveSkill` 是单向搬移，自动逻辑不复活。会上 SPEAKER_06 提过"给权重、按权重抽取、留复活机会"，导师未明确采纳或否决。**须确认（分析文档 Q5）。**
- **Q5：要不要保留一个中间告警态（类似旧 `stale`），还是直接 active→archived？** 本文按 KISS 直接两态。若导师想要"先警告再归档"，再加。**待定。**

---

## 关键文件速查

| 文件 | 作用 | 性质 |
|---|---|:---:|
| [`curator.ts`](./curator.ts) | `applyAutomaticTransitions` 纯逻辑归档扫描（本次改判定段 147-158，保留调度/孤儿清理） | ⚠️ 侵入改 |
| [`usage.ts`](./usage.ts) | `UsageRecord` 加 `born_at_project_total` + 出生记水位 + 新增 `projectUseCount`；`recent_uses` 不碰 | ⚠️ 增量+侵入 |
| [`constants.ts`](./constants.ts) | `CuratorConfig` / `DEFAULT_CURATOR_CONFIG`（删两字段加两字段） | ⚠️ 侵入改 |
| [`hook.ts`](../hook.ts#L63) | `Curator.maybeRun` 调用点，spread `DEFAULT_CURATOR_CONFIG`（字段跟着变） | ⚠️ 连带改 |
| [`skill.ts`](../../tool/skill.ts#L69) | 每次 skill 加载调 `bumpUse` 的唯一入口（本次不改，仅依赖） | — |
| [`curator.test.ts`](./curator.test.ts) / [`usage.test.ts`](./usage.test.ts) | 现有测试（本次重写归档判定相关用例；`recent_uses` 用例不动） | ⚠️ 改测试 |

---

## 复用组件核实（实现前必读）

- **X1：归档判据现状已 git 核实是「原始按日历天数」。** `git diff upstream/dev..HEAD -- constants.ts curator.ts` 为空 → 这两文件未被本分支任何 commit 改过；`usage.ts` 仅多 `recent_uses`。**本分支无 `idle_scans`**，本文档替换的是 `daysSince`/`archiveAfterDays` 那套。
- **X2：`use_count` 确实累计、每次 skill 加载 +1。** `bumpUse`（[usage.ts:238](./usage.ts#L238)）`use_count += 1`，由 [`skill.ts:69`](../../tool/skill.ts#L69) 在每次加载时调用——分母数据现成。
- **X3：但 `bumpUse` 只对进化区 skill 生效。** `resolveScope`（[usage.ts:68](./usage.ts#L68)）对不在 `<root>/<projectId>/skills/<name>` 下的 location 返回 null → no-op。所以分母天然只含进化区 skill（直接定义了 Q2 的现状）。
- **X4：`archiveSkill`（[usage.ts:158](./usage.ts#L158)）已实现"搬到 archive/ + 标 archived + 名字冲突加时间戳后缀"，可直接复用。** 归档动作不用新写。
- **X5：`applyAutomaticTransitions` 当前已是"逐 skill 扫 + 读账本 + 判定"结构。** 本次只把 [147-158](./curator.ts#L147) 的 `daysSince` 判定块换掉，循环外先**按 projectId 分组**算各项目总数（或判每条时调 `projectUseCount(ledger, s.projectId)`）；孤儿清理 [168-183](./curator.ts#L168) 原样保留。
- **X6：`DEFAULT_CURATOR_CONFIG` 被 [`hook.ts:63`](../hook.ts#L63) spread 进 `maybeRun`。** 换字段后这里跟着变（不改逻辑）；测试里多处引用 `DEFAULT_CURATOR_CONFIG`/`archiveAfterDays`/`staleAfterDays`，需同步。

---

## 命题清单

### PA. 占比归档主逻辑
- A1. 某 skill 出生后曝光量 ≥ 1000 且 `use_count / 曝光量 < 0.001` → 被归档（目录搬进 archive/、记录标 archived）。
- A2. 某 skill 占比 ≥ 0.001 → 不被归档。
- A3. 5 个 skill 占比都 ≥ 0.001（如各 1/5）→ 一个都不归档（M2 不删末位）。

### PB. 出生窗口 / 试用期
- B1. 出生后曝光量 < 1000 的 skill，哪怕占比 0，也不被归档（试用期保护）。
- B2. `born_at_project_total` 在记录首次创建时写入"当时本项目总数"，之后不变。
- B3. 老记录无 `born_at_project_total` → 当 0 处理，行为同"从一开始就在"。

### PC. 分母 / 总数（按项目隔离）
- C1. `projectUseCount(data, projectId)` = **同 projectId 下**所有记录 `use_count` 之和（含 archived）；别项目的记录不计入。
- C2. 出生后曝光量 = 当前**本项目**总数 − `born_at_project_total`。
- C3. 项目 A 闲置、项目 B 猛跑 → A 里 skill 的曝光量/占比不受 B 影响（项目隔离，问题 C）。

### PD. 不回归（守住已实现的东西）
- D1'. `recent_uses` 的追加/截断行为不被本次改动影响。
- D2'. `archiveSkill`/`restoreSkill`、钉住跳过、孤儿清理行为不变。

### PH. 边界与失败用例（测试必须覆盖）
- H1. 账本为空 / 总数为 0 → 不抛错、不归档任何东西（曝光量 ≤ 0，被试用期闸门拦下）。
- H2. `pinned` 的 skill 即使占比 0、曝光量够 → 仍跳过不归档。
- H3. 账本文件损坏 / 字段类型异常 → `load` 返回安全值，扫描不抛错。

---

## 测试与红绿里程碑

> 走 TDD：每个里程碑先写红测试（证明现状缺它）、再实现到绿。先红后绿两次输出都要留。从 `packages/opencode` 目录内跑。

### ⚠️ 假绿陷阱 / 写读接缝（按 CLAUDE.md #15）

- **测行为不测实现**：断言"这个 skill 被搬进 archive/ 且记录标 archived"，不要断言"调了 archiveSkill"。
- **写读接缝必须接力跑**：`born_at_project_total` 是"创建时写、归档时读"的跨步状态——测试**不许出题人手填 `born_at_project_total`**，必须真跑 `seedIfMissing/bumpUse 创建 → 真的累加**同项目**别的 skill 的 use_count 把本项目总数顶上去 → 再跑 applyAutomaticTransitions 判归档`，让程序自己把出生水位攒过去，再断言结果。手填中间值就漏掉最容易坏的那道接缝。
- **必须有先红**：在把判据从 `daysSince` 换成占比之前跑核心用例——构造一个"刚用过(daysSince 小)但占比为 0"的 skill，旧的按天数判据**不会**归档它、新占比判据**会**，这条用例在改之前应红，证明测试真在测占比而非恒绿。

### 红绿总览（婴儿步，按依赖排序）

1. **里程碑1（占比归档）**：红——造一个 born=0、use_count=0、daysSince 很小的 skill，再造**同项目**别的 skill 把本项目总数顶到 1000，断言它被归档；旧按天数判据因 daysSince 小不归档 → 红。绿——换占比判据后通过。
2. **里程碑2（M2 不删末位）**：红/绿——同项目 5 个 skill 各占 1/5，断言一个都不归档。
3. **里程碑3（出生窗口保护）**：红——born=50000、本项目总数顶到 50300（曝光 300<1000）、use_count=0，断言**不**被归档；漏窗口逻辑会误归档 → 红。绿——加窗口闸门后通过。
4. **里程碑4（项目隔离，复现用户的反例）**：红——项目 A 有个 use_count=5 的好 skill（本项目总数 1000、占比 0.005）；项目 B 灌到几万次。用全局分母会把 A 的 skill 冲到归档 → 红。绿——改本项目分母后 A 的 skill 留住、B 的调用不影响它。
5. **里程碑5（出生水位写读接力）**：真跑 创建→同项目累加→判 三步，断言新 skill 熬过 1000 本项目曝光仍 0 调用 → 归档；试用期内 → 不归档。
6. **里程碑6（不回归 + 边界）**：`recent_uses` 用例仍绿；空账本 / pinned / 损坏账本各一条。

### 收尾验证

- 跑 `usage.test.ts` + `curator.test.ts` 全绿，贴红→绿两次输出。
- 跑 `bun turbo typecheck --filter=aether`，贴 "successful"（确认删字段没漏改调用点）。

---

## 范围说明

**本次做**：把 curator 的归档判据从"按日历天数"换成"按相对调用占比 + 出生曝光窗口"。改 `curator.ts`（判定段）、`constants.ts`（配置字段）、`usage.ts`（加 `born_at_project_total` + 出生记水位 + `projectUseCount`），连带 `hook.ts` 的 spread 与相关测试。

**本次不做**（留给后续独立工作）：
- 导师第二条线"灵敏烂 skill"（进会话读 transcript 判正负作用，I4/Q4）——复用上个 commit 的 `recent_uses` 坐标，独立做。
- 分母扩到"含手动装 / 内置 skill"（Q2，须先与导师确认口径 + 改 `resolveScope`）。
- 归档自动复活 / 权重抽取（Q4/Q5）。

---

## 用户体验

- 对你来说的变化：skill 库会**自动清理真没人用的冷门 skill**，且清理标准**随你的使用量自动伸缩**——你用得多、库里某个 skill 占比掉到千分之一以下，它就被收进 archive/（可恢复，不是删）；你用得少、总量没攒起来，就谁也不动。而且**刚进化出来的新 skill 有一段"再跑 1000 次调用"的试用期**，不会一出生就被误清。
- 没有界面变化；这是后台维护策略的改善。归档是"搬进 archive 文件夹"，需要时可手动恢复，不会真丢东西。

> ⚠️ 注意：本文档是**设计草案**，尚未写代码、未跑测试，属"无法验证（纯文档）"。开放问题 Q1–Q5（尤其 Q2 分母口径）建议先与导师对齐，再进实现。
