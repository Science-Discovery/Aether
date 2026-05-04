# Skill 系统技术文档

> 基线：`origin/dev`

---

## 目录

1. [Skills 加载与热更新机制](#1-skills-加载与热更新机制)
   - 1.1 [完整加载流程](#11-完整加载流程)
   - 1.2 [两级缓存机制](#12-两级缓存机制)
   - 1.3 [Watcher 热更新机制](#13-watcher-热更新机制)
2. [Skills 优先级与覆盖（同名冲突）](#2-skills-优先级与覆盖同名冲突)
   - 2.1 [来源扫描顺序与优先级规则](#21-来源扫描顺序与优先级规则)
   - 2.2 [Disabled 列表](#22-disabled-列表)
   - 2.3 [从发现到调用](#23-从发现到调用)
   - 2.4 [重新扫描与正文刷新边界](#24-重新扫描与正文刷新边界)
3. [Skills 自演化机制](#3-skills-自演化机制)
   - 3.1 [两条演化路径总览](#31-两条演化路径总览)
   - 3.2 [路径一：对话中实时演化](#32-路径一对话中实时演化)
   - 3.3 [路径二：对话后后台评审](#33-路径二对话后后台评审)
   - 3.4 [演化写入路径（Shadow 目录）](#34-演化写入路径shadow-目录)
   - 3.5 [版本管理](#35-版本管理)
   - 3.6 [安全扫描](#36-安全扫描)

---

## 1. Skills 加载与热更新机制

### 1.1 完整加载流程

每次需要读取 skills 列表时（构建系统提示、初始化 `skill` 工具描述、调用 `Skill.all()` / `Skill.get()` / `Skill.dirs()`、skill 被修改后），系统执行以下流程：

```
调用 Skill.available() / Skill.all() / Skill.get() / Skill.dirs()
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 1：InstanceState（内存缓存，per Instance.directory）    │
│  key = 当前 instance 的 directory                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  内存命中？  │
                    └──────┬──────┘
                      是 /   \ 否
                     /         \
                    ▼           ▼
               直接返回      loadSkills()
              （零 I/O）          │
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│  buildSources()                                              │
│  按顺序枚举所有来源目录，每个目录分配递增 order 编号（0,1,2,…）  │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────────────────────────────────────────┐
│  Layer 2：磁盘快照校验（global 和 project 分别独立执行）        │
│                                                              │
│  buildSkillsManifest(globalDirs)                             │
│  buildSkillsManifest(projectDirs)                            │
│  遍历各组目录下所有 SKILL.md，记录每个文件的 mtime + size       │
└──────────────────────────┬───────────────────────────────────┘
                           │
                    ┌──────▼────────┐
                    │ global 快照   │
                    │   有效？      │
                    └──────┬────────┘
                      是 /   \ 否
                     /         \
                    ▼           ▼
             读 global 快照   全量扫描 global 来源目录：
                              解析每个 SKILL.md frontmatter
                              提取 name / description（缺失则跳过）
                              提取 conditions（metadata.hermes 子结构）
                              提取 platforms
                              每个 skill 附带来源目录的 order 编号
                              原子回写 global 快照 JSON
                    \           /
                     \         /
                      ▼       ▼
                  global skills 列表
                           │
                    ┌──────▼─────────┐
                    │ project 快照   │
                    │   有效？       │
                    └──────┬─────────┘
                      是 /   \ 否
                     /         \
                    ▼           ▼
            读 project 快照  全量扫描 project 来源目录：
                             （同上，扫描 project scope 的来源）
                             原子回写 project 快照 JSON
                    \           /
                     \         /
                      ▼       ▼
                  project skills 列表
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  mergeSkills(global, project)                                │
│  按 order 升序遍历，同名 skill 后者覆盖前者                    │
│  disabled Set 中的目录对应条目直接跳过                         │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  结果存入 InstanceState                                       │
│  state.skills = 合并后的 name → skill 信息                      │
│  state.dirs = 当前 manifest 中所有 SKILL.md 所在目录             │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  调用方读取时再做可见性过滤                                     │
│  Skill.available(agent)：按 agent permission 过滤 deny 项       │
│  SystemPrompt.skills()：再按 metadata.hermes 条件过滤            │
│  platforms 当前仅解析保存，不参与可用列表过滤                    │
└──────────────────────────────────────────────────────────────┘
```

**关键细节：**

- `buildSources()` 给每个来源目录分配一个从 0 开始的递增整数 `order`，扫描到的每个 skill 携带其来源目录的 `order` 值进入后续合并逻辑。
- `name` 和 `description` 是必填字段，缺少则忽略该文件；frontmatter 解析失败时才会向会话总线发布解析错误事件。
- `conditions` 字段来自 frontmatter 中的 `metadata.hermes` 子结构，包含 `requires_tools`、`requires_toolsets`、`fallback_for_tools`、`fallback_for_toolsets` 四类条件。
- `conditions` 会在构建系统提示时根据当前工具集合过滤；`skill` 工具描述本身来自 `Skill.available(agent)`，只按 agent permission 过滤。
- `platforms` 字段当前只被解析并保存在 skill 信息中，`Skill.available()` 和系统提示构建路径尚未实际按平台过滤。
- 系统提示中只暴露 skill 的 `name` 和 `description`，不暴露文件路径，以降低 LLM 在未加载 skill 前直接读写文件的可能性；一旦通过 `skill` 工具加载，返回内容会包含 base directory 和辅助文件样例。

---

### 1.2 两级缓存机制

缓存分两层，目的是在保证数据新鲜度的同时尽量减少磁盘 I/O。

**Layer 1：InstanceState（内存缓存）**

`InstanceState` 以 `Instance.directory` 为 key，per directory 独立存储：

- 同一 directory：第一次调用触发加载，后续调用直接读内存，零 I/O
- 切换 directory 或 dispose instance：旧 instance 缓存释放，新 directory 重新加载
- 手动失效：`clearSkillsPromptCache()` 调用 `skill.invalidate()`，仅清 Skill 的 InstanceState，不影响其他模块

**Layer 2：磁盘快照（跨进程持久化）**

```
global 快照：  ~/.cache/aether/.skills_prompt_snapshot.global.json
project 快照： ~/.cache/aether/skills-prompt/<slug>.<sha1>.json
               slug = directory basename（清洗后取前 48 字符）
               sha1 = SHA1("${process.platform}|${directory}|${worktree}")

快照 JSON 结构：
  {
    "version": 3,
    "manifest": { "/path/to/SKILL.md": [mtime毫秒, 字节数], … },
    "skills":   [ …完整的 skill Info 对象数组… ]
  }

命中条件（同时满足）：
  1. version == 3（版本不符视为 miss，触发全量重扫）
  2. 当前文件系统清单与 manifest 完全一致
     （文件数量、每条路径、mtime、size 全部吻合）

命中收益：跳过所有 SKILL.md 内容解析，直接反序列化结构化数据
跨进程价值：进程重启后 InstanceState 为空，但磁盘文件未变时
           可直接从快照恢复，避免重新解析所有 SKILL.md
```

**缓存失效路径：**

| 触发事件 | 失效操作 | 说明 |
|----------|----------|------|
| Watcher 检测到 global 目录变更 | 清所有 active instances 的 Skill 内存缓存 | global 变更影响全部 directory |
| Watcher 检测到 project 目录变更 | 清当前 instance 的 Skill 内存缓存 | 只影响当前 directory |
| `skill_manage` 修改 `SKILL.md` 成功 | 清 Skill 内存缓存 | 下次访问按 manifest 判断是否复用或重建磁盘快照 |
| `skill_manage` 修改辅助文件成功 | 保存版本并发布文件事件 | 当前不主动清 skill 内存缓存；不改变已登记 skill 列表 |

watcher 触发失效后，下次 `Skill.available()` 调用时才重新加载（按需重建），watcher 本身不参与数据重建。

---

### 1.3 Watcher 热更新机制

Watcher 采用"**事件触发失效、请求时重建**"的策略：watcher 的职责只是推送失效信号，不参与数据重建；下次 `Skill.available()` 调用时才按需重新加载。这样缓存生命周期与 watcher 生命周期完全解耦。

```
Skill.watch() 初始化
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  扫描监听候选目录（buildSources 实际目录 + 额外候选根）          │
│  directory 向上至 worktree 每层的 .aether/.opencode/           │
│  .claude/.agents，home 目录同名子目录，skills.paths 自定义路径  │
│  即使目录当前不存在也加入候选集（感知目录首次创建/删除）          │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼───────────────┐
               │  parcel 原生绑定可用？      │
               └───────────┬───────────────┘
                     是 /    \ 否（绑定缺失 / subscribe 失败）
                    /          \
                   ▼            ▼
           parcel 订阅目录   poll 轮询目录
           （原生 FS 事件）   （每 1500ms 一次）
                   │              │
                   └──────┬───────┘
                          │ fs 事件到达
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  SKILL.md 事件进入 pending 集合                                │
│  同路径重复事件去重，仅保留最新状态                              │
│  候选根目录新增/删除时标记 scope dirty                           │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────────┐
               │  pending.size                 │
               │  ≥ WATCH_CAP (2000)？          │
               └───────────┬──────────────────┘
                     否 /    \ 是（风暴场景）
                    /          \
                   ▼            ▼
       debounce 等待 300ms   立即进入批处理
       无新事件后触发          （backpressure 模式）
                   │              │
                   └──────┬───────┘
                          │
               ┌──────────▼──────────────────┐
               │  批次累积时长 ≥ 2000ms？      │
               └──────────┬──────────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
          停止收集，直接处理   继续收集下一批
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  过滤 marked files                                            │
│  skill_manage 正在写入的文件跳过（避免自触发）                  │
│  + cooling 检查：500ms 冷却期内跳过本批，直接返回              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  按 scope 归类变更文件                                         │
│  → globalDirty（来自 global dirs 的变更）                      │
│  → projectDirty（来自 project dirs 的变更）                    │
└──────────────┬────────────────────────────┬──────────────────┘
               │                            │
          globalDirty                  projectDirty
               │                            │
               ▼                            ▼
┌─────────────────────────┐   ┌─────────────────────────────┐
│  clearSkillsPromptCache  │   │  仅清理当前项目实例的         │
│  （所有 active 实例）    │   │  Skill 内存缓存               │
└───────────┬─────────────┘   └────────────┬────────────────┘
            └─────────────────┬────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  下次 Skill.available() 调用时，从磁盘重新加载                  │
└──────────────────────────────────────────────────────────────┘
```

**Mark 系统（防止 skill_manage 写入自触发）：**

`skill_manage` 在写文件的整个过程中对该文件加标记，watcher 的 `flush()` 阶段跳过被标记的文件，确保 skill 演化写入不会触发无意义的缓存失效：

| 时机 | 操作 | 效果 |
|------|------|------|
| 开始写入前 | `markBegin(file)` | 标记永不过期，watcher 无限跳过 |
| 写入成功后 | `markDone(file)` | TTL = 1500ms，给 FS 事件延迟留安全余量 |
| 写入失败后 | `markDrop(file)` | 立即移除标记，恢复正常监听 |

**关键参数：**

| 常量 | 值 | 作用 |
|------|----|------|
| `WATCH_WAIT` | 300ms | debounce 等待窗口 |
| `WATCH_MAX` | 2000ms | 批次最长累积时间，超时后强制处理 |
| `WATCH_CAP` | 2000 | pending 队列上限，超出进入风暴合并模式 |
| `WATCH_POLL` | 1500ms | poll 后端轮询间隔 |
| `WATCH_ENSURE` | 5000ms | 主动探测候选目录新增/消失的节流间隔 |
| `WATCH_COOLDOWN` | 500ms | 失效后冷却期，避免连续触发 |

通过环境变量 `OPENCODE_SKILL_WATCHER_BACKEND=parcel|poll` 可强制切换后端。

**事件边界：** watcher 主要响应 `SKILL.md` 的新增、删除、修改，以及候选根目录是否存在的变化。普通辅助文件（例如 `scripts/`、`references/` 下的文件）变更不会触发 skill 列表缓存失效；`skill_manage write_file/remove_file` 也只发布文件事件并保存版本快照。

**可观测性：**

watcher 在运行时输出 `[skill watch]` 前缀日志，可用于排查热更新异常：

```
[skill watch] batch files=3 active=3 dropped=0 globalDirty=1 projectDirty=0 ms=12
[skill watch] invalidate scope=global instances=2 files=3 ms=1
[skill watch] skip reason=marked files=1
[skill watch] skip reason=cooling
[skill watch] parcel subscribe summary ok=1 fail=0
```

---

## 2. Skills 优先级与覆盖（同名冲突）

### 2.1 来源扫描顺序与优先级规则

不同来源目录中的同名 skill 以来源目录的 `order` 编号决定胜出者：**order 越大优先级越高，高优先级覆盖低优先级**。同一来源目录内如果出现多个同名 skill，它们拥有相同 `order`，最终覆盖结果取决于扫描返回顺序，不应依赖。

当前优先级设计遵循三条规则：

1. **同一层级内 `.aether` > `.opencode` > `.claude` > `.agents`**：同名时 shadow 演化目录优先级最高。
2. **项目层级从 worktree 外层扫到当前 directory 内层**：越靠近当前 directory 的同名 skill 越容易胜出。
3. **`skills.paths` 和 `skills.urls` 是最高优先级自定义来源**：它们在项目层级和 `OPENCODE_CONFIG_DIR` 之后追加。

当前 `buildSources()` order 分配顺序为：

| 相对顺序 | scope | 来源类型 | 典型路径 / 匹配模式 |
|----------|-------|----------|---------------------|
| 1 | global | 默认 bundled skills | `Config.getDefaultSkillsDir()` 返回目录下的 `**/SKILL.md` |
| 2 | global | 默认 skills 父级旁的 `.aether` 根 | `<default-parent>/.aether/{skill,skills}/**/SKILL.md` |
| 3 | global | 全局配置目录 | `Global.Path.config/{skill,skills}/**/SKILL.md` |
| 4 | global | home 外部 `.agents` | `~/.agents/skills/**/SKILL.md` |
| 5 | global | home 外部 `.claude` | `~/.claude/skills/**/SKILL.md` |
| 6 | global | home legacy `.opencode` | `~/.opencode/{skill,skills}/**/SKILL.md` |
| 7 | global | home `.aether` | `~/.aether/{skill,skills}/**/SKILL.md` |
| 8 | project | 每层 `.agents` | `<layer>/.agents/skills/**/SKILL.md`，从 worktree 外层到 directory 内层 |
| 9 | project | 每层 `.claude` | `<layer>/.claude/skills/**/SKILL.md`，同层晚于 `.agents` |
| 10 | project | 每层 `.opencode` | `<layer>/.opencode/{skill,skills}/**/SKILL.md`，同层晚于 `.claude` |
| 11 | project | 每层 `.aether` | `<layer>/.aether/{skill,skills}/**/SKILL.md`，同层晚于 `.opencode` |
| 12 | 按路径判定 | `OPENCODE_CONFIG_DIR` | `$OPENCODE_CONFIG_DIR/{skill,skills}/**/SKILL.md` |
| 13 | 按路径判定 | `config.skills.paths` | 每个配置目录下 `**/SKILL.md` |
| 14 | global | `config.skills.urls` | 下载到 `Global.Path.cache/skills/<name>/` 后扫描 `**/SKILL.md` |

合并规则：

```
同名 skill 遇到更高 order 的条目 → 直接覆盖 → 最终 order 最大的胜出
```

**实际效果：**

- 同一层级内，`.aether/skills/foo` 覆盖 `.opencode/skills/foo`，`.opencode` 覆盖 `.claude`，`.claude` 覆盖 `.agents`。
- 当前 directory 下的 `.claude/skills/foo` 可以覆盖 worktree 根目录下的 `.aether/skills/foo`，因为 project 层级按外层到内层扫描。
- `config.skills.paths` 中的同名 skill 会覆盖前面所有内置、home、project、`OPENCODE_CONFIG_DIR` 来源。
- `config.skills.urls` 下载缓存中的同名 skill 在当前实现中晚于 `skills.paths`，因此拥有更高优先级。
- 同一个 source 目录内不要放置多个同名 skill；当前实现没有为这种情况定义稳定的优先级规则。

---

### 2.2 Disabled 列表

Disabled 列表存储于全局配置，值为被禁用的 skill **目录绝对路径**列表（非 skill 名称）。使用目录路径而非名称，避免不同来源的同名 skill 互相误伤。

**在加载阶段的使用（mergeSkills 内部）：**

```
mergeSkills 开始
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  读取全局配置 skills.disabled 路径列表                         │
│  过滤出绝对路径，构建 disabled Set（目录绝对路径集合）           │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼  按 order 升序遍历所有 skills
                    ┌──────────────┐
                    │  取下一个条目  │◄──────────────────────┐
                    └──────┬───────┘                        │
                           │                                │
               ┌───────────▼──────────────────┐            │
               │  skill 所在目录               │            │
               │  在 disabled Set 中？         │            │
               └───────────┬──────────────────┘            │
                     是 /    \ 否                            │
                    /          \                            │
                   ▼            ▼                           │
              跳过此条目    写入结果字典（同名则覆盖前值）       │
                   │            │                           │
                   └─────┬──────┘                          │
                         │                                 │
               ┌─────────▼──────────────────┐             │
               │  是否还有更多条目？           ├─ 是 ────────┘
               └─────────┬──────────────────┘
                     否  │
                         ▼
                返回合并后的 skills 字典
```

**在 skill_manage 写入阶段的使用：**

```
skill_manage 收到写入请求
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  读取全局配置，过滤出 disabled 绝对路径列表                      │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────────────────────────┐
               │  disabled 列表中是否有路径的目录名             │
               │  等于请求的 skill 名？（名称预检）              │
               └───────────┬──────────────────────────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
          报错：已禁用，      resolveSkillDir：
          请先启用（结束）     查找当前位置，
                              计算 shadow 目录路径
                                   │
                         ┌─────────▼──────────────────────────┐
                         │  shadow 路径是否                    │
                         │  精确命中 disabled Set？            │
                         └─────────┬──────────────────────────┘
                               否 /  \ 是
                              /        \
                             ▼          ▼
                        继续正常      ┌──────────────────────────┐
                        写入流程      │  shadow 目录是否           │
                                     │  实际存在于磁盘？          │
                                     └─────────┬────────────────┘
                                        存在 /   \ 不存在
                                        /           \
                                       ▼             ▼
                               报错：已禁用，    stale 条目：
                               请先启用（结束）  从 disabled 列表中移除，
                                                继续正常写入流程
```

**日常操作体验：**

- 在设置界面中切换某个 skill 的启停状态，实际是将其 skill 目录的绝对路径加入或移出全局配置的 `skills.disabled` 数组。
- 被禁用的是具体目录候选，不是名称；如果低优先级路径还有同名 skill，低优先级版本会作为 fallback 重新生效。
- 非绝对路径 disabled 条目（例如旧式 `"foo"`）不会进入运行时 disabled Set，也不会影响 `mergeSkills()`。
- 被禁用的 skill 在 `mergeSkills()` 阶段对 LLM 不可见，且无法通过 `skill_manage` 被修改。
- `disabled` 列表中目录已不存在的 stale 条目会在 `listEvolutionSkills()` 执行时清理；`skill_manage` 遇到不存在的 shadow disabled 路径时也会移除该 stale 条目后继续写入。

---

### 2.3 从发现到调用

扫描路径只决定候选 skill 能否进入运行时列表；真正使用 skill 时，还会经过系统提示、工具描述、权限和正文读取等入口。无论 skill 来自默认目录、home 目录、项目 `.aether/skills`、`skills.paths` 还是 `skills.urls` 下载缓存，被扫描后都会收敛到同一套运行时流程。

| 入口 | 使用的 Skill API | 运行时效果 |
|------|------------------|------------|
| 系统提示 `SystemPrompt.skills()` | `Skill.available(agent)` | 先按 agent 的 `skill` permission 过滤，再按 `conditions` 过滤；提示里只写入 `name` 和 `description`。 |
| 内置 `skill` 工具描述 | `Skill.available(agent)` | 工具 schema 中的可选名称列表来自当前 agent 可见 skill；这里不按 `conditions` 过滤。 |
| 内置 `skill` 工具执行 | `Skill.get(name)` | 先从缓存定位 skill，再重新读取缓存 `location` 指向的 `SKILL.md` 正文；解析失败时回退到缓存正文。 |
| skill-as-command | `Skill.all()` | `Command.state` 在命令表末尾把未被占用的 skill 名补成 slash command，模板使用扫描时缓存的 `skill.content`。 |
| Agent 目录白名单 | `Skill.dirs()` | 将当前 manifest 中的 `SKILL.md` 所在目录加入文件访问白名单，便于读取 skill 附带的 `scripts/`、`references/` 等资源。 |
| 服务端 skills 列表 | `Skill.all()` | 返回当前 instance 的完整 skill 列表，不做 agent permission 过滤。 |

完整链路可以概括为：

1. 请求或会话建立当前 `Instance.directory` / `Instance.worktree`。
2. 某个入口第一次调用 `Skill.all()`、`Skill.available()`、`Skill.get()` 或 `Skill.dirs()`。
3. `ensureWatch()` 确保当前 instance 的 skill watcher 已初始化。
4. `InstanceState` 命中则直接复用内存缓存；未命中则进入磁盘快照或全量扫描。
5. `buildSources()` 按 2.1 的顺序收集来源目录，分别构建 global / project manifest。
6. manifest 命中时读取磁盘快照；未命中时扫描 `SKILL.md`、解析 frontmatter 和正文，并写入新快照。
7. `mergeSkills()` 跳过 disabled 目录，再按 `order` 让高优先级同名 skill 覆盖低优先级候选。
8. 合并结果写入当前目录的 `InstanceState`，后续同目录请求优先复用。
9. 系统提示和 `skill` 工具描述只暴露 `name` / `description`；模型真正需要完整说明时调用 `skill({ name })`。
10. `SkillTool.execute()` 申请 `permission: "skill"`，重新读取 `SKILL.md` 正文，并返回 `<skill_content>`、base directory 和最多 10 个非 `SKILL.md` 附带文件示例。

这里需要特别区分内置 `skill` 工具和 skill-as-command：

| 使用方式 | 典型形式 | 是否走 `SkillTool.execute()` | 正文来源 | 运行中只修改正文后的效果 |
|----------|----------|-----------------------------|----------|--------------------------|
| 内置 `skill` 工具 | 模型调用 `skill({ name: "foo" })` | 是 | 通过缓存找到 `location` 后重新解析 `SKILL.md` | 通常能读到最新正文；若最新文件解析失败，回退到缓存正文。 |
| skill-as-command | 用户输入 `/foo` | 否 | `Command.state` 构建时缓存的 `skill.content` | 不会因为一次执行而重新读取正文；需要 command 状态重建，仅清 Skill 缓存不一定刷新已有命令表。 |

skill-as-command 只是 command 层对已发现 skill 的补位注册：如果同名 command 已经存在，skill 不会覆盖它；它也不改变 skill 自身的发现、禁用和同名覆盖规则。

还需要注意，skill-as-command 走的是普通 command 模板执行路径：会处理 `$1` / `$ARGUMENTS` 参数替换、`@file` 文件引用和 ``!`shell` `` 插值；它不会申请 `permission: "skill"`，也不会返回 `SkillTool.execute()` 中的 base directory 或辅助文件样例。

### 2.4 重新扫描与正文刷新边界

Skill 系统的刷新分两层：**列表刷新**和**正文刷新**。列表刷新会重新计算有哪些 skill、它们的 `name` / `description` / `location` / `conditions` / `platforms` 以及同名覆盖结果；正文刷新则只发生在内置 `skill` 工具执行时，针对已缓存的 `location` 重新读取 `SKILL.md` 内容。

| 变化场景 | 是否重新扫描列表 | 当前实现中的结果 |
|----------|------------------|------------------|
| 首次访问某个 `Instance.directory` | 会 | 当前目录没有 Skill `InstanceState`，会执行加载流程。 |
| watcher 检测到 global skill 目录变更 | 会，在下次访问时 | 清理所有 active instance 的 Skill 内存缓存，后续按需重建。 |
| watcher 检测到 project skill 目录变更 | 会，在下次访问时 | 只清理当前 project instance 的 Skill 内存缓存。 |
| 通过配置 API 切换 `skills.disabled` | 会，在下次访问时 | `Config.toggleSkill()` 会调用 `Skill.clearSkillsPromptCache()` 清理相关 scope。 |
| `skill_manage create/edit/patch/delete/rollback` 修改 `SKILL.md` 类状态 | 会，在下次访问时 | 操作成功后主动清 Skill 内存缓存，并标记 `SkillDirty`。 |
| `skill_manage write_file/remove_file` 修改辅助文件 | 不主动清列表缓存 | 会保存版本并发布文件事件，但不改变已登记的 skill 列表、描述或正文缓存。 |
| 手动新增、删除或修改 `SKILL.md` | 会，取决于 watcher 是否捕获 | watcher 只负责失效；真正扫描发生在下一次 `Skill.*` 调用。 |
| 只修改已登记 skill 的正文，并立即通过内置 `skill` 工具调用 | 不依赖列表重扫 | `SkillTool.execute()` 会按缓存 `location` 重新解析 `SKILL.md`，通常能读到最新正文。 |
| 只修改已登记 skill 的 `name` 或 `description` | 需要列表重扫 | 清理前系统提示、工具描述和 skill-as-command 仍使用旧缓存。 |
| 修改 `config.skills.paths` | 会，取决于 watcher / 配置刷新路径 | watcher 会周期性比较 `skills.paths` 签名并重建 roots；通过配置 API 更新也会清 instance。 |
| 修改 `config.skills.urls` | 不保证立即生效 | URL 拉取发生在 skill 加载流程中；更稳定的刷新方式是配置 reload / dispose 或重启。 |

因此，判断运行中变更是否生效时要看两个问题：

1. 变更是否影响“列表”：新增 / 删除 skill、修改 `name`、修改 `description`、修改禁用状态、修改来源路径，都需要列表缓存失效后重新加载。
2. 变更是否只影响“正文”：已登记 skill 的正文变化，在内置 `skill` 工具执行路径上通常可以立即读取；但系统提示、工具描述和 skill-as-command 都仍依赖扫描时的缓存内容。

还有几个容易混淆的边界：

- watcher 和 `Skill.clearSkillsPromptCache()` 只清内存缓存；磁盘快照不会被同步删除，下一次加载会根据 manifest 决定复用旧快照还是重建。
- `conditions` 只在系统提示构建路径中过滤；`Skill.available()`、`skill` 工具描述和服务端 skills 列表不会按 `conditions` 过滤。
- `platforms` 当前只被解析并保存在 `Skill.Info` 中，还没有接入系统提示或工具可用性过滤。
- skill-as-command 使用 `Command.state` 构建时的 `skill.content`，不具备 `SkillTool.execute()` 的“执行时重新读正文”行为。
- skill 目录会被加入 agent 的 `external_directory` 白名单，便于读取辅助资源；当前 edit/write 工具主要通过描述提示要求使用 `skill_manage`，`skill-file-guard.ts` 尚未实际接入这些写入工具。

---

## 3. Skills 自演化机制

自演化系统允许 Agent 在实际工作过程中，主动或自动地将有价值的经验固化为可复用的 skill，供后续对话使用。

### 3.1 两条演化路径总览

```
Agent 正在对话中执行任务
        │
        ├───────────────────────────────────────────────────┐
        │                                                   │
        ▼ 路径一（随时触发）                 路径二（对话结束后触发）▼
Agent 主动判断有值得保存的经验         对话正常结束，且同时满足：
直接调用 skill_manage                  ① 计数器 ≥ 阈值（默认 10）
写入或更新 skill                       ② final_response 成立
                                       ③ 用户未中断
                                       ④ 非评审 session 本身
                                               │
                                               ▼
                                    spawn 子 session（静默后台）
                                    分析整段对话历史
                                    决定是否调用 skill_manage
        │                                      │
        └──────────────────┬────────────────────┘
                           │ 两路均通过 skill_manage 写入
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  skill_manage 写入 .aether/skills shadow / managed 目录        │
│  SKILL.md 变更会清 Skill 内存缓存，并通过 SkillDirty 刷新上下文 │
└──────────────────────────────────────────────────────────────┘
```

---

### 3.2 路径一：对话中实时演化

当 `skill_manage` 工具在当前工具集中可用时，Agent 在执行任务的过程中可以主动调用它来创建或更新 skill。系统通过**引导性提示**（`SKILLS_GUIDANCE`）告知 Agent 何时应该这样做：

> 完成复杂任务（5 步以上工具调用）、修复棘手错误、或发现非平凡工作流后，用 `skill_manage` 保存方案。
> 使用某个 skill 时如发现它已过时、不完整或有误，应立即用 `patch` / `edit` 更新。
> 创建或编辑 skill 时应包含 `category` 字段，并优先复用已有分类。

**计数器机制（同时服务两条路径）：**

```
每次 LLM 步骤结束后
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  满足计数条件？                                                │
│  ① 当前不是后台评审 session                                   │
│  ② 本步骤包含工具调用                                         │
│  ③ skill_manage 工具在当前 agent 工具集中可用                  │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  满足上述全部条件？        │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
             继续判断        计数器不变（结束）
                   │
               ┌───▼────────────────────┐
               │  本步骤调用了           │
               │  skill_manage？        │
               └───┬────────────────────┘
                是/  \ 否
               /        \
              ▼          ▼
        先重置为 0    计数器直接 +1
        再 +1
        （净结果 = 1）
```

效果：
- Agent 每调用一次 `skill_manage`，计数器归 1 重新起算
- 计数器累积到阈值时触发后台评审（见 3.3）
- 将 `config.skills.creation_nudge_interval` 设为 0 会关闭 skill 自演化工具链：`skill_manage` 不再注册到工具集，后台评审不会触发，系统提示也不再追加自演化引导

---

### 3.3 路径二：对话后后台评审

**触发条件（四个条件同时满足）：**

```
① 计数器 >= creation_nudge_interval（默认 10，即约 10 个工具步骤）
② 对话以正常 final_response 结束（非强制截断）
③ 用户未中途中断（abort 信号未触发）
④ 当前 session 不是后台评审本身（防止递归，以 title 字段识别）
```

满足后立即将计数器重置为 0，然后异步启动评审流程（不阻塞主流程返回）。

**后台评审完整流程：**

```
触发后台评审，计数器立即重置为 0
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  创建子 session                                               │
│  title = "__skill_review__"（防递归标识）                      │
│  继承父 session 的 agent 名称和模型                            │
│  权限中禁止 task 工具和 todowrite 工具                          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  构建评审提示                                                  │
│  将原始对话完整消息历史（含工具调用及结果）                       │
│  序列化为 <conversation_history> 块，追加 SKILL_REVIEW_PROMPT  │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  向子 session 发送评审提示                                      │
│  由 SessionPrompt.prompt 正常执行，输出不直接写入父会话          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  评审 Agent 分析对话历史，判断是否存在值得保存的经验：            │
│  ① 非平凡方案，经历反复试错或改变方向                           │
│  ② 实际解决方式与最初预期不同（实践发现更好路径）                │
│  ③ 用户明确期望某种特定的工作方式或结果                          │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  决定保存？               │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
          调用 skill_manage   打印 "Nothing to save."
          create/patch/edit   子 session 结束
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  扫描子 session 所有消息                                       │
│  收集输出含 created/updated/patched/deleted 的 skill_manage   │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  有成功的写入记录？        │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
┌──────────────────────────┐  打印 "nothing to save"，结束
│  发布 SkillSaved 事件     │
│  更新 SkillDirty 状态     │
│  控制台打印操作摘要        │
│  [skill review] 💾 action │
└──────────────┬───────────┘
               │
               ▼
   UI 提示用户有 skill 被保存
```

---

### 3.4 演化写入路径（Shadow 目录）

**核心设计原则：外部原始 skill 采用 copy-on-write，优先写入 `.aether/skills/`。**

用户放在 `.claude/skills/`、`.agents/skills/`、`.opencode/skills/` 中的 skill 被视为外部原始版本。Agent 演化这些 skill 时，首次修改会先复制整个 skill 目录到同级 `.aether/skills/<name>/`，之后只修改 `.aether` shadow。若当前生效版本本来已经位于目标 `.aether/skills/<name>/`，则会在该目录中就地修改。

**Shadow 目录的计算规则：**

在原始路径中找到第一个配置目录标记（`.claude`、`.agents`、`.opencode`、`.aether`），
取其**上级目录**作为基准，然后在该基准目录下新建 `.aether/skills/<name>/` 路径。
外部原始配置目录本身不受影响，`.aether/` 是平行新建在旁边的独立目录；若原始来源已经在目标 `.aether/skills/<name>/`，则不会复制，会直接修改该目录。

```
场景一：项目内的外部配置目录
  原始：  /home/user/my-project/.claude/skills/my-skill/SKILL.md
                                 ↑ 找到 .claude，取其上级
  base：  /home/user/my-project/
  shadow：/home/user/my-project/.aether/skills/my-skill/   ← 新建，与 .claude/ 并列

场景二：全局 home 目录下的配置
  原始：  ~/.claude/skills/my-skill/SKILL.md
                   ↑ 找到 .claude，取其上级
  base：  ~/
  shadow：~/.aether/skills/my-skill/                       ← 新建，与 .claude/ 并列

场景三：新建 skill（无原始来源，Skill.get() 返回空）
  shadow：~/.aether/skills/my-skill/                       ← 直接落入全局 managed 目录
```

**首次演化的流程（copy-on-write）：**

```
skill_manage 请求修改一个已有 skill
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  resolveSkillDir                                              │
│  查询当前 skill 的原始位置（若存在）                             │
│  按规则计算对应的 shadow 目录路径                               │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  shadow 目录              │
               │  是否已存在？             │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
             （直接跳至       copyToShadowIfNeeded：
              执行修改）       将原始 skill 目录完整复制到 shadow
                              （含 SKILL.md 及所有辅助文件）
                    \               │
                     \              ▼
                      \        在 shadow 中创建 action=original 版本快照
                       \       （记录演化前初始状态，可 rollback 还原）
                        \           │
                         └──────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────┐
│  在 shadow 目录中执行本次修改操作                               │
│  （edit / patch / delete / rollback /                         │
│    write_file / remove_file）                                 │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  安全扫描（scanSkill）     │
               │  create/edit/patch/        │
               │  write_file 写入后检查风险 │
               └───────────┬──────────────┘
                    安全 /    \ 危险
                   /            \
                  ▼              ▼
┌──────────────────────────┐  回滚：
│  SKILL.md 类操作清内存缓存 │  还原文件内容，
│  并标记 SkillDirty        │  或删除刚创建的目录，
│  辅助文件操作只保存版本快照 │  向 Agent 报错（结束）
└──────────────┬───────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  SKILL.md 类操作 markClear + markDone                         │
│  进入 500ms 冷却期；辅助文件操作不进入该 mark 冷却流程           │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  创建版本快照                                                  │
│  action = create / edit / patch / write_file / remove_file /  │
│           rollback-*（delete 当前不保存 delete 快照）          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
                    返回成功结果
```

`create` 是一个特殊分支：`resolveSkillDir()` 仍会计算目标 `.aether/skills/<name>/`，但不会先 `copyToShadowIfNeeded()`，也不会保存 `original` 快照；如果目标 `SKILL.md` 不存在，它会直接在 shadow/managed 目录中新建文件。

**Shadow 目录优先级保证：**

shadow 目录（`.aether/`）在同一层级内晚于 `.agents`、`.claude`、`.opencode` 扫描，因此通常会遮蔽这些外部原始版本。需要注意：当前 `config.skills.paths` 和 `config.skills.urls` 会在 `.aether` 项目层级之后追加；如果其中存在同名 skill，它们仍可能覆盖 shadow 版本。

---

### 3.5 版本管理

`skill_manage` 成功执行 `create`、`edit`、`patch`、`write_file`、`remove_file`、`rollback` 时，会在 skill 目录内的 `.versions/` 文件夹中创建版本快照；修改已有外部 skill 并首次触发 copy-on-write 时，还会先保存一个 `original` 快照：

```
.aether/skills/my-skill/
├── SKILL.md
├── helper-script.sh
└── .versions/
    ├── v001_original_20260504T103000.bundle.json
    ├── v002_edit_20260504T104200.bundle.json
    └── v003_patch_20260504T110915.bundle.json
```

每个 `.bundle.json` 包含该时刻 skill 目录下所有文件的完整内容（`.versions/` 子目录本身除外）。文本内容按 `utf8` 保存，包含 null byte 的文件按 `base64` 保存。

默认版本数上限为 100 条，可通过全局配置 `skills.max_versions` 调整。超出上限后，系统不会简单删除最早版本，而是保留最早的 origin、最近的一批 active 版本，以及按 binary-ruler 权重挑选的一批里程碑版本。

**常用操作：**

- `skill_manage(action='history', name='my-skill')` — 列出所有版本，显示版本号、操作类型、时间戳
- `skill_manage(action='rollback', name='my-skill', version='v002')` — 将 skill 目录还原至指定版本的状态
- `skill_manage(action='delete', name='my-skill')` — 删除当前 `.aether` 演化目录；如果 skill 只存在于外部原始目录，会报错并保留原始文件

---

### 3.6 安全扫描

每次 `skill_manage` 执行 `create`、`edit`、`patch`、`write_file` 并向磁盘写入内容后，系统立即对写入目录执行安全扫描。扫描发现问题时，自动还原本次文件改动或删除刚创建的目录，并将错误返回给 Agent。`delete`、`remove_file` 和 `rollback` 当前不执行安全扫描；其中 `rollback` 会恢复历史 bundle 并再保存一个 `rollback-*` 快照，安全性取决于历史快照内容。

扫描检测的威胁类型包括：

- **数据渗出**：通过 curl/wget 携带环境变量或凭据的命令
- **提示注入**：要求忽略指令、角色劫持、越狱等模式
- **破坏性操作**：递归删除、磁盘格式化、危险的 dd 命令
- **持久化机制**：写入 crontab、修改 sudoers、向 SSH 目录写入密钥
- **供应链攻击**：`curl | bash` 模式、反向 shell
- **硬编码凭据**：API Key、私钥、Token 等
- **不可见字符**：用于混淆指令的零宽字符等

扫描范围限制：每个 skill 目录最多 50 个文件、总大小不超过 1024 KB、单个文件不超过 256 KB；`.versions/` 目录会被跳过。二进制或可执行扩展（`.exe`、`.dll`、`.so`、`.dylib` 等）会被标记为 critical，指向 skill 目录外的符号链接也会被标记为 critical。`assertAllowed()` 对 `ask` 和 `block` 决策都会抛错，因此危险的 agent-created skill 当前会被阻断。
