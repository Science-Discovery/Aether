# 交接文档：让 skills 弹窗的两个开关（禁用 / 取消自进化）真正生效

> 这份文档是给一个**全新会话**直接照做的。读完即可开工，不需要回溯上一段对话。
> 仓库：Aether（monorepo，主要改 `packages/opencode`）。当前分支 `feat/evolved-skills-button`，工作树干净。

---

## 0. 背景（为什么要做这个）

prompt 输入框里有个 skills 弹窗，每个 skill 有两个开关：

- **禁用 skill**：拨了应让这个 skill 不再加载给 AI。
- **取消自进化**：拨了应让后台审查 AI 不再自动改写这个 skill。

**现状是两个开关都「写了没人读」**：点开关会把状态写进 SKILL.md 的 frontmatter（`enabled` / `evolution_enabled`），
但 **加载器解析 SKILL.md 时只取 `name` 和 `description`，那两个字段读出来就扔了**；
审查链路也从不读它们。所以两个开关现在**完全不起效**。

本任务：把开关状态改成存进**配置文件**（按 SKILL.md 的**文件路径**，不写进 SKILL.md），
并补上「加载器读它」「审查链路读它」这两个缺失环节。

---

## 1. 必须遵守的工作方式（来自仓库主人的硬约束）

1. **TDD（测试先行）**：核心逻辑先写会失败的测试（红），再写实现（绿）。**交付时要能展示先红后绿两次跑测输出。**
2. **婴儿步**：一次只让一个新测试变绿，每个里程碑独立走红→绿，别一口气写完再补一个大测试。
3. **找根因、禁止补丁式修复**：不要用 try/catch 吞错、if 特判绕过来「修好」表象。
4. **改完必须有证据**：跑 typecheck / 测试，贴出结果才算完成。"看起来对"不算。
5. **不要 git commit / 不要删文件**，除非主人明说。
6. **测试质量**：断言要对具体值（禁止 `expect(true).toBe(true)`）；测行为不测实现；必须覆盖一个边界/失败用例。
7. 不新增依赖（不要 `bun add`）。

### 命令（重要，否则跑不起来）
- **跑测试**：必须在 `packages/opencode` 目录内跑，仓库根目录跑 `bun test` 会被守卫挡掉
  （报错 `do-not-run-tests-from-root`）。
  例：`cd packages/opencode && bun test src/skill/skill-disable.test.ts`
- **类型检查**：`cd packages/opencode && bun run typecheck`（底层是 tsgo --noEmit）。

---

## 2. 关键设计决策（已和主人敲定，别再改方向）

### 2.1 状态存哪：存配置文件，按「文件路径」指认，不碰 SKILL.md
- 用 SKILL.md 的**绝对路径**当 key（不是用 skill 名字）。
  原因：同名 skill 会撞车（项目级 + 全局级可能同名），按名字禁会一禁禁一片，按路径才精确。
- 不写进 SKILL.md frontmatter，避免污染 skill 文件、避免进 git diff。

### 2.2 禁用范围：跟着 skill 的「归属层」走（这是主人反复强调的）
规则一句话：**禁全局 skill 就全局生效；禁项目 skill 就只在该项目生效。**

落地判断标准（用代码里现成的 `scope` 概念，别自己另立标准）：
每个 skill 来源带一个 `scope` 字段（见 `packages/opencode/src/skill/index.ts:58`）：
```ts
export type Scope = "global" | "project" | "config-root" | "paths" | "urls"
```
按「优先级在全局级及以下算全局，其余算项目」：
- **写全局配置**（`Config.updateGlobal`）：scope = `global` | `config-root`
- **写项目配置**（`Config.update`，写当前项目的 config.json）：scope = `project` | `paths` | `urls`

> 注：scope 在 loadSkills 里逐源赋值（`skill/index.ts` 约 275/283/290/302/316/323 行）。
> 优先级 = 扫描顺序（后扫的覆盖先扫的）。config-root 最低、global 次低 → 算"全局及以下"。

### 2.3 取消自进化：双保险（①+② 一起做）
- **① prompt 警示（必须给 AI 看，不能从清单里删）**：被取消的 skill **照常**出现在喂给审查 AI 的清单里，
  但在审查 prompt 里加一段明确指令：「以下 skill 已被用户禁止自进化，**不许修改它们，也不许新建功能重复的 skill**」。
  > 为什么不直接从清单删？因为 AI 看不到它就可能"以为没有这个能力"而**重造一个几乎一样的 skill**，等于绕过禁令。
- **② 落盘硬拦（兜底）**：审查 AI 真正写 skill 是通过 `skill_manage` 工具。在它的写入执行处加一道闸：
  目标文件在「禁止自进化清单」里就**拒绝写、报错**。这是"AI 没听 prompt 话也拦得住"的硬保证。

### 2.4 前端显示态：完全由配置层决定（钉死，别再加只读/置灰）
- 弹窗里每个 skill 的开关亮不亮，**完全由配置层算**：看该 skill 的 SKILL.md 路径**是否在 `disabled_files` /
  `evolution_disabled_files` 里**。在 = 关（禁用/已取消自进化）；不在 = 开（默认）。
- **不再从 SKILL.md 的 frontmatter（`enabled` / `evolution_enabled`）读显示态**。
- 推论（主人已确认这是**预期行为**，不是 bug，别试图"修复"）：
  - 在项目 A 禁了某**全局** skill → 写进全局配置 → 项目 B 打开弹窗会看到它"已禁用"；
    在 B 里重新打开它 → 改的还是全局配置 → 回到 A 也变回"可用"。
  - 因为全局 skill 的状态存在**全局配置这一层（所有项目共用同一份）**，谁在哪个项目里拨都生效于所有项目。
  - **不许**为了"防误触"给全局 skill 的开关加只读 / 置灰 / 锁。全局 skill 的开关在**任意项目**里都可正常拨动。

### 2.5 本任务范围（钉死，别扩大）
- **只改这两个新开关**（evolved-skills 弹窗里的「禁用」「取消自进化」）。
- **老的「默认 Skills」弹窗（用 `skills.disabled` 按名字那套）原样不动**，不要顺手重构它，避免不相干回归。

---

## 3. 要碰的文件与锚点（已核实，行号可能漂移，开工前先 grep 确认）

| 作用 | 文件 | 锚点 |
|---|---|---|
| 配置 schema（加字段） | `packages/opencode/src/config/config.ts` | `export const Skills = z.object({` ≈ L770；`disabled:` 在 L776 |
| 配置读/写函数 | 同上 | `get()` L1478、`getGlobal()` L1482、`update()` L1486、`updateGlobal()` L1734；`globalFiles()` L1367、`global` lazy L1375 |
| 配置分层合并 | 同上 | `load()` 内 L124~140 用 `mergeConfigConcatArrays(result, await global())` / 项目层同样调用 |
| 老的按名字禁用（参考，别复用） | 同上 | `toggleSkill()` ≈ L1616，用的是 `updateGlobal({skills:{disabled}})` |
| 加载器删被禁 skill | `packages/opencode/src/skill/index.ts` | `// Remove disabled skills` L330；`cfg = await Config.get()` L307；`Skill.Info` 有 `.location`/`.name` |
| skill scope 定义 | 同上 | `export type Scope` L58；各源赋 scope L275/283/290/302/316/323 |
| 配置层路径工具 | `packages/opencode/src/config/paths.ts` | `namespace ConfigPaths` L11；`projectFiles()` L12 |
| 审查 prompt 组装（加①警示） | `packages/opencode/src/skill-evolution/review-agent.ts` | `buildReviewPrompt()` L152；`skillLocationMap` L220~235；`spawnReview` L171 |
| 审查 prompt 常量 | `packages/opencode/src/skill-evolution/constants.ts` | `SKILL_REVIEW_PROMPT_BASE` |
| 落盘硬拦（②） | `packages/opencode/src/skill-evolution/skill-manage-tool.ts` | `createBoundSkillManageTool(...)`（在 review-agent L265 注册）；写入执行处 |
| 弹窗后端路由（开关写配置 + 显示态读配置） | `packages/opencode/src/server/routes/config.ts` | `/skills/evolution`(list) L167、`/skills/evolution/toggle` L207 |
| 弹窗扫描/列举逻辑 | `packages/opencode/src/skill-evolution/evolved-skills.ts` | `list()` L200、扫描目录 L127~140 |

---

## 4. ⚠️ 必做：把两个新字段加进「拼接白名单」（已查实，照做即可）

**结论（已看源码实现，不用再验证）**：配置分层合并的 `mergeConfigConcatArrays`（`config.ts:74`）行为是
**「默认替换 + 白名单字段才拼接」**：

```ts
function mergeConfigConcatArrays(target, source) {
  const merged = mergeDeep(target, source)   // ← 数组默认被「替换」（remeda mergeDeep）
  if (target.plugin && source.plugin)            merged.plugin = 拼接去重
  if (target.instructions && source.instructions) merged.instructions = 拼接去重
  if (target.disabled_models && source.disabled_models) merged.disabled_models = 拼接去重
  return merged
}
```

只有 `plugin` / `instructions` / `disabled_models` 三个字段被特殊处理成「跨层拼接去重」，**其余数组一律被高优先层整份覆盖**。

**问题**：我们的 `disabled_files` / `evolution_disabled_files` 不在白名单里 → 默认会被「替换」。
后果：用户**同时**在全局禁了 A、在项目禁了 B 时，项目层会整份盖掉全局层 → 只剩 B，**A 的禁用丢失**（禁了的全局 skill 又冒出来）。

**为什么必须是拼接而不是替换**：这俩字段装的是「被禁路径的**集合**」，语义是并集（各层禁的合起来都禁），
不是"单值开关"（那种才需要项目盖全局）。所以正确合并 = 并集 = 拼接去重。

**怎么做（钉死）**：在 `mergeConfigConcatArrays`（`config.ts:74`）里，给 `merged.skills` 的这两个数组也加拼接去重。
注意它们在 `skills` 子对象下（不是顶层），示例：
```ts
// 在 return merged 之前补：
const td = target.skills, sd = source.skills
if (td || sd) {
  merged.skills = { ...(td ?? {}), ...(sd ?? {}) }  // mergeDeep 已合过，这里只覆写要拼接的两项
  for (const f of ["disabled_files", "evolution_disabled_files"] as const) {
    if (td?.[f] && sd?.[f]) merged.skills![f] = Array.from(new Set([...td[f]!, ...sd[f]!]))
  }
}
```
> 上面是示意，落地时按实际类型调整（注意 `skills` 可能 undefined）。**先写测试**：全局层放 `disabled_files:[A]`、
> 项目层放 `disabled_files:[B]`，断言 `Config.get()` 的 `skills.disabled_files` 同时含 A 和 B（红→绿）。

**做完这步后**：加载器和审查链路**直接读 `cfg.skills?.disabled_files`**（来自 `Config.get()`，已是跨层并集），
**不需要**任何额外的「逐层并集」辅助函数。

> 上一段会话里前一个助手误判过：先以为"反正拼接"直接读合并值（漏了它其实是替换），
> 又反过来多写了个 `skillFilesUnion` 并集函数。**正解是改白名单**（上面这步），别写那个并集函数。

---

## 5. 实施步骤（婴儿步，每步独立红→绿）

### 红绿总览（共 6 次独立的红→绿；I 节是贯穿规矩，不是里程碑）
| 次序 | 里程碑 | 红（先写失败测试） | 绿（写实现） |
|---|---|---|---|
| 1 | A 加载器按路径禁用 | 配置禁某 skill，断言加载后它不在 | 加载器读 `disabled_files` 删它 |
| 2 | 第4节 拼接白名单 | 全局+项目各禁一个，断言合并后两个都在 | 把两字段加进 `mergeConfigConcatArrays` |
| 3 | B 写对配置层 | 禁全局→落全局配置；禁项目→落项目配置 | 写"看路径判归属"的公共函数 |
| 4 | C 弹窗接线 + 停写 SKILL.md | （UI 实测为主）开关态读配置 | 改 toggle 路由走新函数、**删掉旧的写 frontmatter 逻辑** |
| 5 | D 自进化 prompt 警示 | 清单非空时 prompt 含禁改文案 | `buildReviewPrompt` 拼警示 |
| 6 | E 自进化落盘硬拦 | 禁了的 skill 写入被拒、文件不变 | `skill_manage` 写入处加闸 |

> 顺序建议：先做第 4 节（拼接白名单）→ 再 A → B → C → D → E。第 4 节是 A 正确性的前提。

### Schema 准备（不算里程碑，是数据形状）
在 `Skills` schema（config.ts L770 块，紧跟 `disabled:` 那行后面）加两个字段：
```ts
disabled_files: z
  .array(z.string())
  .optional()
  .describe("List of skill SKILL.md file paths to deactivate (precise per-file disable)"),
evolution_disabled_files: z
  .array(z.string())
  .optional()
  .describe("List of skill SKILL.md file paths whose self-evolution is disabled"),
```

### 里程碑 A：加载器按路径禁用（这是根因修复，先做）
- **红**：新建 `packages/opencode/src/skill/skill-disable.test.ts`。
  测试隔离**必须照搬** `skill-priority.test.ts` 的写法（关键，否则 home 路径不对）：
  - 用 `process.env.OPENCODE_TEST_HOME`（**不是** `HOME`！加载器用 `Global.Path.home` = `OPENCODE_TEST_HOME || os.homedir()`）。
  - `beforeEach` 里覆盖 `Global.Path.config` 和 `Global.Path.data` 到临时目录，并调 `Config.global.reset()`；`afterEach` 还原。
  - 用 `Instance.provide({ directory, worktree, project, fn })` 跑（见 `skill-priority.test.ts` 的 `withInstance`）。
  - 写一个项目 skill（如 `.aether/skills/foo`）+ 一个 `bar`，把 `foo` 的 SKILL.md 绝对路径写进**项目** config.json 的 `skills.disabled_files`，
    断言 `Skill.all()` 的 name 列表 **不含 foo、含 bar**。此时应红（加载器还没读 disabled_files）。
  - 再加一个边界用例：按路径禁用只匹配该路径，**不**误伤另一处同名 skill。
- **绿**：在 `skill/index.ts` 的「Remove disabled skills」块（L330 附近，紧跟现有按名字删除之后）加按路径删除：
  ```ts
  // Remove disabled skills (by file path — precise per-file disable)
  const disabledFiles = new Set((cfg.skills?.disabled_files ?? []).map((p) => path.resolve(p)))
  if (disabledFiles.size > 0) {
    for (const [name, skill] of Object.entries(state.skills)) {
      if (disabledFiles.has(path.resolve(skill.location))) {
        delete state.skills[name]
        log.info("skill disabled by config file path", { name, location: skill.location })
      }
    }
  }
  ```
  （`cfg` 已在 L307 由 `Config.get()` 取得。前提是**已先做完第 4 节**——把两字段加进拼接白名单后，
  `cfg.skills?.disabled_files` 就是跨层并集，这样直接读即可，**不用**写并集函数。）

### 里程碑 B：开关写到正确的配置层（按 scope 决定全局/项目）
- **红**：测试「禁用一个 global scope 的 skill → 路径落进**全局**配置，不在项目配置」「禁用一个 project scope 的 skill → 落进**项目**配置」。
- **绿**：新增**一个公共写入函数**（建议放 `Skill` 命名空间，因为要拿到 skill 的 scope）。
  **禁用 和 取消自进化 共用同一个函数**，只用一个参数区分写哪个字段——别写两份重复代码（DRY）。
  建议签名：`setSkillFileFlag(file, field, on)`，其中 `field` 为 `"disabled_files" | "evolution_disabled_files"`，`on` 为 true=加进清单 / false=移除。
  - 先由文件路径求出该 skill 的 scope（拿 `Skill.sources()` 里每个 source 的 `dir`+`scope`，找包含该文件、且 dir 最长（最具体）的 source）。
  - scope ∈ {global, config-root} → `Config.updateGlobal(...)`；否则 → `Config.update(...)`（写当前项目 config.json）。
  - "看路径判归属 → 选层 → 读该层现值增删"这套逻辑两个开关完全复用，唯一差异是传入的 `field`。
  - **坑**：`Config.get()` 是合并后的（含其它层），**不能**拿它的数组整份写回单一层，否则会把别层的条目搬错层。
    要读「该层自己的当前值」再增删：全局层用 `Config.getGlobal()`；项目层读 `Instance.directory/config.json`（`Config.update` 内部本就 mergeDeep 现有项目文件，注意 mergeDeep 对数组是替换，所以传入前要带上该层已有的完整数组）。

### 里程碑 C：弹窗接线（点开关 → 调里程碑 B 的函数；显示态 → 读配置；**停止写 SKILL.md**）
- 改 `server/routes/config.ts` 的两个 toggle 路由（`/skills/evolution/toggle` 走 `enabled`、`/skills/evolution/toggle-evolution` 走 `evolution_enabled`）：
  改成调里程碑 B 的公共写函数（禁用传 `disabled_files`、取消自进化传 `evolution_disabled_files`）。
- **删掉旧的写 SKILL.md 逻辑**：`evolved-skills.ts` 的 `toggleEnabled`/`toggleEvolution`（约 L209/L216）现在用 `setFrontmatterFlag` + `atomicWrite` 把 `enabled`/`evolution_enabled` 写进 SKILL.md frontmatter。
  **本任务目标包含让这两个开关不再写 SKILL.md** —— 路由改走配置写函数后，把这两个旧函数（及只服务它们的 `setFrontmatterFlag` 等）一并移除/停用，别留着继续污染 skill 文件。
  （`list()` 里读 `enabled`/`evolution_enabled` frontmatter 的部分见下条一起处理。）
- 改 list 路由 / `evolved-skills.ts` 的 `list()`（约 L200）：每个 skill 的 `enabled`/`evolution_enabled` 显示态改为从**配置**算（路径是否在 `disabled_files`/`evolution_disabled_files` 里），不再从 SKILL.md frontmatter 读。
- 前端 UI 类改动按主人规则**必须实测 app**（不是只 typecheck）。

### 里程碑 D：取消自进化 ① — prompt 警示
- **红**：测试 `buildReviewPrompt(...)`（review-agent.ts L152）在「禁止自进化清单」非空时，
  产出的 prompt 包含对这些 skill 的禁改警示文案。
- **绿**：在 `buildReviewPrompt` 里读 `cfg.skills?.evolution_disabled_files`（第 4 节做完后已是跨层并集），
  把命中的 skill 名/路径拼成一段警示加进 prompt（可放在 `SKILL_REVIEW_PROMPT_BASE` 之后）。

### 里程碑 E：取消自进化 ② — 落盘硬拦
- **红**：测试 `skill-manage-tool.ts` 的写执行：当目标 skill 文件在 `evolution_disabled_files` 里时，写入被拒绝/报错，文件未变。
- **绿**：在 `createBoundSkillManageTool` 产出的工具的写入执行处加判断：命中清单则 throw/return 错误，不落盘。

### 收尾验证
- `cd packages/opencode && bun run typecheck`（贴结果）。
- 跑全部新测试 + 相关旧测试（至少 `src/skill/` 和 `src/skill-evolution/`），贴结果。
- 弹窗相关 UI 改动实测 app。

---

## 6. 容易踩的坑（重点）

1. **测试隔离用 `OPENCODE_TEST_HOME`，不是 `HOME`**。加载器看的是 `Global.Path.home`。照抄 `skill-priority.test.ts`。
2. **`bun test` 必须在 `packages/opencode` 里跑**，根目录有守卫会拦。
3. **先做第 4 节（把两字段加进拼接白名单）**，别写并集函数（上个会话多写了无用的 `skillFilesUnion`）。
4. **路径比较先 `path.resolve()` 归一化**两边再比，避免相对/绝对、`..` 差异导致匹配不上。
5. **写配置层时别拿合并后的数组整份写回单层**（会跨层搬运条目）。读该层自身的值再增删。
6. **取消自进化①别从清单删 skill**，要保留可见 + prompt 警示（防 AI 重造同功能 skill）。
7. **mergeDeep（remeda）对数组是替换**；`mergeConfigConcatArrays` 也是「默认替换、仅白名单字段拼接」——我们的两字段默认会被替换，必须靠第 4 节把它们加进白名单才变拼接。别混。
8. UI 改动要实测 app，typecheck 过 ≠ UI 没坏。

---

## 7. 一句话目标回顾
把「开关状态写进配置（按文件路径、按 scope 选全局/项目层）→ 加载器和审查链路读它」这条链补全；
自进化侧用「prompt 警示 + 落盘硬拦」双保险。全程 TDD、先红后绿、婴儿步。

---

## 8. 命题清单（全文信息的命题化复述；每条都是一个可判定真假的断言）

> 这一节把全文压成一串命题，便于核对"有没有漏、有没有自相矛盾"。分组排列，组内大致按重要度递减。

### A. 现状与目标
- A1. 当前两个开关（禁用 skill、取消自进化）都不起效：点开关会**改写 SKILL.md**（`toggleEnabled`/`toggleEvolution` 把 `enabled`/`evolution_enabled` 写进 frontmatter），但无人读取——白写还污染文件。
- A2. 加载器解析 SKILL.md 时只取 `name` 和 `description`，frontmatter 里的 `enabled`/`evolution_enabled` 被丢弃。
- A3. 审查链路（后台自进化）从不读 `evolution_enabled`，所以"取消自进化"对它无效。
- A4. 本任务目标：开关状态改存「配置文件」（按 SKILL.md 文件路径），补上"加载器读它""审查链路读它"两个缺失环节，**并停止往 SKILL.md 写 `enabled`/`evolution_enabled`（移除旧的写 frontmatter 逻辑）**。
- A5. 本任务范围仅限 evolved-skills 弹窗的这两个开关；老的「默认 Skills」弹窗（`skills.disabled` 按名字那套）保持不动。

### B. 状态怎么存
- B1. 状态存进配置文件，不写进 SKILL.md frontmatter（避免污染 skill 文件、避免进 git diff）。
- B2. 用 SKILL.md 的绝对路径当 key，不用 skill 名字（名字会撞车：项目级+全局级可能同名，按名字禁会一禁一片）。
- B3. 新增两个配置字段：`skills.disabled_files`、`skills.evolution_disabled_files`，都是字符串数组（路径清单）。
- B4. 这两个字段语义是「被禁路径的集合」，合并时应取并集，不是"单值覆盖"。

### C. 禁用范围（跟 skill 归属层走）
- C1. 禁全局 skill → 写全局配置 → 对所有项目生效。
- C2. 禁项目 skill → 写该项目自己的配置 → 只对该项目生效，其它项目不受影响。
- C3. 判断写哪层用代码现成的 `scope`（`skill/index.ts:58`）：scope ∈ {global, config-root} 写全局（`Config.updateGlobal`）；scope ∈ {project, paths, urls} 写项目（`Config.update`）。
- C4. 由文件路径求 scope 的方法：在 `Skill.sources()` 里找 `dir` 包含该文件、且 `dir` 最长（最具体）的那个 source，取它的 scope。
- C5. scope 优先级 = 扫描顺序（后扫覆盖先扫）；config-root 最低、global 次低，故二者算"全局及以下"。

### D. 配置分层合并（第 4 节，必做）
- D1. 配置分层合并函数是 `mergeConfigConcatArrays`（`config.ts:74`）。
- D2. 它的行为是「默认替换 + 白名单拼接」：先 `mergeDeep`（数组被替换），再仅对 `plugin`/`instructions`/`disabled_models` 三个字段拼接去重。
- D3. 我们的两个新字段不在白名单里，默认会被高优先层整份替换。
- D4. 若保持默认替换：用户同时在全局禁 A、项目禁 B 时，项目层盖掉全局层 → 只剩 B，A 的禁用丢失（被禁的全局 skill 又出现）。
- D5. 解法（钉死）：把 `disabled_files`、`evolution_disabled_files` 也加进 `mergeConfigConcatArrays` 的拼接去重逻辑（注意它们在 `skills` 子对象下，且 `skills` 可能 undefined）。
- D6. 做完 D5 后，`Config.get()` 返回的这两个数组已是跨层并集；加载器与审查链路直接读 `cfg.skills?.*` 即可，不需要任何额外的逐层并集函数。
- D7. 不要写 `skillFilesUnion` 之类的并集函数（上个会话的弯路）；正解是改白名单（D5）。

### E. 加载器读取（里程碑 A，根因修复）
- E1. 加载器在「Remove disabled skills」块（`skill/index.ts:330` 附近）现仅按名字删（读 `cfg.skills?.disabled`）。
- E2. 新增按路径删：读 `cfg.skills?.disabled_files`，对每个 skill 比对 `path.resolve(skill.location)` 是否在集合里，命中则从 `state.skills` 删除。
- E3. 路径比较两边都先 `path.resolve()` 归一化，避免相对/绝对、`..` 差异导致漏匹配。
- E4. `cfg` 来自 `skill/index.ts:307` 的 `Config.get()`；每个 skill 的 `Info` 带 `.location`（绝对路径）和 `.name`。

### F. 开关写入正确配置层（里程碑 B）
- F1. 新增**一个公共写入函数**（禁用与取消自进化共用，建议 `setSkillFileFlag(file, field, on)`，`field` 区分写哪个字段），按 C3 决定调 `updateGlobal` 还是 `update`；别写两份重复代码。
- F2. 写某一层时不能拿 `Config.get()`（合并值）整份写回该层，否则会把别层条目搬错层。
- F3. 要读"该层自身的当前值"再增删：全局层用 `Config.getGlobal()`；项目层读 `Instance.directory/config.json`。
- F4. 注意 `Config.update` 内部用 mergeDeep（对数组是替换），所以传入前要带上该层已有的完整数组。

### G. 前端显示态（里程碑 C）
- G1. 每个 skill 开关的显示态完全由配置层算：看其路径是否在 `disabled_files`/`evolution_disabled_files` 里（在=关，不在=开）。
- G2. 不再从 SKILL.md frontmatter 读显示态。
- G3. 推论（预期行为，非 bug）：在项目 A 禁某全局 skill → 全局配置 → 项目 B 看到它"已禁用"；在 B 重新打开 → 改的还是全局配置 → A 也变回"可用"。
- G4. 不许给全局 skill 的开关加只读/置灰/锁；全局开关在任意项目都可正常拨。
- G5. 后端两个 toggle 路由（`server/routes/config.ts` 的 `/skills/evolution/toggle` ≈L207、`/skills/evolution/toggle-evolution` ≈L228）改为走 F1 的公共写函数。
- G6. list 路由/`evolved-skills.ts` 的 `enabled`/`evolution_enabled` 显示态改为按配置算（不再读 frontmatter）。
- G7. 移除旧的写 SKILL.md 逻辑：`evolved-skills.ts` 的 `toggleEnabled`/`toggleEvolution`（≈L209/L216，用 `setFrontmatterFlag`+`atomicWrite` 写 frontmatter）连同只服务它们的辅助一并删除/停用；这两个开关不再改写 SKILL.md。

### H. 取消自进化双保险（里程碑 D、E）
- H1. ① prompt 警示：被取消的 skill 仍照常出现在喂给审查 AI 的清单里（不从清单删）。
- H2. 不从清单删的原因：AI 看不到它会"以为没这能力"而重造一个几乎一样的 skill，等于绕过禁令。
- H3. 在 `buildReviewPrompt`（`review-agent.ts:152`）读 `cfg.skills?.evolution_disabled_files`，把命中的 skill 拼成警示加进 prompt（可放在 `SKILL_REVIEW_PROMPT_BASE` 之后）：禁止修改它们、禁止新建功能重复的 skill。
- H4. ② 落盘硬拦：审查 AI 经 `skill_manage` 工具写 skill（`createBoundSkillManageTool`，在 `review-agent.ts:265` 注册）；在其写入执行处加闸——目标文件在 `evolution_disabled_files` 里则拒绝写、报错、文件不变。
- H5. ① 是软约束（靠 AI 听话），② 是硬保证（AI 不听也拦得住）；两者一起做。

### I. 工作方式与验证（贯穿规矩，不是里程碑；适用于上面每一次红绿）
- I1. 核心逻辑走 TDD：先写失败测试（红），再写实现（绿），交付要能展示先红后绿两次跑测输出。
- I2. 婴儿步：一次只让一个新测试变绿，每个里程碑独立走红→绿。
- I3. 测试质量：断言对具体值（禁止恒真断言）、测行为不测实现、至少覆盖一个边界/失败用例。
- I4. 测试隔离用 `OPENCODE_TEST_HOME`（不是 `HOME`），并覆盖 `Global.Path.config`/`.data` 到临时目录、调 `Config.global.reset()`；照抄 `skill-priority.test.ts`。
- I5. 跑测试必须在 `packages/opencode` 目录内（仓库根目录跑 `bun test` 会被守卫拦）。
- I6. 类型检查：`cd packages/opencode && bun run typecheck`。
- I7. 改完要有证据：贴 typecheck 结果 + 测试结果；UI 改动还要实测 app（typecheck 过 ≠ UI 没坏）。
- I8. 不擅自 git commit、不删文件、不新增依赖。

### J. 边界与失败用例（测试必须覆盖）
- J1. 按路径禁用只匹配该精确路径，不误伤另一处同名 skill。
- J2. 跨层并集：全局层 `disabled_files:[A]` + 项目层 `[B]`，`Config.get()` 结果同时含 A 和 B（验证 D5 生效）。
- J3. 项目隔离：项目 A 禁某项目 skill，项目 B 不受影响。
- J4. 落盘硬拦：被禁自进化的 skill，`skill_manage` 写入被拒且文件未变。
- J5. 空/缺省：配置里没有这两个字段时按默认（全开）处理，不报错。
