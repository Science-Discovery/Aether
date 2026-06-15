# Aether Curator（最简版）— AI 技能库计数与到期归档设计文档

> 状态：**设计草案 v3**，待团队对齐后进入实现（实现走 TDD）。
> 读者：团队开发者 + 组会评审。
> 出处：源自 Hermes Curator（Python，`/home/zheng/code/hermes-agent/curator/`），**只移植其确定性那一半**——
> 计数 + 触发门控 + 自动状态流转；**砍掉 AI 审查 pass**（最激进部分，见 D1）。本版本是组会要的「**最简、不激进**」实现。

Aether Curator 给 AI 在 `skill-evolution/<projectId>/skills/` 下创建的 skill（技能）记使用次数；会话结束时被唤醒，距上次满 7 天就扫一遍，把长期没被用到的 skill **归档**到同项目的 `<projectId>/archive/`（移动目录、可恢复、不真删）。**纯代码判断、全程不引入 AI；不修改 `skill_manage` 一行（拉模式：自己扫硬盘对账，不靠它通知）。**

---

## 目录

- [设计原则](#设计原则)
- [与 skill-evolution / Hermes 的关系](#与-skill-evolution--hermes-的关系)
- [整体架构](#整体架构)
- [文件与数据布局](#文件与数据布局)
- [数据结构](#数据结构)
- [核心机制详解](#核心机制详解)
  - [1. 触发机制（会话结束唤醒 + 时间门控）](#1-触发机制会话结束唤醒--时间门控)
  - [2. 计数：账本何时被写](#2-计数账本何时被写)
  - [3. 扫描-对账 + 自动状态流转](#3-扫描-对账--自动状态流转)
  - [4. 归档机制（per-project 移动目录，不删）](#4-归档机制per-project-移动目录不删)
- [核心不变量](#核心不变量)
- [决策记录](#决策记录)
- [开放问题](#开放问题)
- [关键文件速查](#关键文件速查)
- [复用组件核实（实现前必读）](#复用组件核实实现前必读)
- [命题清单](#命题清单)
- [测试与红绿里程碑](#测试与红绿里程碑)
- [与 Hermes 完整版的差异（砍了什么）](#与-hermes-完整版的差异砍了什么)
- [用户体验](#用户体验)

---

## 设计原则

1. **只做计数 + 到期归档，不引入 AI**：全部判断都是纯代码（看时间、比阈值）。Hermes 那个调 AI 合并/重写 skill 的审查 pass 整块不做（D1）。
2. **范围只限 `<projectId>/skills/`，来源靠位置判定**：curator 只管 skill-evolution（skill 自进化后台）写在 `skill-evolution/<projectId>/skills/` 下的 skill——这个目录是它的**专属输出区，里面清一色是 AI 建的**，用户手写 skill 都在别处。所以「是不是 AI 建的」**看位置就知道**，不需要在创建时打标记（D5）。
3. **拉模式：不碰 `skill_manage`**：`skill_manage`（建/改/删 skill 的工具）保持原样，curator **不插手、也不等它通知**——每次跑时自己扫硬盘对账（D7）。改动靠文件 mtime（修改时间）感知，删除留下的孤儿账本项扫描时自愈。
4. **归档不删、可恢复，且归档到本项目**：最大破坏动作是把 skill 目录**移进同项目的 `<projectId>/archive/`**，绝不 `rm`（D4）。
5. **复用不造轮子**：触发挂现成 `onLoopEnd`（与 skill 自进化评审共用唤醒点），路径用现成 `Spawner`，不新接基础设施（D2/D3）。

### 对旧文件的修改（全为增量式，**skill_manage 零触点**）

> 每处标注 **侵入式**（改了旧行为，有回归风险）还是 **增量式**（只加新调用）。本设计**无侵入式改动**。

| 旧文件:位置 | 改什么 | 性质 | 依据 |
|---|---|:---:|---|
| [`tool/skill.ts :: execute`](../../tool/skill.ts#L45) | agent 成功加载某 skill 后**插一行** `bumpUse(name)`（仅对在管范围 skill 记数） | **增量式** | 「被加载使用」是文件系统记录不到的事件，只能在加载那刻记一笔（X1）；最优努力，失败不影响加载 |
| [`hook.ts :: onLoopEnd`](../hook.ts#L43) | 末尾**插一行** `Curator.maybeRun()` | **增量式** | 与现有评审触发共用此钩子，不改评审逻辑 |

> **`skill_manage` 一个字不碰**（D7）：创建/改动/删除都由 curator 扫描时对账感知——
> 创建→扫到新目录补记录；改动→读文件 mtime；删除→孤儿自愈。唯一不可省的外部触点是 `bumpUse`，且它在 skill **加载工具**里、不在 `skill_manage`。

---

## 与 skill-evolution / Hermes 的关系

- **Hermes 原版**：单一扁平库 `~/.hermes/skills/`，AI 建的和用户手写的混在一起，没法靠位置区分，所以**在创建时打标记**（`mark_agent_created`）；改动靠 `bump_patch` 通知（**推模式**）。再加一个 AI pass 合并相似 skill。
- **本版本（Aether 最简）**：范围缩到 skill-evolution 的**专属输出目录** `<projectId>/skills/`，里面全是 AI 建的 → **位置即来源**，不打标记；改动靠**文件 mtime**，删除靠**扫描对账**（**拉模式**）→ `skill_manage` 完全不碰。只移植 Hermes 的状态机那半（计数 + 到期归档），不要 AI pass。
- **与 skill 自进化的分工**：skill 自进化（生产端）负责**造** skill；curator（维护端）负责**清** skill。共用 `onLoopEnd` 唤醒点，但门控信号不同——自进化看「会话攒了几条」（计数器），curator 看「距上次几天」（时间）。

```
推模式（Hermes）：skill_manage 每次干活都喊一声通知 curator  → 必须改 skill_manage
拉模式（本版本）：skill_manage 闷头干，curator 每次跑时自己扫硬盘对账 → skill_manage 零改动

┌────────── skill 自进化（生产端） ──────────┐
│  对话中 skill_manage 把 skill 写到          │
│  skill-evolution/<projectId>/skills/<name>/ │   ← curator 不插手，只在扫描时发现
└───────────────────┬─────────────────────────┘
        会话结束 onLoopEnd 唤醒 ▼
┌────────── curator（维护端，本设计） ──────────────────────────┐
│  shouldRunNow()：距上次 ≥ 7 天？ 否→接着睡；是→↓               │
│  扫描每个 <projectId>/skills/<name>/：                          │
│    · 没账本记录 → 补一条                                        │
│    · 活动时间 = max(last_used_at[来自bumpUse], 文件mtime)        │
│        ≥90天没动 → 移到 <projectId>/archive/（state=archived）   │
│        ≥30天没动 → state=stale；又被动过 → 退回 active           │
│    · 目录已不存在（被手动删）→ 清掉孤儿账本项                    │
└────────────────────────────────────────────────────────────────┘
        ▲ 持续：agent 加载某在管 skill → bumpUse 记 last_used_at（不在会话结束，在会话进行中）
```

---

## 文件与数据布局

```
~/.local/share/aether/skill-evolution/          ← Spawner.skillEvolutionRoot()
│
├── <projectId>/                                 ← 每个被分析的项目（hex 哈希）
│   ├── skills/                                   ← 【curator 管这里】AI 建的活跃 skill
│   │   └── <name>/SKILL.md
│   └── archive/                                  ← 【本设计新增】本项目归档区（与 skills/ 平级）
│       └── <name>/SKILL.md                       ←   移出 skills/ → 加载器扫不到，可恢复
│
└── curator/                                      ← 【本设计新增】curator 全局账本/状态
    ├── usage.json                                ← 使用计数账本，key = "<projectId>/<name>"
    └── state.json                                ← 调度状态（lastRunAt / paused / runCount）
```

- **归档 per-project**：项目 X 的 skill 归档到 `<projectId-X>/archive/`，项目之间互不混（用户已拍板）。归档目标 = `Spawner.skillEvolutionDir(projectId)` 的同级 `archive/`。
- **账本/状态全局一份**：放 `curator/` 子目录，集中管理。账本按**复合 key**（`<projectId>/<name>`）区分不同项目的同名 skill（用户已拍板「方案甲」）。
- curator **不碰** `~/.aether/skills`、项目内 `.aether/skills`（那是其它来源，不在范围，D5）。

---

## 数据结构

### UsageRecord — 单个 skill 的记录（落盘 `curator/usage.json`，key = `<projectId>/<name>`）

```ts
interface UsageRecord {
  projectId: string            // 来自哪个项目
  name: string                 // SKILL.md frontmatter.name
  location: string             // skill 文件夹绝对路径（用户要求：账本存地址）
  use_count: number            // 被加载使用的次数（组会要的「计数」）
  last_used_at: string | null  // 最后一次被加载的时间（UTC ISO 8601）；从未用过为 null
  state: "active" | "stale" | "archived"
  pinned: boolean              // 钉住：跳过自动流转（只读，无设置入口，见 Q2）
  archived_at: string | null
}
```

> **砍掉的字段**（相对 Hermes，见 D5/D7/D8）：
> - `created_by`——来源靠位置判定，不需要标记字段；
> - `patch_count` / `last_patched_at`——「改动」靠**文件 mtime** 感知，不在 skill_manage 记；
> - `view_count` / `last_viewed_at`——Aether 无 skill_view 工具；
> - `created_at`——「活动时间」锚点用 `max(last_used_at, 文件 mtime)`，文件 mtime 已覆盖「创建/改动时间」，不必单存。

### CuratorState — 调度状态（落盘 `curator/state.json`，原子写入 temp+rename）

```ts
interface CuratorState {
  lastRunAt: string | null     // 上次真正扫描的时间；首次为 null
  paused: boolean
  runCount: number
}
```

可调参数（默认沿用 Hermes 原值，[core.py:48-51](/home/zheng/code/hermes-agent/curator/core.py)；用户已拍板用原值）：

| 参数 | 默认 | 含义 |
|------|------|------|
| `intervalHours` | 168（7 天） | 两次扫描的最小间隔 |
| `staleAfterDays` | 30 | 多久没活动标 stale |
| `archiveAfterDays` | 90 | 多久没活动归档 |

> 组会演示要现场看效果，可临时把常量调到分钟级、演示完改回，不写进默认值。

---

## 核心机制详解

### 1. 触发机制（会话结束唤醒 + 时间门控）

curator 不常驻：被 `onLoopEnd`（每次对话结束的钩子）唤醒，先看够不够 7 天，不够就接着睡。

```
每次对话结束 → onLoopEnd → Curator.maybeRun()（不抛异常，门控没过干净返回）
        │ 读 state.json
        ▼
   shouldRunNow():
     enabled==false 或 paused==true ───────────► false（只读，不写）
     lastRunAt 为空（首次） ──► 写 now、return false（推迟一整周期）
     now - lastRunAt < 7 天 ───────────────────► false（只读，不写）  ← 绝大多数情形
     now - lastRunAt ≥ 7 天 ──► 跑 applyAutomaticTransitions() + 写 lastRunAt=now
```

- **为什么选 onLoopEnd（D3）**：蹭现成钩子——skill 自进化评审本就挂这（[hook.ts:43](../hook.ts#L43)），共用唤醒点，不新接启动钩子。
- **与 Hermes 差异**：Hermes 在程序启动时触发（`idle_for_seconds=inf`），靠「空闲 ≥2h」门；onLoopEnd 非空闲时刻，那道门过不去，故**丢掉 `min_idle_hours`，只靠 7 天间隔控频**。
- **首次永不立刻跑**：lastRunAt 为空时只写 now、return false，和 Hermes `should_run_now`（[core.py:202](/home/zheng/code/hermes-agent/curator/core.py)）一致。

### 2. 计数：账本何时被写

`usage.json`（账本）被写**只有两类时机**：

1. **`bumpUse`——会话进行中，每加载一个在管 skill 写一次。** agent 通过 skill 加载工具加载 `foo` → 读 `usage.json` → `foo` 这条 `use_count+1`、`last_used_at=now` → 写回。
   - **upsert（有则加、无则建）**：若 `foo` 还没记录（curator 还没扫到它）→ **当场建一条并 `use_count=1`**。所以新建 skill 的使用**从第一次加载就被计上**，不会丢。
   - **只对在管范围记**：靠 skill 的 `location` 判断它在不在 `<projectId>/skills/` 下；不在（内置/全局 skill）→ 跳过，不写。
   - 诚实交代：这是「每用一次读-改-写一遍 `usage.json`」。skill 加载不频繁 + 文件小 + 原子写，够用（Hermes 也是每次 use 就写）。
2. **curator 扫描时**——补新记录、改 state、清孤儿，也写 `usage.json`（见 §3）。

> 「被加载使用」是**文件系统记录不到**的事件（加载文件不改它的 mtime），所以 `bumpUse` 不可省；而创建/改动能靠 mtime、删除能靠扫描，故都不用碰 skill_manage（D7）。

### 3. 扫描-对账 + 自动状态流转

`applyAutomaticTransitions()` 在门控通过后跑，是 curator 去看**硬盘真实现状**、跟账本对账：

```
读 state.json 通过门控后：
  遍历每个 skill-evolution/<projectId>/skills/<name>/：
    ① 账本没有这条 → 补一条（location=该路径，use_count=0，last_used_at=null）
    ② pinned==true → 跳过
    ③ 活动时间 anchor = max(last_used_at[账本], 文件 mtime[现读])
       now - anchor ≥ 90 天          → archiveSkill()，state=archived
       now - anchor ≥ 30 天 且 active → state=stale
       now - anchor < 30 天 且 stale  → state=active（复活）
  对账本里的每条：若其 location 目录已不存在（被手动删）→ 删掉这条（孤儿自愈）
  写 lastRunAt=now、runCount+1
```

- **活动时间 = `max(last_used_at, 文件 mtime)`**：`last_used_at` 来自 `bumpUse`（被加载）；文件 mtime 来自现读（被创建/改动）。两者取最新。**新建/刚改的 skill 的 mtime≈现在 → 不会被误归档**；从没被用、又久未改的 → anchor 是个旧时间 → 到期归档。
- **stale**：active→archived 的中间缓冲 + 支持复活；**本版本无其它功能性后果**（不隐藏、不降权，见 Q3）。
- **pinned**：跳过全部流转，**只读**（无设置入口，Q2；应急可手改账本）。
- **孤儿自愈**：手动删 skill（skill_manage delete / 终端 rm）只删文件、不动账本 → 账本留废记录；扫描时发现「location 目录没了」→ 跳过/清掉，不报错。

### 4. 归档机制（per-project 移动目录，不删）

`archiveSkill(record)` 对应 Hermes `archive_skill`，但归档到**本项目**：

```
归档：
    从  <root>/<projectId>/skills/<name>/
    移到 <root>/<projectId>/archive/<name>/     ← rename（剪切，不改内容；同名冲突加时间戳）
    账本该条：state="archived"，写 archived_at

恢复 restoreSkill：
    从 archive 移回账本里存的 location（精确放回原位）
    账本该条：state="active"
```

**后果**：归档后 skill 从活跃目录树消失 → 加载器扫不到、不进系统提示词；文件原封不动在 `archive/`，可精确恢复。

> 归档/恢复**只由 curator 自己触发并同步账本**，所以 curator 的操作不产生孤儿。孤儿只来自「**非 curator** 的删除」（skill_manage delete、终端 rm），靠 §3 的扫描自愈。

---

## 核心不变量

1. **范围只限 `<projectId>/skills/`** — 其它来源（全局/项目内/内置）的 skill 一律不碰（D5）。
2. **不改 `skill_manage` 一行** — 拉模式，curator 自己扫描对账（D7）。
3. **curator 永不删 skill** — 最大动作是移进 `<projectId>/archive/`，可恢复；手动 delete 仍是真删，不归 curator 管。
4. **pinned 跳过全部自动流转** — 只读，无设置入口。
5. **首次运行推迟** — lastRunAt 为空时只写时间不真跑。
6. **新/刚改的 skill 不误伤** — 活动锚点含文件 mtime，新建或刚改的 mtime≈现在，不会立刻归档。
7. **计数与扫描是最优努力** — 账本损坏/写失败只 log 不抛，绝不拖垮加载或会话结束。
8. **状态/账本原子写入** — temp file + rename，避免半写损坏。

---

## 决策记录

- **D1：只做计数 + 到期归档，砍 AI 审查 pass。** 组会要「最简、不激进」。Hermes 的 `run_curator_review`（AI 合并/重写）最激进，整块不做。**用户已拍板。**
- **D2：账本/状态放 `skill-evolution/curator/`，归档 per-project 放 `<projectId>/archive/`。** 集中管理、不污染活跃目录；归档跟着项目走，互不混。代码早有预留：[spawner.ts:43](../spawner.ts#L43) 注释写明该区域 *reserved for the future curator*。**用户已拍板。**
- **D3：触发挂 `onLoopEnd`，丢掉 `min_idle_hours` 空闲门。** 蹭现成钩子；onLoopEnd 非空闲时刻，空闲门无意义，只保留 7 天间隔。**用户已拍板选会话结束触发。**
- **D4：归档 = 移动目录，不删，可恢复。** 防丢失；只由 curator `applyAutomaticTransitions` 触发，不经任何外部工具。
- **D5：范围只限 `<projectId>/skills/`，来源靠位置判定。** 该目录是 skill-evolution 专属输出区（[spawner.ts:47-54](../spawner.ts#L47) / [shadow-writer.ts:42](../shadow-writer.ts#L42)），里面清一色 AI 建的 → 位置即来源，**不需要 `created_by` 字段、不需要在创建时 `markAgentCreated`**。**用户已拍板「只管 `<projectId>/skills/`」。**
- **D6：`bumpUse` 在 skill 加载工具（[`tool/skill.ts`](../../tool/skill.ts#L45)），不在 `system.skills()`、也不在 `skill_manage`。** `system.skills()` 每次列全部 skill，在那 +1 会让全员永远刚用过、归档失效。
- **D7：拉模式，`skill_manage` 零触点（绝不改旧功能）。** 创建→扫描发现补记录；改动→文件 mtime；删除→孤儿自愈。把 delete 改成归档、或在 create/patch 里插 curator 调用，都是改/侵入旧工具，**绝对不允许**。原则区分：`bumpUse` 那种**只加、不改旧行为、且不在 skill_manage** 的增量观测可以加。**用户已拍板。**
- **D8：账本 key = `(projectId, name)` 复合键，记录存 `location`；活动锚点 = `max(last_used_at, 文件 mtime)`。** 复合键解决跨项目同名（原 Q4）；存地址供归档/恢复精确定位（用户要求）；文件 mtime 覆盖「创建/改动时间」，故不存 `created_at`/`patch_count`。**用户已拍板「方案甲 + 存地址」。**

---

## 开放问题

- ~~**Q1：阈值用原值还是演示调短？**~~ **已定：用 Hermes 原值 7 / 30 / 90 天。** 演示时临时调短、完后改回，不进默认值。
- ~~**Q2：pin / unpin 用户入口？**~~ **已定：不做。** 保留 `pinned` 字段 + 流转跳过分支（应急手改账本），不建 `setPinned()` 公开写入（无调用方=死代码）。
- ~~**Q4：跨项目同名歧义？**~~ **已定：复合键 `(projectId, name)` 解决**（D8）。
- **Q3：`stale` 是否要有功能性后果？** 当前只是中间路标 + 复活判定，不隐藏、不降权。要让它真起作用（降权/提示 AI 少用）是额外设计。**默认不做，待定。**

> 实现按 YAGNI：只建当前需要的文件，核心逻辑走 TDD 先红后绿。

---

## 关键文件速查

| 文件 | 职责 | 复用 / 新增 |
|------|------|:---:|
| `skill-evolution/curator/usage.ts` | 账本读写（`bumpUse` upsert / `agentCreatedReport` / `setState` / `forget`）+ 归档/恢复（`archiveSkill` / `restoreSkill`）+ 范围/key 工具（按 location 判范围、拼 `(projectId,name)`） | ✅ 新增 |
| `skill-evolution/curator/curator.ts` | 门控 `shouldRunNow` + 扫描对账/流转 `applyAutomaticTransitions` + 入口 `maybeRun` + 配置/状态读写 | ✅ 新增 |
| `skill-evolution/curator/constants.ts` | 默认配置常量（intervalHours / staleAfterDays / archiveAfterDays） | ✅ 新增 |
| `skill-evolution/curator/usage.test.ts` / `curator.test.ts` | 单测（先红后绿） | ✅ 新增 |
| [`tool/skill.ts :: execute`](../../tool/skill.ts#L45) | 加载 skill 后插 `bumpUse(name)` | ⚠️ 增量改 |
| [`hook.ts :: onLoopEnd`](../hook.ts#L43) | 末尾插 `Curator.maybeRun()` | ⚠️ 增量改 |
| [`spawner.ts`](../spawner.ts#L52) | 路径来源：`skillEvolutionDir(projectId)` = `<projectId>/skills`；其同级 `archive/` 为归档目标 | ♻️ 复用 |
| [`shadow-writer.ts`](../shadow-writer.ts#L42) | 读其落点逻辑确认 `<projectId>/skills/` 是 AI 输出区（D5 依据） | ♻️ 参照 |
| [`skill-manage-tool.ts`](../skill-manage-tool.ts) | **不碰**（D7） | — |

---

## 复用组件核实（实现前必读）

- **X1：`bumpUse` 落点是 [`tool/skill.ts :: execute`](../../tool/skill.ts#L45)，不是 `system.skills()`、更不是 `skill_manage`。** `execute`（[:45](../../tool/skill.ts#L45)）里 `Skill.get(params.name)`（[:46](../../tool/skill.ts#L46)）成功后才是「真的加载了某 skill」，且 `skill.location` 可拿到 → 据此判范围、拼 `(projectId,name)` key。`bumpUse` 须最优努力（失败不影响加载）。
- **X2：`<projectId>/skills/` 是 skill-evolution 专属 AI 输出区（D5 前提）。** [spawner.ts:47-54](../spawner.ts#L47) 注释：该目录是「AI background-review sessions write skill files」；[shadow-writer.ts:42-43](../shadow-writer.ts#L42) 的第②分支（有 sessionProjectId、无 skillLocation）落点正是这里。用户手写 skill 在 `.claude/skills`/`.aether/skills` 等别处，不会出现在此 → 位置即来源成立。**风险**：若日后有人改写入逻辑往此目录塞非 AI skill，位置判定会误判（用显式标记可避免，但要碰 skill_manage，已权衡选位置法）。
- **X3：干净 upstream/dev 无任何计数零件。** 无 `usage.json`、无 `bumpUse`（已搜全库）——从零新建。
- **X4：`skill_manage` 保持原样。** `handleDelete` 的 `fs.rm`（[skill-manage-tool.ts:281](../skill-manage-tool.ts#L281)）真删不变；`handleCreate`/`handlePatch` 不插任何 curator 调用。删除遗留的孤儿账本项由扫描自愈，无需 hook delete。**好处：skill_manage 零行为改动，无需其回归测试。**
- **X5：归档目标 = `skillEvolutionDir(projectId)` 的同级 `archive/`。** `skillEvolutionDir`（[spawner.ts:52](../spawner.ts#L52)）= `<root>/<projectId>/skills`，其同级即 `<root>/<projectId>/archive`。

---

## 命题清单

> 把全文压成可判定真假的断言，分组、组内按重要度递减。带锚点的实现时先 grep 确认行号。

### PA. 定位与边界
- PA1. 只做计数 + 到期归档，**不引入 AI**（D1）。
- PA2. 范围只限 `skill-evolution/<projectId>/skills/`；来源靠位置判定，不需 `created_by`（D5）。
- PA3. **不改 `skill_manage` 一行**（拉模式，D7）；唯一外部触点 `bumpUse` 在 skill 加载工具、`maybeRun` 在 onLoopEnd。

### PB. 计数（账本写时机）
- PB1. `bumpUse` 在 agent 成功加载某**在管范围** skill 时 +1 并写 `last_used_at`（[tool/skill.ts:45](../../tool/skill.ts#L45)）。
- PB2. `bumpUse` 是 **upsert**：无记录则当场建（`use_count=1`）——新建 skill 的使用从第一次加载就计上，不丢。
- PB3. `bumpUse` 靠 `location` 判范围：不在 `<projectId>/skills/` 下的（内置/全局）跳过不写。
- PB4. 「被加载使用」文件系统记录不到（不改 mtime），故 `bumpUse` 不可省（X1）。
- PB5. 账本/计数最优努力：损坏或写失败只 log 不抛（不变量 7）。

### PC. 扫描对账与流转归档
- PC1. 活动锚点 = `max(last_used_at[账本], 文件 mtime[现读])`。
- PC2. `now - anchor ≥ 90 天` → `archiveSkill`（移到 `<projectId>/archive/`）+ state=archived。
- PC3. `now - anchor ≥ 30 天` 且 active → state=stale。
- PC4. stale 且 `now - anchor < 30 天` → 退回 active（复活）。
- PC5. `pinned==true` → 跳过全部流转（只读，无 setPinned）。
- PC6. 新建/刚改 skill（mtime≈now）→ anchor≈now → 不被归档（不变量 6）。
- PC7. 扫到 `<projectId>/skills/` 下无账本记录的 skill → 补一条（seed，location=该路径）。
- PC8. 账本项的 `location` 目录已不存在 → 删掉该条（孤儿自愈），不报错。
- PC9. 归档/恢复由 curator 自己做并同步账本 → 不产生孤儿；孤儿只来自非 curator 的删除。
- PC10. 归档 per-project：`<projectId>/skills/<name>` → 同项目 `<projectId>/archive/<name>`；恢复按存的 `location` 精确放回。
- PC11. stale 当前无其它功能性后果（不隐藏、不降权，Q3）。

### PD. 触发门控
- PD0. `shouldRunNow` 先看 `enabled==false`/`paused==true` → 直接 false（只读不写）。
- PD1. 距上次 ≥ `intervalHours`（默认 168）才跑；本版本无空闲门（D3）。
- PD2. 首次（lastRunAt 为空）只写 now、return false，推迟一整周期。
- PD3. `maybeRun` 门控没过干净返回、不抛异常。
- PD4. 触发点 `onLoopEnd`，与 skill 自进化评审共用唤醒点。
- PD5. 时间戳一律 UTC ISO 8601。

### PE. 数据结构
- PE1. `usage.json` key = `<projectId>/<name>` 复合键（解决跨项目同名，D8）。
- PE2. `UsageRecord` 含 `location`（存地址，供归档/恢复定位，D8）。
- PE3. 不含 `created_by`/`patch_count`/`view_count`/`created_at`（D5/D8）。
- PE4. `CuratorState`（lastRunAt/paused/runCount）落盘 `curator/state.json`，原子写入。

### PH. 边界与失败用例（测试必须覆盖）
- PH1. 禁用/暂停：`paused==true` → shouldRunNow false。
- PH2. 首次：lastRunAt 为空 → false 且写 now。
- PH3. pinned 豁免：pinned 且久未动 → 跑后仍 active。
- PH4. 新/刚改不误伤：mtime≈now、last_used_at=null → 跑后仍 active。
- PH5. 账本损坏：usage.json 非法 → load 返回空、不抛。
- PH6. 范围外不计：加载非 `<projectId>/skills/` 的 skill → 不写账本。
- PH7. 孤儿自愈：账本有、location 目录没了 → 跑后该条被清、不报错。
- PH8. 跨项目同名：两项目各有 `foo` → 账本两条互不干扰（复合键）。

---

## 测试与红绿里程碑

> 核心逻辑走 TDD（先红后绿、婴儿步）。**每个里程碑独立走红→绿**，交付展示两次跑测输出（红：实现没写时失败；绿：写完通过）。
> 测试从 `packages/opencode` 目录内跑。**隔离粒度**：计数/门控/流转/归档全是纯文件逻辑，用轻量临时目录（`fs.mkdtemp` + `fs.utimes` 控 mtime）即可，无需拉起 Instance。

### ⚠️ 假绿陷阱与依赖顺序

- **M11（到期归档）是核心接缝、先停点、最该先看到红**——证明「喂旧时间戳 → 真被移进 `<projectId>/archive/`」这条写读接力跑得通。
- **M14（pinned 跳过）/ M15（新 skill 不误伤）有假绿陷阱**：若归档完全不工作，「断言没被归档」会恰好成立而假绿 → 必须排在 M11 之后，红来自「普通的被归档、而 pinned/新 的没被归档」的对比。

### 红绿总览（按依赖排序）

| 次序 | 里程碑 | 红（先写失败测试） | 绿（实现） | 命题/边界 | 接缝 |
|---|---|---|---|---|:---:|
| M1 | 计数 upsert | 对一个在管 skill 连调两次 `bumpUse`（初始无记录）→ use_count===2、last_used_at 非空 | `bumpUse` upsert | PB1/PB2 | ★写读接力 |
| M2 | 范围过滤 | 加载不在 `<projectId>/skills/` 下的 skill → 账本无该条 | location 判范围 | PB3/PH6 | |
| M3 | 账本损坏不崩 | usage.json 写非法内容 → load 返回空、不抛 | 防御性 load | PB5/PH5 | |
| M6 | 首次不立刻跑 | 全新状态 → `shouldRunNow()`===false 且写 lastRunAt | `shouldRunNow`+原子写 state | PD2/PH2 | |
| M7 | 未到间隔不跑 | lastRunAt=1h 前 → false | 门控 | PD1 | |
| M8 | 到间隔才跑 | lastRunAt=8 天前 → true | 门控 | PD1 | |
| M9 | 暂停/禁用不跑 | paused==true → false | 前置开关 | PD0/PH1 | |
| M10 | 扫描补记录 | `<projectId>/skills/` 下有个无账本记录的 skill → 跑 → 账本多一条（location 对） | seed | PC7 | |
| **M11** | **到期归档（核心，先停点）** | skill last_used_at 与文件 mtime 都=100 天前 → 跑 → **移进 `<projectId>/archive/`、archived** | 流转 + `archiveSkill` per-project 移动 | PC1/PC2/PC10 | ★★写读接力 |
| M4 | 归档移目录（单元） | 真建 `<projectId>/skills/s/` + 账本 → `archiveSkill` → 原处没了、`<projectId>/archive/s/` 在、archived | `archiveSkill` | PC10 | ★写读接力 |
| M12 | 标 stale | anchor=40 天前 → 跑 → stale（未归档） | 流转 | PC3 | |
| M13 | 复活 | stale 的 skill last_used_at 更新到现在 → 跑 → active | 流转 | PC4 | |
| M14 | pinned 跳过（排 M11 后） | 直接写账本 pinned:true、100 天没动 → 跑 → 仍 active | pinned 读取/跳过 | PC5/PH3 | 防假绿 |
| M15 | 新/刚改不误伤（排 M11 后） | 文件 mtime=今天、last_used_at=null → 跑 → 仍 active | mtime 锚点 | PC6/PH4 | 防假绿 |
| M16 | 孤儿自愈 | 账本有记录、location 目录不存在 → 跑 → 不报错、该条被清 | 扫描校验目录存在 | PC8/PH7 | |
| M17 | 跨项目同名 | 两项目各有 `foo`，归档其一 → 另一不动、账本两条互不干扰 | 复合键 | PE1/PH8 | |
| M5 | 恢复 | `restoreSkill` → 按 location 移回原位、active | `restoreSkill` | PC10 | ★写读接力 |

> 顺序：M1→M10 独立小零件（计数 + 门控 + seed）。**M11 是先停点**（归档接缝跑通再做其余流转）。M4 是 `archiveSkill` 的单元补测。M14/M15 强制排 M11 后（防假绿）。M16/M17 验 D7 孤儿自愈与 D8 复合键。

### 收尾验证（实现完成后）

- `bun --cwd packages/opencode typecheck`，贴结果。
- 从 `packages/opencode` 跑全部 curator 新测试 + 相关旧测试（至少 `src/skill-evolution/`、`src/skill/`），贴结果。
- **`skill_manage` 一行不改**（D7），无需其回归测试；但 `tool/skill.ts` 加了 `bumpUse`，跑 skill 加载相关测试确认未影响加载。

---

## 与 Hermes 完整版的差异（砍了什么）

- ❌ **AI 审查 pass**（`run_curator_review` + 合并提示词 + 分类 + 报告）——最激进，整块不做（D1）。
- ❌ **快照 / 回滚**（`backup.py`）——归档本身已可恢复，不拍 tar.gz。
- ❌ **内置 / hub skill 管理**（`.bundled_manifest` / `.hub` / `prune_builtins` / 抑制名单）——范围只限 `<projectId>/skills/`（D5）。
- ❌ **CLI**（`status` / `run` / `pin` / `rollback`）——靠 onLoopEnd 自动触发。
- ❌ **`created_by` / `mark_agent_created`**——来源靠位置（D5）。
- ❌ **`bump_patch` / `view_count`**——改动靠文件 mtime；无 skill_view 工具（D8）。
- ❌ **改 `skill_manage` 的 delete**——Hermes 把 delete 改成归档；本版本**保持 delete 真删原样**，拉模式不碰 skill_manage（D7）。
- ⚠️ **触发时机**：onLoopEnd（会话结束）而非启动，丢 `min_idle_hours`（D3）。
- ✅ **保留**：使用计数、三态流转、间隔门控 + 首次推迟、归档 / 恢复（但归档改 per-project）。

---

## 用户体验

| | 体验 |
|---|---|
| **没有 curator** | AI 不断新建 skill，技能库无限膨胀；上百个又窄又重复、大多没人用的条目全塞进系统提示词 → AI 选 skill 越来越不准、列表越来越乱。 |
| **有了 curator** | 长期没用到的 skill（默认 90 天）**悄悄被挪进本项目的归档目录**，活跃列表自动保持精简。删错也不怕——可恢复。 |

**边界（诚实说清）**：本版本**没有界面、没有通知**，在后台静默发生——用户唯一能直接感知的是「技能列表长期保持干净、不再膨胀」。想让用户「有感」（提示、面板、一键恢复）是额外 UI 活，不在最简版范围。
