# Curator skill 身份 — 「唯一 id 替代按名字做 key」设计文档

> 状态：**已实现 v1**(走 TDD,2026-06-18)。Q1 定走"路 A(加唯一 id)";Q2–Q7 已各定暂定方案并落地(见决策记录)。**仍建议把暂定方案(尤其 Q3 用 `ulid`、Q5 老 skill 回退不迁移)报导师知会一声**——这些是按合理默认实现的,非红线,但属"skill 身份"地基,留个记录。
> **验证**:`skill-manage-tool.test.ts` / `usage.test.ts` / `curator.test.ts` 新增 id 用例先红后绿;整个 `src/skill-evolution/` 186 测试全绿、`bun turbo typecheck --filter=aether` 通过。**已知未自动化覆盖**:里程碑2–3(SKILL.md frontmatter 的 id 经 `Skill` 加载器解析 → 传给 `bumpUse`)这条生产链路靠 typecheck + 字段贯通保证,未写专门的加载器集成测试(该测试 harness 较重);根因修复(按 id 不撞)用直接给 `bumpUse` 传 id 的 usage 级测试覆盖。
> 读者:团队开发者 + 组会评审 + 照本实现的人(含 yolo 沙盒会话——它没有讨论上下文,本文档即唯一说明书)。
> 出处:2026-06-18 多轮 code-review 暴露的一个根因 bug——curator 按"名字"给 skill 当身份,导致"归档后同名重建"撞车(详见[解决了什么问题](#解决了什么问题))。前序设计见同目录 [`RELATIVE_USAGE_DESIGN.md`](./RELATIVE_USAGE_DESIGN.md)(相对调用占比归档判据)与 [`CURATOR_DESIGN.md`](./CURATOR_DESIGN.md)。
> 关联:要碰 [`usage.ts`](./usage.ts)(账本读写)、[`curator.ts`](./curator.ts)(扫描/归档)、[`skill-manage-tool.ts`](../skill-manage-tool.ts)(创建 skill)、[`skill/index.ts`](../../skill/index.ts)(SKILL.md 解析)、[`tool/skill.ts`](../../tool/skill.ts)(加载入口)。**本文档只改"skill 身份/key"这一块——占比判据、出生水位、归档搬移、墓碑等沿用 `RELATIVE_USAGE_DESIGN.md`,不重述。**

---

## 目录

- [设计原则](#设计原则)
- [解决了什么问题](#解决了什么问题)
- [现状 → 改后](#现状--改后)
- [对旧文件的修改](#对旧文件的修改)
- [核心机制详解](#核心机制详解)
- [格式样例](#格式样例)
- [核心不变量](#核心不变量)
- [决策记录](#决策记录)
- [开放问题](#开放问题)
- [关键文件速查](#关键文件速查)
- [复用组件核实(实现前必读)](#复用组件核实实现前必读)
- [命题清单](#命题清单)
- [测试与红绿里程碑](#测试与红绿里程碑)
- [范围说明](#范围说明)
- [用户体验](#用户体验)

---

## 设计原则

1. **skill 的身份是"稳定唯一 id",不是名字。** 一个 skill 一旦创建就带一个永不复用的 id;名字只是给人看的标签,可以重名、可以改。账本(`usage.json`,记每个 skill 使用情况的文件)按 id 认人。
2. **id 在创建时一次性盖死,之后不变、不复用。** 归档、改名、改内容都不改 id;一个 skill 被淘汰后,新建的同名 skill 拿到的是**另一个** id。
3. **最小侵入、向后兼容。** 老 skill / 老账本没有 id → 平滑迁移,迁移期不能让 curator 崩或误判(沿用 `RELATIVE_USAGE_DESIGN.md` 的 best-effort 原则)。
4. **只给"进化区 skill"上身份。** 手动装的 / 内置 skill 不归 curator 管(`resolveScope` 本就只认 `<root>/<projectId>/skills/<name>`),不强加 id。
5. **id 从"已经解析好的 SKILL.md"取,不额外读盘热路径。** 加载 skill 时本就解析过 frontmatter(skill/index.ts 的 `Info`),id 顺着这条链传下去,不在每次加载时为了拿 id 再读一次文件。

---

## 解决了什么问题

### 问题 A:按名字做 key → 归档后同名重建撞车(本次根因)

- **现状(真实代码)**:账本每条记录的 key(唯一标识)= `项目id/名字`,由 [`resolveScope`](./usage.ts#L93)(把磁盘路径解析成 key 的函数,[usage.ts:110](./usage.ts#L110))和 [`scanSkills`](./curator.ts#L90)([curator.ts:104](./curator.ts#L104))从**路径**拼出来。**同项目 + 同名 = 同一条账。**
- **后果(多轮 review 确认的 bug)**:一个 skill `foo` 被归档后(目录搬进 `archive/`、账标 `archived`,但账留着),若之后又新建一个**同名** `foo`:
  1. 新 `foo` 加载时,[`bumpUse`](./usage.ts#L300)(每次加载记一笔)解析出的 key 跟旧 `archived` 账相同 → **撞上旧账,新 skill 拿不到自己的账,寄生在旧账上**。
  2. `bumpUse` 落到 [usage.ts:332](./usage.ts#L332) `rec.use_count += 1`,把这条 `archived` 账的次数顶高,但状态仍是 `archived`。
  3. curator 整理时,判断循环 [curator.ts:159](./curator.ts#L159) 和孤儿循环 [curator.ts:184](./curator.ts#L184) 都跳过 `archived` → **新 skill 永远不被判定**(既无归档保护、也永不被淘汰)。
  4. 而 `projectUseCount`(算占比的分母,[usage.ts:79](./usage.ts#L79))把 `archived` 也求和 → 被顶高的次数**灌进分母 → 同项目别的 skill 占比被稀释 → 兄弟被误归档**。
- **真实佐证**:见本分支 review 记录(narrowing rebirth 那轮);用例:`proj1/foo` 归档后重建并被调用 100 次 → 同项目 `bar` 占比被这 100 次稀释、被误判归档,而真正的流量来源 `foo` 永不被审。
- **要换成**:给每个 skill 一个稳定唯一 id 当身份,旧 `foo`(id=A)与新 `foo`(id=B)天然是两条账,从源头不撞——见[核心机制](#核心机制详解)。

### 问题 B:同名 skill 跨情形的隐患(顺带说明,非本次新增)

- 名字可重用还会引出:同项目历史里出现过多个"同名但实为不同"的 skill 时,账本无法区分谁是谁;`hasArchivedCopy`(查归档副本,按名字精确匹配,[usage.ts:201](./usage.ts#L201))也会认错副本。id 化后这些一并消解。

### 本次【不】解决(留给后续,见[范围说明](#范围说明))

- **占比判据本身**(出生水位、试用期窗口、千分之一阈值)——沿用 `RELATIVE_USAGE_DESIGN.md`,本次不动。
- **墓碑(`deleted`)复活逻辑**——上一轮已实现,本次不重做;但 id 化后"复活"语义会简化(见 [Q6](#开放问题)),待对齐。
- **"路 B"(不加 id、靠"账标 archived 但活目录又出现了"来判重建)**——更省事的止血方案,曾与路 A 二选一;**Q1 已定走路 A,路 B 不再考虑**(见 [Q1](#开放问题))。
- **并发写冲突、首次运行 O(N²)、死代码清理**——是另外的独立工作项,见 review 记录,不在本次范围。

---

## 现状 → 改后

| 维度 | 现状(真实代码) | 改后 |
|---|---|---|
| skill 身份 | 路径里的"名字"(`项目id/名字`) | 创建时盖的**稳定唯一 id** |
| 账本 key | `resolveScope`/`scanSkills` 从路径拼 `项目id/名字` | 用 id(暂定 `项目id/id`,见 [Q4](#开放问题)) |
| 同名重建 | 撞旧账、寄生、污染分母、永不被判 | 新 skill 拿到**自己的新账**,正常被判;旧账冻结、不污染 |
| id 存储 | 无 | SKILL.md frontmatter 加一个 `id` 字段(暂定,见 [Q2](#开放问题)) |
| id 产生 | 无 | 创建 skill 时由 `skill-manage-tool` 盖(暂定,见 [Q3](#开放问题)) |
| 老 skill / 老账本 | —— | 迁移:无 id 时回退到按名字(过渡期),见 [Q5](#开放问题) |
| 占比判据 / 出生水位 / 归档搬移 | 有 | **保留不动**(沿用 `RELATIVE_USAGE_DESIGN.md`) |

---

## 对旧文件的修改

> 每处标 **侵入式**(改了旧行为有回归风险)还是 **增量式**(只加内容旧路径不变)。依据指向决策记录 D#。

| 旧文件:位置 | 改什么 | 性质 | 依据 |
|---|---|:---:|---|
| [`skill/index.ts :: Info`](../../skill/index.ts#L33) | frontmatter schema 加可选字段 `id` | **增量式**(加可选字段,旧 skill 无此字段仍解析通过) | D1/D3 |
| [`skill-manage-tool.ts :: buildContent`](../skill-manage-tool.ts#L44) | `create` 动作时生成唯一 id 写进 frontmatter | **侵入式**(创建流程多盖一个字段) | D2 |
| [`tool/skill.ts`](../../tool/skill.ts#L69) `bumpUse` 调用点 | 把已解析的 skill id 传给 `bumpUse`(不再只靠 location) | **侵入式**(签名加参) | D5 |
| [`usage.ts :: resolveScope`](./usage.ts#L93) / `bumpUse` | key 改用 id(优先 id,缺失回退名字) | **侵入式**(key 口径变,核心) | D4/D7 |
| [`usage.ts :: UsageRecord`](./usage.ts#L26) | 记录加 `id` 字段(并保留 `name` 作展示) | **增量式**(加字段;老记录回填,见 D7) | D4/D7 |
| [`curator.ts :: scanSkills`](./curator.ts#L90) | 扫描时读 SKILL.md frontmatter 拿 id 来定 key | **侵入式**(scan 现在只 stat、不读内容,改成要读) | D3/D6 |
| `usage.ts` / `curator.ts` 其余(占比判据、出生水位、归档搬移、墓碑、孤儿清理) | **保留不动** | 不改 | —— |

---

## 核心机制详解

### 1. 身份从哪来:创建时盖 id

- 进化 skill 由 AI 通过 [`skill-manage-tool`](../skill-manage-tool.ts) 的 `create` 动作创建,frontmatter 在 [`buildContent`](../skill-manage-tool.ts#L44)(拼 `---\nname...\ndescription...\n---` 的函数)里生成。
- 改动:`create` 时生成一个**稳定唯一 id**(候选:UUID / 时间戳+随机后缀,见 [Q3](#开放问题)),写进 frontmatter 的 `id` 字段。一经写入永不改、永不复用(原则 2)。

### 2. 身份怎么读:顺着已解析的 SKILL.md 传

- 加载 skill 时,[`skill/index.ts`](../../skill/index.ts#L246) 本就用 `Info` schema 解析过 frontmatter。给 `Info` 加可选 `id`([skill/index.ts:33](../../skill/index.ts#L33)),解析结果就带上 id。
- [`tool/skill.ts`](../../tool/skill.ts#L69) 调 `bumpUse` 时,把这个已解析的 id 一并传进去(原则 5,不为拿 id 再读一次盘)。

### 3. 身份怎么用:账本按 id 认人

- [`UsageRecord`](./usage.ts#L26)(账本一条记录)加 `id` 字段;key 改用 id(暂定 `项目id/id`,见 [Q4](#开放问题))。
- [`resolveScope`](./usage.ts#L93) 在有 id 时用 id 拼 key;无 id(老 skill / 迁移期)回退到名字(D7)。
- curator 的 [`scanSkills`](./curator.ts#L90) 改成读 SKILL.md frontmatter 拿 id 定 key(它现在只 `fs.stat`、不读内容,这是侵入点,见 [Q6](#开放问题) 讨论代价)。

### 4. 为什么这样就不撞车

- 旧 `foo`(id=A)归档 → 账 A 标 `archived`,**它的目录在 `archive/`,原位置 `skills/foo` 空了,没有任何活 skill 解析出 key A** → 账 A 的次数从此冻结(符合 D6 单调分母假设)。
- 新 `foo`(id=B)→ 加载解析出 key B → 账本无 B → 新建账 B,正常计数、正常被判。
- 账 A(archived,冻结)与账 B(active)各算各的:分母里 A 是合法的冻结历史、B 是自己的量,**新 skill 的流量不再灌到 A 上,不再稀释兄弟**。问题 A 的 1~4 全部消解。

---

## 格式样例

**改后的 SKILL.md frontmatter(加 `id`;`name`/`description` 不变)**:

```markdown
---
id: "skl_2026a1b2c3d4"          # 新增:创建时盖,永不变/不复用(格式见 Q3)
name: "foo"
description: "..."
category: "Testing"
---

<body>
```

**改后的账本记录(`usage.json` 一条)**:

```json
{
  "<projectId>/skl_2026a1b2c3d4": {
    "id": "skl_2026a1b2c3d4",
    "projectId": "<projectId>",
    "name": "foo",
    "location": "/home/.../<projectId>/skills/foo",
    "use_count": 12,
    "born_at_project_total": 50000,
    "last_used_at": "...",
    "recent_uses": [],
    "state": "active",
    "pinned": false,
    "archived_at": null
  }
}
```

> 注:key 用 id,`name` 仍保留(展示 + 迁移期回退)。旧 `foo`(归档)与新 `foo` 会是两条不同 key 的账。

---

## 核心不变量

1. **id 唯一且稳定** — 一个 skill 的 id 创建后永不变;不同 skill(含同名先后两个)id 必不同;id 永不复用。
2. **同名不撞账** — 归档后同名重建,新 skill 必拿到与旧账不同的 key,得到自己的记录。
3. **归档账冻结** — 一条 `archived` 账的 `use_count` 不再被任何活 skill 顶高(没有活 skill 解析到它的 key)。
4. **分母不被污染** — 同项目占比的分母里,每条 `use_count` 都归属于唯一一个真实 skill,无"多个 skill 共用一条账"导致的虚高。
5. **向后兼容** — 老 skill / 老账本无 id 时,系统按名字回退工作,不崩、不误删(迁移期)。
6. **范围不变** — 仍只给 / 只管进化区(`<root>/<projectId>/skills/`)skill,不扩到手动装 / 内置。

---

## 决策记录

> 本文档自有 D 编号,与 `RELATIVE_USAGE_DESIGN.md` / `CURATOR_DESIGN.md` 的 D 编号**互不干扰**。多数为**暂定**,待导师对齐(见开放问题)。

- **D1:给 SKILL.md frontmatter 增一个可选 `id` 字段当 skill 身份。** 原因:身份必须随 skill 走、可被扫描读到;frontmatter 是 skill 自带、已被解析的地方,最自然。可选 → 老 skill 不带也能解析(增量式)。**待对齐(Q2:存 frontmatter 还是 sidecar)。**
- **D2:id 在 `skill-manage-tool` 的 `create` 动作生成并写入。** 原因:这是进化 skill 唯一的创建入口,盖在这里能保证"出生即有 id"。**待对齐(Q3:id 格式/生成方式)。**
- **D3:`Info` schema 加可选 `id`,加载链顺带解析。** 原因:复用已有解析,不新增读盘(原则 5)。
- **D4:账本 `UsageRecord` 加 `id`,key 改用 id。** 原因:这是修复的核心——按 id 认人才能让同名不撞(不变量 2)。**待对齐(Q4:key 用 `项目id/id` 还是纯 id)。**
- **D5:`bumpUse` 增 id 入参,由 `tool/skill.ts` 从已解析 skill 传入。** 原因:热路径拿 id 不额外读盘。
- **D6:curator `scanSkills` 读 frontmatter 拿 id。** 原因:扫描必须能按 id 给磁盘 skill 定 key。代价:scan 从"只 stat"变"读+解析",见 [Q6](#开放问题)。
- **D7:无 id 回退按名字 + 老记录迁移。** 原因:向后兼容(不变量 5)。**待对齐(Q5:迁移策略)。**

---

## 开放问题

> `Q#` 编号。下面每条都给了**暂定建议方案**(已尽量定到可实现),但仍须**导师/团队最终拍板**——尤其涉及"改写用户 SKILL.md""scan 多读盘"这类有代价的决定。

- **Q1(已定):走路 A(加唯一 id 治根),不走路 B。** 用户 2026-06-18 拍板。理由:B(不加 id、靠"账标 archived 但活目录又出现"检测式止血)收尾不干净(旧账/旧副本仍要权衡),A 从源头消除撞车。路 B 不再考虑。
- **Q2:id 存哪?→ 建议:写进 SKILL.md frontmatter。** 它是 skill 的元数据(和 `name`/`description` 同类),放 frontmatter 最自然:跟着 skill 走、复用已有解析(不额外读盘)、随拷贝/移动一起带。**"只放 usage" 已排除**——账本只有"路径/名字"这把会被复用的把手,分不清同名新旧(这正是病根)。误删风险(用户/AI 手改 SKILL.md 删了 id 行)用"`edit` 动作保留 id + 缺失则按 Q5 回退"兜。备选 sidecar 文件(`.skill-id`)更防误删但多一个文件、易在拷贝时掉队——**倾向 frontmatter,待确认。**
- **Q3:id 怎么生成?→ 已定:`skl_${ulid()}`(已实现于里程碑1)。** 起初想用 [`id/id.ts`](../../id/id.ts) 的 `Identifier.create`,但它的前缀表是写死的一组(`event|session|message|…`)、**没有 `skill`**,要用它得先改那个共享文件加前缀;而 `ulid`(已是现成依赖,memory 模块用 `mem_${ulid()}`)无需动共享代码、写法一致。故采用 `skl_${ulid()}`——唯一、稳定、不复用。**`create` 盖、`edit` 保留不重盖、`edit` 到无 id 老 skill 时顺手补盖一个**(用户已在改这个文件,属合理懒迁移)。
- **Q4:账本 key 用 `项目id/id` 还是纯 `id`?→ 建议:`项目id/id`。** 与现有 `项目id/名字` 形态一致、迁移平滑;`projectUseCount`(算分母)本就按 projectId 过滤、记录里也存 projectId。**倾向 `项目id/id`,待确认。**
- **Q5:老 skill / 老账本怎么迁移?→ 建议:新 skill 立即带 id;老的 / 无 id 的回退按名字(维持现状),不主动改写用户的 SKILL.md。** 关键洞察:只要"**新建**的 skill 都带 id",任何新建(包括占用一个老名字槽位的)都按 id 走、不撞 → **bug 对所有新 skill 即刻修复**;只有"两个都早于 id 功能的老 skill 同名"这种纯历史情形维持原样(本就如此、风险未新增)。给老 skill 补盖 id 作为**可选的一次性迁移脚本**,不自动跑(避免无差别改写用户文件)。**倾向最小侵入回退,待确认要不要做一次性补盖。**
- **Q6:`scanSkills` 从"只 stat"改成"读 + 解析 frontmatter 拿 id"的代价可接受吗?→ 建议:接受。** 复用 `Info` 解析;curator 默认 7 天一次、跑后台、N(进化区 skill 数)不大,多一次读 + 解析 / skill 可接受。与 Q2 联动(若改 sidecar 则只读一小文件、更省)。**倾向接受,待确认。**
- **Q7:id 化后墓碑(`deleted`)复活逻辑要不要收回?→ 建议:收回。** id 永不复用 → `deleted` 记录的 key 不会被任何新 skill 撞上 → bumpUse 里上一轮加的"复活"分支(撞到 deleted 就复活)变成死代码,id 化稳定后**移除**。**待 id 化落地后清理。**

---

## 关键文件速查

| 文件 | 作用 | 性质 |
|---|---|:---:|
| [`usage.ts`](./usage.ts) | 账本读写;`resolveScope` 定 key、`UsageRecord`、`bumpUse`、`projectUseCount` | ⚠️ 侵入改 |
| [`curator.ts`](./curator.ts) | 扫描/归档;`scanSkills` 定 key | ⚠️ 侵入改 |
| [`skill-manage-tool.ts`](../skill-manage-tool.ts) | 进化 skill 创建入口;`buildContent` 拼 frontmatter | ⚠️ 侵入改 |
| [`skill/index.ts`](../../skill/index.ts) | SKILL.md 解析(`Info` schema) | ⚠️ 增量改 |
| [`tool/skill.ts`](../../tool/skill.ts) | skill 加载入口,调 `bumpUse` | ⚠️ 连带改 |
| [`RELATIVE_USAGE_DESIGN.md`](./RELATIVE_USAGE_DESIGN.md) | 占比判据设计(本次不改,仅依赖) | — |

---

## 复用组件核实(实现前必读)

> `X#` 编号。实现前先核实这些事实成立,别凭空假设。

- **X1:`Info` schema 是 SKILL.md frontmatter 的唯一解析口。** [skill/index.ts:33](../../skill/index.ts#L33) `z.object({ name, description, ... })`,[:246](../../skill/index.ts#L246) `Info.pick(...).safeParse(md.data)`。加可选 `id` 后老 skill(无 id)仍 `safeParse` 通过 → 需核实可选字段不破坏现有解析。
- **X2:`buildContent` 是进化 skill 写 frontmatter 的唯一处。** [skill-manage-tool.ts:44](../skill-manage-tool.ts#L44)。核实 `create` 与 `edit` 路径——`edit` 不能重盖/丢失已有 id。
- **X3:`scanSkills` 现在只 `fs.stat(SKILL.md)`、不读内容。** [curator.ts:102](./curator.ts#L102)。改成读+解析是真实增量 I/O,需核实代价(Q6)。
- **X4:`resolveScope` 现在纯靠路径,不读文件。** [usage.ts:93](./usage.ts#L93)。若 key 改用 id,resolveScope 要么也读文件、要么由调用方把 id 传进来(与 D5 一致)——核实两个调用方(`bumpUse`、`seedIfMissing`)都能拿到 id。
- **X5:`bumpUse` 调用方是 [tool/skill.ts:69](../../tool/skill.ts#L69)(每次加载)。** 核实该处能拿到已解析的 skill id(来自 X1 的解析结果)。
- **X6:已有 `usage.json` 记录无 `id` 字段。** 核实 `load` 的回填逻辑(沿用 RELATIVE_USAGE_DESIGN.md 的 best-effort backfill 模式)能安全处理。

---

## 命题清单

> 按主题分组,每条是可判定真假的行为断言;对应要写的测试。

### PA. id 身份
- A1. `skill-manage-tool` 的 `create` 写出的 SKILL.md frontmatter 含一个非空 `id`。
- A2. 对同一个 skill 多次 `edit`,`id` 保持不变(不被重盖)。
- A3. 两次 `create`(哪怕同名)得到的 id 不同。

### PB. 账本按 id 认人
- B1. 加载一个带 id 的 skill → 账本记录的 key 由 id 决定,`name` 仍记录在案。
- B2. 同项目、同名、不同 id 的两个 skill → 账本里是**两条**记录。
- B3. 归档 id=A 后,新建同名 id=B 并调用 → A 的 `use_count` 不变(冻结),B 有自己的 `use_count`。

### PC. 不污染分母(复现并修掉根因)
- C1. 旧 `foo`(id=A)归档、新 `foo`(id=B)被调用 N 次 → 同项目兄弟 `bar` 的占比**不被这 N 次稀释**(对照:按名字做 key 时会被稀释 → 旧实现红)。
- C2. 新 `foo`(id=B)占比够低且过试用期 → 被正常归档(不再"永不被判")。

### PD. 向后兼容
- D1'. 老 skill(SKILL.md 无 id)加载 → 不崩,按名字回退建账(迁移策略见 Q5 定案后细化)。
- D2'. 老 `usage.json`(记录无 id)`load` → 不崩,安全处理。

### PH. 边界与失败用例(必须覆盖)
- H1. frontmatter 的 `id` 字段被手动删/损坏 → 解析不崩(回退按名字,best-effort)。
- H2. 两个 skill 不慎拿到相同 id(理论冲突)→ 行为可定义(报警/二次区分),不静默错乱。
- H3. 空账本 / 损坏账本 → 沿用现有 best-effort,不崩。

---

## 测试与红绿里程碑

> 走 TDD,先红后绿,两次输出都留。从 `packages/opencode` 跑。

### ⚠️ 假绿陷阱 / 写读接缝

- **测行为不测实现**:断言"同名两 skill 在账本里是两条记录""兄弟占比不被稀释",不要断言"调了某函数"。
- **写读接缝(关键)**:id 是"创建时写进 SKILL.md → 加载时读出来 → 账本按它建 key → 归档判据按它认人"的**跨多步、跨文件**状态。测试必须**真跑这条接力**:真用 `skill-manage-tool` 创建(写 id)→ 真加载(读 id)→ 真 `bumpUse`(按 id 建账)→ 真跑 curator 判一遍。**禁止出题人手填 id 直接喂账本**——那只测了"按 id 认人"这一个零件,没测"创建写进去的 id 到底被读出来、用对 key 没有"这条最容易坏的接缝。
- **必须有先红**:C1(兄弟不被稀释)这条,在"按名字做 key"的旧实现下应**红**(兄弟被稀释/被误归档),改成按 id 后**绿**——这条用例证明测试真在测根因修复、不是恒绿。

### 红绿里程碑(婴儿步,按依赖排序)

1. **里程碑1(id 落盘)**:`create` 写出的 SKILL.md 含非空 id(A1);`edit` 不改 id(A2)。
2. **里程碑2(id 读出)**:`Info` 解析带出 id;老 skill 无 id 解析不崩(X1/H1)。
3. **里程碑3(账本按 id 建 key)**:`bumpUse` 用 id 当 key,记录带 id+name(B1)。
4. **里程碑4(同名两条账)**:同项目同名不同 id → 两条记录(B2)。
5. **里程碑5(根因修复,写读接力)**:真跑 创建A→归档A→创建同名B→调用B→curator 判,断言 A 冻结、B 自己计数、**兄弟不被稀释**(B3/C1/C2)。**这条是核心红→绿。**
6. **里程碑6(兼容 + 边界)**:老账本/老 skill 回退(D1'/D2')、损坏 id(H1)、id 冲突(H2)。

### 收尾验证

- 跑 `usage.test.ts` + `curator.test.ts` + skill 创建相关测试全绿,贴红→绿。
- 跑 `bun turbo typecheck --filter=aether`,贴 "successful"。

---

## 范围说明

**本次做**:把 curator 的 skill 身份从"名字"换成"创建时盖的稳定唯一 id",修掉"归档后同名重建撞车"根因。改 `skill-manage-tool`(盖 id)、`skill/index.ts`(解析 id)、`tool/skill.ts`(传 id)、`usage.ts`/`curator.ts`(按 id 建 key + 记录加 id + 兼容),连带相关测试。

**本次不做**(留给后续独立工作):
- 占比判据 / 出生水位 / 试用期 / 阈值——沿用 `RELATIVE_USAGE_DESIGN.md`。
- 路 B(检测式止血)——Q1 已定走路 A,路 B 不做。
- 并发写冲突、首次运行 O(N²)、死代码清理(`forget`/死计数器/`mtimeMs`/`stale` 等)——独立工作项。
- 墓碑/复活逻辑简化(Q7)——待 id 化定案后再评估。

---

## 用户体验

- 对你来说的变化:**skill 库不会再"认错人"了**。以前一个 skill 被自动收进仓库后,你又做了一个**同名**的新 skill,系统会把它俩当成同一个——新 skill 既得不到"新手保护期"、又永远不会被正常清理,还会连累同项目别的好 skill 被误收。改完之后,每个 skill 有自己永久的"身份证",同名的新旧 skill 互不影响:新 skill 正常享受试用期和清理判定,老的归档记录乖乖冻结、不再拖累别人。
- 没有界面变化;这是后台"谁是谁"的认人逻辑修正。

> ⚠️ 本文档是**设计草案,尚未写代码、未跑测试**,属"无法验证(纯文档)"。**开放问题 Q1(A/B 路线)是地基决策,务必先与导师对齐再进实现**;Q2–Q7(id 存哪/怎么生成/key 形态/迁移/scan 代价/墓碑简化)也都待定。
