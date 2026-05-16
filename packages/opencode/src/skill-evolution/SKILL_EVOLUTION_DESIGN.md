# Skill 自进化系统设计文档

Aether 的 skill 自进化（self-evolution）机制让 Agent 在完成任务后能自动将成功经验固化为可复用的技能，并在后续对话中自动加载，形成持续学习闭环。

---

## 目录

- [设计原则](#设计原则)
- [对旧文件的修改](#对旧文件的修改)
- [整体架构](#整体架构)
- [文件组织结构](#文件组织结构)
- [核心机制详解](#核心机制详解)
  - [1. 演化路径总览](#1-演化路径总览)
  - [2. 计数器机制](#2-计数器机制)
  - [3. 后台评审完整流程](#3-后台评审完整流程)
  - [4. Shadow 目录写入路径（copy-on-write）](#4-shadow-目录写入路径copy-on-write)
  - [5. 安全扫描](#5-安全扫描)
- [新增文件职责详解](#新增文件职责详解)
- [版本管理](#版本管理)
  - [Binary Ruler 保留策略](#binary-ruler-保留策略)
- [配置参考](#配置参考)
- [持久化闭环](#持久化闭环)
- [关键文件速查](#关键文件速查)

---

## 设计原则

1. **插件化**：所有新增文件统一放在 `skill-evolution/` 目录下，以独立模块形式挂载，对宿主程序零侵入
2. **只读接入**：对旧文件的修改仅限于"添加 import 和少数几处调用点"；所有接入均以只读方式获取旧系统数据（消息历史、配置、会话 ID 等），插件不对旧系统的任何变量或模块状态执行写操作
3. **不影响原有流程**：旧代码的控制流分支、判断逻辑和执行时序均保持不变；新增调用点不阻塞旧逻辑执行，调用后立即返回 void，不影响旧代码的任何分支判断；后台评审等异步任务在旧代码正常返回后独立运行

---

## 对旧文件的修改

**共两处接入点：**

```
packages/opencode/src/session/prompt.ts    ← 接入点 1 & 2
  └─ 在 while 循环内工具执行后追加（立即返回 void，不影响循环）：
       SkillEvolutionHook.onToolCall(sessionID, toolName)
     在循环结束、return 语句之前追加：
       await SkillEvolutionHook.onLoopEnd({ sessionID, messages, ... })

（0.6.0 无 SkillDirty，无需任何 SkillDirty 相关接入）
```

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                     宿主程序（原有代码，只读）                         │
│                                                                     │
│  用户消息  ──►  SessionPrompt.prompt()  ──►  LLM 多轮对话循环         │
│                                                   │                 │
│                               每次 LLM 步骤结束后  │                 │
│                               onToolCall() 更新计数器               │
│                                                   │                 │
│                               对话正常结束         │                 │
│                               （有回复且未中断）    │                 │
│                                                   ▼                 │
│                    ┌──────────────────────────────────┐             │
│                    │  ★ 唯一接入点（只读旧文件信息）    │             │
│                    │  调用 SkillEvolutionHook.onLoopEnd │             │
│                    └──────────────┬───────────────────┘             │
└───────────────────────────────────┼─────────────────────────────────┘
                                    │ 读取：sessionID / messages 快照
                                    │       counter / config（只读）
                                    │ 不修改任何旧状态
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│              skill-evolution/ 插件（所有新增代码）                    │
│                                                                     │
│  hook.ts          ──►  counter.ts  ──►  达到阈值?                   │
│  (唯一对外接口)              │                   │                   │
│                           否 ▼                 是 ▼                 │
│                         直接返回        spawner.ts                  │
│                                         后台 spawn 子 session        │
│                                              │                      │
│                                         review-agent.ts            │
│                                         构建评审 prompt + 运行子 Agent│
│                                              │                      │
│                                    ┌─────────┴─────────┐           │
│                                    ▼                   ▼           │
│                              值得保存              不值得保存         │
│                              skill_manage()        "Nothing to      │
│                           （action 由 AI 决定）     save." 退出     │
│                                    │                               │
│                                    ▼                               │
│                   ┌─ shadow-writer.ts ──────────────────┐          │
│                   │  Shadow 目录写入（copy-on-write）      │          │
│                   │  原始 skill 文件永不被修改             │          │
│                   └──────────────┬──────────────────────┘          │
│                                  │                                  │
│                                  ▼                                  │
│                            guard.ts (安全扫描)                       │
│                                  │                                  │
│                       ┌──────────┴──────────┐                      │
│                      通过                   拦截                     │
│                       │                     │                       │
│                       ▼                     ▼                       │
│              版本快照 .versions/         自动还原 + 报错             │
│                       │                                             │
│                       ▼                                             │
│              publisher.ts                                           │
│              发布 skill.saved 事件                                   │
└─────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Watcher 热更新（skill-watcher/watcher.ts，独立运行）         │
│                                                                     │
│  监听 skills 目录变更  ──►  标记缓存 dirty  ──►  下次 Skill.available()│
│                                               调用时从磁盘重新加载    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 文件组织结构

```
packages/opencode/src/skill-evolution/    ← 所有新增文件都在此目录
│
├── SKILL_EVOLUTION_DESIGN.md       ← 本设计文档
│
├── index.ts                        ← 对外暴露的唯一入口（re-export）
│
├── hook.ts                         ← 供旧文件调用的接口函数
│                                       只接收只读数据，不持有旧对象引用
│
├── counter.ts                      ← 计数器管理（每个 session 独立计数）
│
├── spawner.ts                      ← 后台评审子 session 的启动逻辑
│
├── review-agent.ts                 ← 构建评审 prompt、运行子 session
│                                       不依赖 Config.listManagedSkills/listEvolutionSkills
│                                       （0.6.0 不存在），改为自行扫描目录取 categories
│
├── shadow-writer.ts                ← Shadow 目录写入（copy-on-write）
│                                       原始 skill 文件永不被修改
│                                       写后触发 Skill 模块缓存失效
│
│
├── guard.ts                        ← 安全扫描（prompt 注入、数据外泄检测）
│
├── versions.ts                     ← 版本快照管理（.versions/ 目录）
│
├── publisher.ts                    ← 仅发布 skill.saved 到 Bus
│                                       0.6.0 无 SkillDirty，publisher 不依赖它
│
├── config-reader.ts                ← 只读读取宿主配置
│                                       creation_nudge_interval 不在 0.6.0 schema 中，
│                                       由插件自行扩展（见下方配置参考）
│
├── skill-manage-tool.ts            ← ★ 新增工具：skill CRUD（0.6.0 只有只读 skill.ts）
│                                       提供 create/edit/patch/delete/write_file 操作
│
│
└── constants.ts                    ← 常量定义（阈值、提示词、限制等）
```

---

## 核心机制详解

### 1. 演化路径总览

（参考 `docs/skill-evolution.md` § 3.1）

```
对话正常结束，且同时满足：
① 计数器 ≥ 阈值（默认 10）
② final_response 成立
③ 用户未中断
④ 非评审 session 本身
        │
        ▼
spawn 子 session（静默后台）
分析整段对话历史
决定是否调用 skill_manage
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  shadow-writer.ts 写入 shadow 目录                            │
│  缓存失效，watcher 热更新生效                                  │
└──────────────────────────────────────────────────────────────┘
```

---

### 2. 计数器机制

（参考 `docs/skill-evolution.md` § 3.2）

```
每次 LLM 步骤结束后（onToolCall 被调用）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  满足计数条件？                                                │
│  ① 当前不是后台评审 session                                   │
│  ② 本步骤包含工具调用                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  满足上述全部条件？        │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
             计数器 +1      计数器不变（结束）
```

**效果：**
- 计数器累积到阈值时触发后台评审
- `config.skills.creation_nudge_interval` 为 0 时作为特例跳过触发，等效于禁用后台评审

---

### 3. 后台评审完整流程

（参考 `docs/skill-evolution.md` § 3.3）

**Skill Evolution 专属项目：**
- `~/.aether/skill-sessions/` 是一个普通项目根目录，与其他项目根目录（如 `~/my-project/`）地位完全相同
- 其 DB 文件按正常的 per-project 机制生成，存放在 `~/.local/share/aether/local/aether-<hash>.db`，无需任何特殊处理
- 所有 skill 后台评审 session 统一创建在该项目下，在 UI 中与其他项目平等可见，用户可直接查看演化历史
- 模型可单独配置，不继承父 session
- `~/.aether/skill-sessions/<project>/` 为各项目的 skill 相关信息目录（具体结构待定）

**一个 skill 对应一个 session：**
- session title = `项目名称 / skill 名称`（由 Agent 调用 skill_manage 后确定）
- 每次后台评审触发时，spawner 按 `项目名称 + skill 名` 在专属项目中查找现有 session
  - 找到 → 追加本次对话历史，在同一 session 中继续分析
  - 未找到 → 在专属项目中创建新 session，title 设为 `项目名称 / skill 名称`
- 该 skill 的所有历次演化均保留在同一 session 中，形成完整演化轨迹

```
对话结束，触发条件全部满足
        │
        ▼
计数器立即重置为 0（不等后台完成）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  构建评审提示（review-agent.ts，插件内部，不碰旧文件）           │
│  将父 session 完整消息历史序列化为 <conversation_history> 块   │
│  追加 SKILL_REVIEW_PROMPT_BASE + 现有 category 提示           │
│                                                              │
│  category 列表来源：扫描 shadow 目录读取各 SKILL.md frontmatter│
│  （不依赖 0.6.0 不存在的 Config.listManagedSkills 等函数）     │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  在 Skill Evolution 专属项目中查找/创建对应 skill session       │
│  （spawner.ts，全部为插件新增代码，不修改旧文件）                │
│  权限中禁止 task 工具（防递归 spawn）和 todowrite 工具          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  评审 Agent 分析对话历史，同时判断两个问题：                      │
│  A. 是否存在值得保存的经验？                                    │
│     ① 非平凡方案，经历反复试错或改变方向                        │
│     ② 实际解决方式与最初预期不同（实践发现更好路径）             │
│     ③ 用户明确期望某种特定的工作方式或结果                       │
│  B. 该经验是否是正确有效的？（排除保存错误做法）                 │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  值得保存且方式正确？      │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
       自主调用 skill_manage   "nothing to save"
       （action 由 AI 决定：   session 保留，供下次复用
        create/patch/edit/
        delete 等均可）
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  skill 内容由 shadow-writer.ts 写入                           │
│  ~/.aether/skill-sessions/<project>/skills/<skill-name>/      │
│  （项目级低优先级，仅对关联项目可见）                            │
│                                                              │
│  publisher.ts 发布 skill.saved 事件通知 UI                    │
│  （事件本身不携带数据，仅触发界面更新）                          │
└──────────────────────────────────────────────────────────────┘
```

---

### 4. Shadow 目录写入路径（copy-on-write）

（参考 `docs/skill-evolution.md` § 3.4）

**核心原则：原始 skill 文件永不被修改。**

Agent 演化 skill 时，所有写入都发生在 `.aether/skills/` 目录（shadow 目录），原始的 `.claude/`、`.agents/`、`.opencode/` 中的文件丝毫不动。

```
skill_manage 请求修改或创建 skill
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  shadow-writer.ts: resolveSkillDir                           │
│  查询当前 skill 的原始位置（若存在）                             │
│  按规则计算对应的 shadow 目录路径：                             │
│                                                              │
│  原始：/project/.claude/skills/foo/SKILL.md                  │
│                   ↑ 找到 .claude，取其上级                    │
│  base：/project/                                             │
│  shadow：/project/.aether/skills/foo/   ← 平行新建            │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  shadow 目录              │
               │  是否已存在？             │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
             直接进入        copyToShadowIfNeeded：
             执行修改        将原始 skill 完整复制到 shadow
                             （含 SKILL.md 及所有辅助文件）
                    \               │
                     \              ▼
                      \        创建 action=original 版本快照
                       \       （记录演化前初始状态，可 rollback）
                        \           │
                         └──────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────┐
│  在 shadow 目录中执行本次修改操作                               │
│  （create / edit / patch / write_file / 等）                  │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  guard.ts 安全扫描        │
               │  检查写入内容是否有风险     │
               └───────────┬──────────────┘
                    安全 /    \ 危险
                   /            \
                  ▼              ▼
┌──────────────────────────┐  回滚：
│  Skill 内存缓存失效       │  还原文件内容（或删除刚创建的目录）
│  下次 available() 调用   │  向 Agent 报错，操作终止
│  从磁盘重新加载           │
└──────────────┬───────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  markClear + markDone（500ms 冷却期）                         │
│  防止 watcher 将此次写入误判为外部变更                          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  versions.ts：创建版本快照到 .versions/                        │
│  v00N_<action>_<timestamp>.bundle.json                       │
│  包含 skill 目录下所有文件的完整内容                            │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
                    返回成功结果
```

**Skill 路径优先级（高 → 低）：**

```
<project>/.aether/skills/                              ← 用户手动放置或显式演化，优先级最高
<project>/.claude/skills/ 等                           ← 原始 skill 来源，只读
~/.aether/skill-sessions/<project>/skills/             ← AI 后台评审自动创建，仅对该项目可见，优先级最低
```

同名 skill 按优先级高者生效，低优先级的被覆盖。
AI 自动生成的内容优先级必须低于用户手动放置的原始 skill，防止后台评审结果意外覆盖用户预期行为。

**Shadow 目录场景示例：**

```
场景一：对已有 skill 执行 patch/edit（copy-on-write）
  原始：  /home/user/my-project/.claude/skills/my-skill/SKILL.md
  shadow：/home/user/my-project/.aether/skills/my-skill/             ← 与 .claude/ 并列，高优先级

场景二：AI 后台评审新建 skill（无原始来源，项目级）
  AI 创建：~/.aether/skill-sessions/my-project/skills/my-skill/      ← 按项目隔离，低优先级
            ↑ <project> 取自项目路径 hash 或名称，由 spawner.ts 传入

```

**路径选择规则（resolveSkillDir）：**

- 若 skill 有原始来源 → copy-on-write 到 `<base>/.aether/skills/`（与原始并列）
- 若 skill 由 AI 评审新建 → 写入 `~/.aether/skill-sessions/<project>/skills/`（项目级，优先级最低）

---

### 5. 安全扫描

（参考 `docs/skill-evolution.md` § 3.6）

每次 `skill_manage` 写入成功后，立即对写入目录执行安全扫描。发现问题时自动还原文件。

```
写入 shadow 目录成功
        │
        ▼
guard.ts → scan(skillDir, source="agent-created")
        │
  ┌─────┴──────────────────────────────────────┐
  │  静态分析检测目标：                           │
  │  - 数据渗出：curl/wget 携带凭据              │
  │  - 提示注入：ignore instructions 等模式      │
  │  - 破坏性操作：rm -rf、dd 等                 │
  │  - 持久化：写 crontab / sudoers / SSH 目录   │
  │  - 供应链：curl | bash、反向 shell           │
  │  - 硬编码凭据：API Key / 私钥 / Token        │
  │  - 不可见字符：零宽字符等混淆手段             │
  │                                             │
  │  扫描限制：≤50 个文件，总大小 ≤1024KB        │
  │  单文件 ≤256KB，二进制文件直接拒绝           │
  └─────┬──────────────────────────────────────┘
        │
  ┌─────┴──────┐
 无发现        有发现
  │              │
  ▼              ▼
继续流程     评估严重性（agent-created 策略）
                  │
        ┌─────────┴─────────┐
        │  safe  → allow    │
        │  caution → allow  │
        │  dangerous → ask  │
        └─────────┬─────────┘
                dangerous
                  │
                  ▼
         还原文件内容（或删除目录）
         向 Agent 返回错误，操作终止
```

---

## 新增文件职责详解

### `packages/opencode/src/skill-evolution/hook.ts`（唯一对外接口）

```typescript
export interface HookInput {
  readonly sessionID: string
  readonly messages: ReadonlyArray<MessageSnapshot>  // 只读快照，不持有原始引用
  readonly isReviewSession: boolean
  readonly finalResponse: boolean
  readonly aborted: boolean
}

export namespace SkillEvolutionHook {
  // 每次 LLM 步骤后调用（计数器维护）
  export function onToolCall(sessionID: string, toolName: string): void

  // 对话结束后调用（唯一触发评审的入口）
  export async function onLoopEnd(input: HookInput): Promise<void>
}
```

旧文件修改示例（`session/prompt.ts`）：

```typescript
// ① 在工具执行处追加（原有工具执行逻辑不变）：
import { SkillEvolutionHook } from "../../skill-evolution"
SkillEvolutionHook.onToolCall(sessionID, toolName)

// ② 在 while 循环结束后、原有 return 之前追加：
await SkillEvolutionHook.onLoopEnd({
  sessionID,
  messages: [...messages],   // 传副本，不传原始引用
  isReviewSession: isAnyReviewSession,
  finalResponse: _finalResponse,
  aborted: abort.aborted,
})
// 原有 return 语句继续执行，不受任何影响
```

**绝对禁止的接入方式：**
- ❌ 将旧对象引用（非序列化副本）传入插件
- ❌ 插件修改旧代码的变量或状态
- ❌ 插件的异常抛出影响旧代码的 try/catch 边界
- ❌ 插件调用旧代码的私有函数

---

## 版本管理

（参考 `docs/skill-evolution.md` § 3.5）

每次 `skill_manage` 成功后，`versions.ts` 自动在 `.versions/` 目录创建快照：

```
.aether/skills/my-skill/
├── SKILL.md
├── helper-script.sh
└── .versions/
    ├── v001_original_2025-01-15T10:30:00.000Z.bundle.json
    ├── v002_edit_2025-01-16T14:20:00.000Z.bundle.json
    └── v003_patch_2025-01-17T09:15:00.000Z.bundle.json
```

每个 `.bundle.json` 包含该时刻 skill 目录下所有文件的完整内容。默认上限 100 条，超出后按 Binary Ruler 策略裁剪。

- `skill_manage(action='history', name='...')` — 列出所有版本
- `skill_manage(action='rollback', name='...', version='v002')` — 还原至指定版本

### Binary Ruler 保留策略

裁剪时不简单地删除最旧版本，而是按版本号的二进制最低有效位（`weight = v & -v`）赋予权重，使历史里程碑呈指数间距保留：

```
容量上限 C（默认 100）
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  v001（初始快照）永久保留                                 │
├─────────────────────────────────────────────────────────┤
│  活跃区：最新 A 条全部保留                                │
│  A = floor((C-1) * 0.5)，默认约 49 条                   │
├─────────────────────────────────────────────────────────┤
│  里程碑区：剩余槽位 M = C - 1 - A，按权重排序保留         │
│  权重 = v & -v（二进制最低有效位）                        │
│  v4→4，v8→8，v16→16，v3→1，v5→1，v7→1                  │
│  权重低的（奇数版本）优先淘汰                             │
│  → 随时间自然形成指数间距里程碑                           │
└─────────────────────────────────────────────────────────┘
```

**示例（C=100，写入 105 条后）：**

| 区域 | 内容 |
|------|------|
| 永久 | v001 |
| 活跃区（49条） | v057–v105 |
| 里程碑区（50条） | v002, v004, v008, v016, v032 … 按权重保留 |
| 被淘汰 | v003, v005, v007 … 奇数低权重版本 |

---

## 配置参考

`creation_nudge_interval` 是插件新引入的字段，不在 0.6.0 的 `Config.Skills` schema 中。插件通过 `config-reader.ts` 读取独立配置文件，完全不碰旧 config schema。

```yaml
# ~/.aether/config.yaml（0.6.0 已有字段，config-reader.ts 只读）
skills:
  paths:                        # 自定义 skill 路径（0.6.0 已支持）
    - ~/.agents/team-skills
  disabled: [skill-a, skill-b]  # 全局禁用（0.6.0 已支持）
  creation_nudge_interval: 10   # 每多少次 LLM 步骤触发评审（0 = 禁用）
```

---

## 持久化闭环

```
用户完成任务
      │
      ▼ 每 10 次 LLM 步骤（可配置）
后台评审子 session（在 ~/.aether/skill-sessions/ 项目中可见）
      │
      ├── 有价值 → skill_manage（action 由 AI 自主决定）
      │              │
      │              ▼
      │          shadow-writer.ts
      │          写入 .aether/skills/（原始文件不变）
      │              │
      │              ▼
      │          guard.ts 安全扫描
      │              │
      │              ▼
      │          versions.ts 版本快照
      │              │
      │              ▼
      │          watcher.ts 感知变更，缓存失效
      │              │
      │              ▼
      │          publisher.ts → Bus.publish(skill.saved)
      │
      └── 无价值 → "Nothing to save." 静默退出
                        │
                        ▼
              下次对话启动时
              旧代码 Skill.available() 自动扫描（含 .aether/skills/）
              skill 索引（frontmatter 摘要）注入 system prompt
              直接复用，无需重新摸索
```

---

## 关键文件速查

| 文件 | 职责 | 是否为新增文件 |
|------|------|:---:|
| `packages/opencode/src/skill-evolution/index.ts` | 对外唯一入口 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/hook.ts` | 供旧代码调用的只读接口 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/counter.ts` | 按 session 隔离的计数器 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/spawner.ts` | 后台评审子 session 启动 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/review-agent.ts` | 评审 prompt + 子 Agent 运行 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/shadow-writer.ts` | Shadow 目录 copy-on-write 写入，写后触发 Skill 模块缓存失效 | ✅ 新增 |
| `packages/opencode/src/skill-watcher/watcher.ts` | FS 事件监听 + 缓存失效（详见 skill-watcher/WATCHER_DESIGN.md） | ✅ 新增 |
| `packages/opencode/src/skill-evolution/guard.ts` | 安全扫描 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/versions.ts` | 版本快照管理（.versions/） | ✅ 新增 |
| `packages/opencode/src/skill-evolution/publisher.ts` | 仅发布 skill.saved 到 Bus，0.6.0 无 SkillDirty 无需处理 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/config-reader.ts` | 只读读取宿主配置，creation_nudge_interval 由插件扩展 | ✅ 新增 |
| `packages/opencode/src/skill-evolution/skill-manage-tool.ts` | **新工具** skill_manage（0.6.0 无，只有只读 skill.ts） | ✅ 新增 |
| `packages/opencode/src/skill-evolution/constants.ts` | 常量（阈值/提示词/限制） | ✅ 新增 |
| `packages/opencode/src/session/prompt.ts` | 接入点1：`onToolCall`；接入点2：`onLoopEnd` | ⚠️ 仅接入 |
