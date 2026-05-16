# Skill 缓存 mtime 校验设计

当前 `InstanceState` 缓存在同一项目实例生命周期内只初始化一次，只有 `Instance.dispose()` 或 `shadow-writer.ts` 主动调用时才会失效。用户在外部手动编辑 `SKILL.md` 后，若没有重启实例，变化无法被感知。

本文档提出一种 **mtime 快照校验机制**：在每次读内存缓存之前，先把磁盘上所有 `SKILL.md` 的当前修改时间，与上次加载时保存在磁盘上的快照做比对。一致则直接用内存缓存，不一致则清空内存缓存并重新从磁盘加载，加载完后更新快照。

---

## 目录

- [对旧文件的改动](#对旧文件的改动)
- [现有缓存流程（改动前）](#现有缓存流程改动前)
- [改动后流程](#改动后流程)
- [isFresh 内部逻辑](#isfresh-内部逻辑)
- [快照文件](#快照文件)
- [State 结构不变](#state-结构不变)
- [改动位置](#改动位置)
- [能检测到的变化 vs 检测盲区](#能检测到的变化-vs-检测盲区)
- [与 skill-watcher 的关系](#与-skill-watcher-的关系)
- [性能问题与优化方向](#性能问题与优化方向)

---

## 对旧文件的改动

改动文件：`packages/opencode/src/skill/index.ts`

按对原有代码的侵入程度，分为三类：

---

### 侵入性改动

直接修改了现有函数中已有的代码行，改变了原有行为。

| 位置 | 原代码 | 修改后 |
|------|--------|--------|
| `get()` 方法体 | `yield* InstanceState.get(state)` | `yield* getState()` |
| `all()` 方法体 | `yield* InstanceState.get(state)` | `yield* getState()` |
| `dirs()` 方法体 | `yield* InstanceState.get(state)` | `yield* getState()` |
| `available()` 方法体 | `yield* InstanceState.get(state)` | `yield* getState()` |

**必要性**

mtime 校验必须在"读缓存"这一动作的入口处执行，否则校验无法生效。

`InstanceState.get(state)` 是 Skill 模块里唯一触发缓存读取的调用点——内存中有数据时直接返回，没有数据时才调用 `loadSkills()`。如果不在这里拦截，`isFresh()` 的检查就无处插入：

- 不能放在 `loadSkills()` 里：`loadSkills()` 只在缓存为空时执行，文件被外部修改后缓存仍然命中，`loadSkills()` 根本不会被调用到。
- 不能放在调用方（`get`/`all` 等）之外：这四个方法是对外的全部读接口，在更上层拦截意味着要跨越模块边界修改调用者，侵入范围反而更大。

因此，将这四处替换为 `getState()`（内部先调 `isFresh()`，不 fresh 则 `invalidate` 后再 `get`）是最小侵入方案：改动点最少，覆盖最完整，且逻辑收拢在一个地方便于后续维护。

---

### 新增

全新添加的函数/常量，在改动前完全不存在。

**模块级辅助函数**（添加在 `Skill` namespace 内，`loadSkills` 之前）：

| 函数 | 签名 | 作用 |
|------|------|------|
| `snapshotPath` | `(projectId: string) => string` | 返回快照文件的磁盘路径 |
| `readSnapshot` | `(projectId: string) => Promise<Record<string, number> \| null>` | 从磁盘读取 mtime 快照，文件不存在返回 `null` |
| `writeSnapshot` | `(projectId: string, snapshot: Record<string, number>) => Promise<void>` | 将 mtime 快照写入磁盘，目录不存在时自动创建 |
| `scanAllSkillPaths` | `(directory, worktree, projectId) => Promise<string[]>` | 镜像 `loadSkills` 的扫描逻辑，仅收集路径，不加载内容，供 `isFresh` 比对用 |
| `isFresh` | `(projectId, directory, worktree) => Promise<boolean>` | 对比磁盘快照与当前文件系统状态，判断缓存是否仍然有效 |

> `scanAllSkillPaths` 并非从 `loadSkills` 提取重构而来——`loadSkills` 原有代码完整保留，`scanAllSkillPaths` 是并行新增的镜像，只做路径收集（`Glob.scan` 返回路径列表）而不做 skill 加载（`scan(state, ...)` 写入 State）。

**`Skill.layer` 内新增的局部常量**：

```typescript
const getState = Effect.fn("Skill.getState")(function* () {
  const instance = Instance.current
  const projectId = String(instance.project.id)
  const fresh = yield* Effect.promise(() => isFresh(projectId, instance.directory, instance.worktree))
  if (!fresh) yield* InstanceState.invalidate(state)
  return yield* InstanceState.get(state)
})
```

作为四个读方法共用的前置包装，封装"检查 mtime → 按需失效 → 取 State"三步逻辑。

---

### 插入性改动

嵌入到现有文件的固定位置，但不修改任何已有代码行；去掉这部分代码，原有逻辑可完整复原。

**文件顶部 import 块新增两行**：

```typescript
import fs from "fs/promises"          // 第 1 行（首行插入）
import { Instance } from "@/project/instance"   // 插入在现有 import 块中
```

**`loadSkills()` 末尾追加快照写入块**（追加在 "Remove disabled skills" 逻辑之后）：

```typescript
// Write mtime snapshot so isFresh() can detect external edits on the next access.
const snapshot: Record<string, number> = {}
for (const info of Object.values(state.skills)) {
  const stat = await fs.stat(info.location).catch(() => null)
  if (stat) snapshot[info.location] = stat.mtimeMs
}
await writeSnapshot(projectId, snapshot)
```

`loadSkills` 原有的初始化、扫描、禁用逻辑均未被触碰；这段代码只是在函数返回前多做一件事——把本次加载结果的 mtime 固化到磁盘，供下次 `isFresh` 调用时比对。

---

## 现有缓存流程（改动前）

内存缓存（InstanceState）的结构：

```
内存中的缓存对象
  │
  ├── "/home/zheng/code/Aether"   → State { skills, dirs }
  ├── "/home/zheng/code/Binance"  → State { skills, dirs }
  └── ...

State = {
  skills: { "check-pr": {...}, "review": {...} },  // 所有技能
  dirs:   Set { "/path/to/skills" },               // 扫描过的目录
}
```

调用流程：

```
调用 Skill.available() / Skill.get() / Skill.all()
        │
        ▼
InstanceState.get(state)
用 Instance.directory（当前项目路径）做 key 查内存缓存
        │
        ├── 内存中有这个项目的数据 → 直接返回
        │   ← 不检查磁盘，无法感知外部对 SKILL.md 的修改
        │
        └── 内存中没有 → loadSkills() 从磁盘读
                         存入内存缓存，返回
```

**问题所在**：内存命中后直接返回，不与磁盘做任何比对。外部手动修改 `SKILL.md` 后，只要实例没有重启，改动对运行中的程序完全不可见。

---

## 改动后流程

在读内存缓存之前，先做一次磁盘层面的 mtime 比对。比对所需的"旧数据"不存在内存中，而是以快照文件的形式保存在磁盘上，所以这一步完全独立于内存缓存，可以放在 `InstanceState.get` 之前执行。

```
调用 Skill.available() / Skill.get() / Skill.all()
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  isFresh()                                                   │
│                                                              │
│  ① 扫描 skills 相关目录，用 fs.stat 读取当前所有 SKILL.md 的   │
│     mtime，得到当前磁盘状态 { path → mtime }                  │
│  ② 读取磁盘上的 mtime 快照文件（上次加载时保存的旧 mtime）      │
│  ③ 比对两份数据（数量、路径、mtime 三项全部一致才算 fresh）      │
│                                                              │
│  快照文件不存在（首次运行）→ 视为「不 fresh」                   │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────┐
               │  isFresh 返回 true？  │
               └───────────┬──────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
                   │     清空内存中当前项目的缓存
                   │            │
                   └─────┬──────┘
                         │
                         ▼
        InstanceState.get(state)
        用 Instance.directory 做 key 查内存缓存
                         │
                         ├── 内存中有这个项目的数据 → 直接返回
                         │
                         └── 内存中没有 → loadSkills() 从磁盘读
                                          存入内存缓存
                                          写磁盘快照（覆盖旧快照）
                                          返回
```

---

## isFresh 内部逻辑

```
isFresh() 被调用
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  扫描 skills 相关目录（与 loadSkills() 扫描的目录相同）          │
│  对找到的每个 SKILL.md 执行 fs.stat，得到其当前 mtime           │
│  结果：当前磁盘状态 { path → mtime }                           │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  读取磁盘上的 mtime 快照文件                                   │
│  路径：~/.aether/skill-snapshots/<project-id>.json           │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────┐
               │  快照文件存在？        │
               └───────────┬──────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
           读取快照内容         返回 false
           { path → mtime }    （首次运行，视为不 fresh）
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  比对当前磁盘状态与快照                                        │
│                                                              │
│  · 当前有、快照没有 → 新增了 skill    → 返回 false             │
│  · 快照有、当前没有 → 删除了 skill    → 返回 false             │
│  · 同一路径 mtime 不同 → 文件被修改   → 返回 false             │
│  · 完全一致                          → 返回 true              │
└──────────────────────────────────────────────────────────────┘
```

---

## 快照文件

快照是一个 JSON 文件，存在磁盘上，内容是上次 `loadSkills()` 扫描到的所有 `SKILL.md` 的路径和修改时间：

```
~/.aether/skill-snapshots/<project-id>.json

内容示例：
{
  "/home/zheng/code/Aether/.aether/skills/check-pr/SKILL.md": 1748000000000,
  "/home/zheng/code/Aether/.claude/skills/review/SKILL.md":   1747000000000
}
```

写入时机：每次 `loadSkills()` 完成后，把这次读到的所有 `SKILL.md` 的 mtime 写入快照，覆盖旧文件。

因为快照存在磁盘上，进程重启后依然有效。进程重启时内存缓存是空的，但 `isFresh` 仍可正常比对——若快照和磁盘一致，`InstanceState.get` 会触发 `loadSkills()` 重新加载（内存为空所以必须加载），流程正确。

---

## State 结构不变

与我此前提出的方案不同，此方案的快照单独存在磁盘上，State 不需要增加任何字段：

```
State = {
  skills: Record<string, Info>,   // 技能名 → 技能信息（不变）
  dirs:   Set<string>,            // 扫描过的目录（不变）
}
```

---

## 改动位置

改动集中在 `packages/opencode/src/skill/index.ts`，共三处：

```
改动 1：loadSkills() 完成后写快照
  在 loadSkills() 最后追加：
  const snapshot: Record<string, number> = {}
  for (const info of Object.values(state.skills)) {
    const s = await fs.stat(info.location).catch(() => null)
    if (s) snapshot[info.location] = s.mtimeMs
  }
  await writeSnapshot(projectId, snapshot)

改动 2：新增 isFresh() 函数
  async function isFresh(projectId: string, directory: string, worktree: string): Promise<boolean> {
    // 第一步：扫描当前磁盘上所有 SKILL.md，得到 { path → mtime }
    const current: Record<string, number> = {}
    for (const match of await scanAllSkillPaths(directory, worktree)) {
      const s = await fs.stat(match).catch(() => null)
      if (s) current[match] = s.mtimeMs
    }

    // 第二步：读快照
    const snapshot = await readSnapshot(projectId)
    if (!snapshot) return false

    // 第三步：比对
    const currentPaths = new Set(Object.keys(current))
    const snapshotPaths = new Set(Object.keys(snapshot))
    if (currentPaths.size !== snapshotPaths.size) return false
    for (const [path, mtime] of Object.entries(current)) {
      if (snapshot[path] !== mtime) return false
    }
    return true
  }

改动 3：Skill.layer 内新增 getState() 辅助函数
  替换所有 InstanceState.get(state) 的调用：
  const getState = Effect.fn("Skill.getState")(function* () {
    const fresh = yield* Effect.promise(() => isFresh(projectId))
    if (!fresh) {
      yield* InstanceState.invalidate(state)  // 清空内存缓存
    }
    return yield* InstanceState.get(state)    // 内存有则直接取，没有则 loadSkills()
  })

  get / all / dirs / available 四个方法
  将原来的 InstanceState.get(state) 替换为 getState()
```

快照的读写封装为两个辅助函数：

```
readSnapshot(projectId):
  读 ~/.aether/skill-snapshots/<projectId>.json
  文件不存在返回 null，否则返回解析后的对象

writeSnapshot(projectId, snapshot):
  将 snapshot 写入 ~/.aether/skill-snapshots/<projectId>.json
```

---

## 能检测到的变化

```
✓ 编辑已有 SKILL.md 的内容     mtime 变化 → 比对不一致 → 不 fresh
✓ 新增 SKILL.md               扫描时发现新路径，快照里没有 → 不 fresh
✓ 删除 SKILL.md               扫描结果比快照少一条 → 不 fresh
✓ 替换 SKILL.md               覆盖写入 → mtime 更新 → 不 fresh
✓ 进程重启后文件有变化          快照在磁盘上持久化，重启后仍可比对
```

---

## 性能问题与优化方向

### 实测耗时

日志（`~/.local/share/aether/log/dev.log`）显示，`isFresh` 每次调用耗时 19～87ms：

```
INFO  service=skill fresh=false ms=87 isFresh check
INFO  service=skill fresh=false ms=19 isFresh check
```

且几乎全部返回 `false`，缓存从未命中（原因另见下节）。

### 为什么这么慢

`isFresh` 每次调用做两件事：

1. **stat 已知文件**：对快照里每个 skill 文件各做一次 `fs.stat`，检测修改和删除。每次 stat 是一次系统调用，在 WSL2 上需要跨 Linux→Windows 文件系统桥，单次就有几毫秒开销。

2. **glob 全量扫描**（`scanAllSkillPaths`）：对 4 个全局目录 + 项目路径沿途每一级目录各做一次递归目录遍历，检测是否有新增 skill。glob 内部要对每一级目录执行 `readdir`，读出所有目录项名称，再逐层递归，系统调用次数远多于 stat。

这两步的开销接近 `loadSkills()` 本身，相当于"为了判断要不要加载，先做了一半加载的工作"。

### 优化方向：用 readdir 计数替代 glob

stat 已经覆盖了"已有文件是否被改/删"这两种情况。glob 唯一多做的事是发现新增 skill。

新增一个 skill 必然在 `skills/` 顶层多出一个子目录。因此不需要递归遍历整棵树，只需 `readdir` 一下 `skills/` 的第一层，数一下子目录数量，与快照里存的数量对比——数量变了说明有新增，没变则不用继续扫。

`readdir` 只读一层、一次系统调用，比递归 glob 便宜得多。

快照格式相应调整，新增一个 `dirCounts` 字段：

```json
{
  "dirCounts": {
    "/home/zheng/.aether/skills": 5,
    "/home/zheng/.claude/skills": 2
  },
  "files": {
    "/home/zheng/.aether/skills/check-pr/SKILL.md": 1748000000000
  }
}
```

`isFresh` 的新逻辑：

```
① 对 snapshot.files 里每个路径做 stat，检测修改/删除
② 对 snapshot.dirCounts 里每个目录做 readdir，数子目录数量，检测新增
③ 两项都一致 → fresh
```

去掉 `scanAllSkillPaths` 调用后，`isFresh` 的系统调用次数从"几十次"降为"文件数 + 目录数"，预计耗时可降到 5ms 以内。

### 对旧文件的改动分类

#### 直接替换方案（侵入性大）

最直接的做法是修改现有的 `readSnapshot`、`writeSnapshot`、`isFresh` 函数，同时删除 `scanAllSkillPaths`：

| 类型 | 位置 |
|------|------|
| 删除 | `scanAllSkillPaths` 整个函数 |
| 新增 | `Snapshot` 类型定义 |
| 侵入性 | `readSnapshot` 返回类型 |
| 侵入性 | `writeSnapshot` 参数类型 |
| 侵入性 | `isFresh` 函数签名（去掉 `directory`、`worktree` 参数） |
| 侵入性 | `isFresh` 函数体（移除 glob，改为 readdir 计数） |
| 侵入性 | `loadSkills` 末尾快照写入块（写新格式） |
| 侵入性 | `getState` 中 `isFresh` 的调用（去掉两个参数） |

侵入性改动共 6 处，改动面较大。

#### 最小侵入方案（推荐）

不改任何现有函数，而是平行新增一套快照机制，只在 `getState` 的调用处做一行切换：

- **新增**：`Snapshot2` 类型、`readSnapshot2`、`writeSnapshot2`、`isFreshFast` 函数
- **插入性**：`loadSkills` 末尾追加 `writeSnapshot2(...)` 调用（紧跟现有 `writeSnapshot` 之后）
- **侵入性**：`getState` 里 1 行，把 `isFresh(...)` 换成 `isFreshFast(...)`

原有的 `readSnapshot`、`writeSnapshot`、`isFresh`、`scanAllSkillPaths` 全部保持不动，变为死代码，后续可单独清理。侵入性改动从 6 处降到 1 处。

---

## 与 skill-watcher 的关系

```
变更类型                   mtime 快照校验              skill-watcher
─────────────────────────  ─────────────────────────   ─────────────────────
手动编辑现有 SKILL.md       ✓ 下次访问时感知             ✓ 文件事件驱动，实时感知
                             （拉取式，有一次访问延迟）
shadow-writer.ts 写入       ✓ 兜底                      ✓ 主动失效优先
进程重启后文件有变化         ✓ 快照在磁盘上，跨进程有效   ✓ 重启后重新监听
新增 SKILL.md               ✓ 扫描时发现新路径，不 fresh  ✓ 目录监听可感知
删除 SKILL.md               ✓ stat 失败 → 不 fresh       ✓ 文件事件驱动
```

mtime 快照校验是**拉取式**保险：无需额外进程，每次访问时顺带检查，在 skill-watcher 不可用时独立生效。两者互补，不冲突。

---

## feat/skill-evolution 的 manifest 机制

`feat/skill-evolution` 分支实现了一套更彻底的缓存方案，从根本上解决了当前 `scanAllSkillPaths` 与 `loadSkills` 不对称的问题。

### 核心思路

当前方案的问题在于两边语义不一致：

- **snapshot** 记录的是"解析成功且未被禁用的 skill 文件路径 → mtime"
- **scanAllSkillPaths** 返回的是"glob 扫到的所有 SKILL.md 路径"（包含解析失败、被覆盖的文件）

`feat/skill-evolution` 的解法：**两边都用同一份原始 manifest**。snapshot 里不仅存加载结果（skills 列表），还同时存一份原始 manifest（所有 SKILL.md 的路径 + mtime + size）。判断新鲜度时，重新扫一遍磁盘构建新 manifest，与 snapshot 里的旧 manifest 逐条对比——因为两边都是 raw，所以天然对称，不存在孤儿路径的问题。

### 类型定义

```typescript
// filepath → [mtimeMs, size]
type SnapshotManifest = Record<string, [number, number]>

// snapshot 文件格式
{
  version: 3,
  manifest: SnapshotManifest,   // 原始文件清单（用于新鲜度判断）
  skills: SnapshotSkill[],      // 加载结果（命中时直接用）
}
```

mtime + size 双重校验：只改内容不改扩展名的场景（如覆盖写同大小内容）下，单靠 mtime 可能漏检，size 作为补充保险。

### 关键函数

**`buildSkillsManifest(dirs)`**

对给定目录列表进行 glob 扫描（`**/SKILL.md`，`dot: true`），对每个结果文件执行 `fs.stat`，将路径和 `[mtimeMs, size]` 写入 manifest 对象并返回。解析失败的文件、`.archive/` 下的归档文件、无 frontmatter 的文件，全部一律收录——manifest 只关心文件存在与否和元数据，不做语义过滤。

**`manifestsMatch(a, b)`**

对两份 manifest 做完全对比：先比较 key 数量，再对排序后的 key 列表逐一比对路径、mtime、size 三元组，任一不同则返回 false。

**`loadSkillsSnapshot(snapshotPath, manifest)`**

读取 snapshot 文件，校验 version 字段后，用 `manifestsMatch` 比较文件里存的旧 manifest 与入参的新 manifest：

- 一致 → 返回缓存的 skills 列表（cache hit）
- 不一致 → 返回 null（cache miss，需要重新扫描）

**`writeSkillsSnapshot(snapshotPath, manifest, skills)`**

原子写入：先写临时文件（`snapshotPath + ".tmp." + Date.now()`），写完后 `rename` 替换目标文件，避免写到一半时进程崩溃导致快照损坏。

### Global / Project 分离

`feat/skill-evolution` 把扫描目录分为 global（`~/.aether/`、`~/.claude/` 等）和 project（当前项目路径沿途的 `.aether/` 等）两个 scope，分别维护独立的 snapshot 文件：

```
~/.cache/aether/.skills_prompt_snapshot.global.json   ← 全局 snapshot
~/.cache/aether/skills-prompt/<slug>.<hash>.json      ← 项目 snapshot
```

全局 snapshot 在不同项目之间可以复用——只要 `~/.aether/skills/` 没有变化，切换项目时全局 skill 列表直接命中缓存，不需要重新扫描。

### 完整加载流程

```
loadSkillsData(directory, worktree)
        │
        ├── buildSources()    构建扫描源列表（含 scope、dir、pattern、order）
        │
        ├── manifestDirs()    从 sources 提取 global / project 目录列表
        │
        ├── buildSkillsManifest(globalDirs)   → globalManifest
        ├── buildSkillsManifest(projectDirs)  → projectManifest
        │   （只做 stat，不解析文件内容，比 glob+parse 便宜）
        │
        ├── loadSkillsSnapshot(globalPath, globalManifest)
        │       ├── hit  → 直接用缓存的 globalSkills
        │       └── miss → scanSources("global") → 解析文件 → writeSkillsSnapshot(...)
        │
        ├── loadSkillsSnapshot(projectPath, projectManifest)
        │       ├── hit  → 直接用缓存的 projectSkills
        │       └── miss → scanSources("project") → 解析文件 → writeSkillsSnapshot(...)
        │
        └── mergeSkills(globalSkills, projectSkills, disabled)
                按 order 排序后合并，project 覆盖 global，过滤 disabled
```

### 如何解决 .archive/ 的问题

当前方案的 `.archive/` bug 根因是：`loadSkills` 只把解析成功的文件写进 snapshot，而 `scanAllSkillPaths` 把解析失败的文件（如无 frontmatter 的归档测试 skill）也返回出来，导致 Phase 2 永远发现"当前路径不在 snapshot 里"，缓存永远 miss。

manifest 机制不存在这个问题：`buildSkillsManifest` 的结果包含所有 SKILL.md（含 `.archive/` 下的），snapshot 里存的旧 manifest 也是同样逻辑产生的，两边用完全相同的函数构建，天然对称。无论 `.archive/` 下有多少文件、是否能解析、是否有同名覆盖，都不会产生孤儿路径。

### 与当前方案的对比

| 维度 | 当前方案（feat/manifest） | feat/skill-evolution |
|---|---|---|
| 新鲜度判断 | scanAllSkillPaths（raw）vs snapshot（仅加载成功的） | manifest（raw）vs snapshot.manifest（raw） |
| 两边是否对称 | 不对称，.archive/ 解析失败的文件造成孤儿路径 | 完全对称，两边用同一函数构建 |
| .archive/ 问题 | 需要手动过滤补丁 | 不存在 |
| snapshot 格式 | `{ path: mtime }` | `{ version, manifest: { path: [mtime, size] }, skills: [...] }` |
| 文件变化检测 | mtime | mtime + size（更严格） |
| 写入安全性 | 直接写 | tmp + rename（原子写入） |
| Global/Project 分离 | 无（单文件，按 projectId 区分） | 有（全局 snapshot 跨项目复用） |
| 扫描函数重复 | loadSkills + scanAllSkillPaths 两套逻辑 | buildSources 统一描述，无重复 |

---

## 改进方案：manifest 写入对齐

### 旧方案 vs 新方案

当前方案的根本缺陷在于快照的**写入端**和**校验端**使用了不同的数据源：

| | 写入快照（loadSkills 末尾） | 读取校验（isFresh Phase 2） |
|---|---|---|
| 数据来源 | `state.skills`（仅解析成功且未被禁用的 skill） | `scanAllSkillPaths`（glob 原始结果，含解析失败文件） |
| `.archive/` 处理 | 解析失败的归档文件不进 `state.skills`，不写入快照 | glob 返回所有 `.archive/` 路径，包括无 frontmatter 的文件 |
| 结果 | 快照中缺少 `.archive/` 孤儿路径 | Phase 2 发现孤儿路径不在快照 → 永远 miss |

新方案只改一件事：**让写入端和校验端使用同一份数据**。具体做法是，写快照时不再遍历 `state.skills`，而是调用与 `scanAllSkillPaths` 同源的函数扫出所有 SKILL.md 文件并记录其 mtime，写入快照。这样快照与 `isFresh` Phase 2 的数据集天然对齐，不存在孤儿路径。

快照格式、`isFresh` 逻辑、`scanAllSkillPaths` 本身均**无需改动**。

### 新增函数：`buildManifest`

在 `scanAllSkillPaths` 下方新增一个函数，对其返回的路径逐一执行 `fs.stat`，得到 `{ 路径 → mtime }` 的完整 manifest：

```typescript
async function buildManifest(directory: string, worktree: string, projectId: string): Promise<Record<string, number>> {
  const paths = await scanAllSkillPaths(directory, worktree, projectId)
  const manifest: Record<string, number> = {}
  for (const p of paths) {
    const stat = await fs.stat(p).catch(() => null)
    if (stat) manifest[p] = stat.mtimeMs
  }
  return manifest
}
```

`buildManifest` 内部复用 `scanAllSkillPaths`，不重复扫描逻辑。`scanAllSkillPaths` 保持不动。

### 改动位置

以下改动均相对于 **dev 分支**（`loadSkills` 在 dev 上没有任何快照写入逻辑，`isFresh`、`scanAllSkillPaths` 等函数均为 feat/manifest 新增）。

#### 新增（全新代码，不触碰 dev 任何现有代码行）

| 位置 | 内容 |
|---|---|
| `scanAllSkillPaths` 函数体之后 | 新增 `buildManifest` 函数 |
| `snapshotPath` / `readSnapshot` / `writeSnapshot` | 沿用 feat/manifest 已新增的三个辅助函数，无需额外改动 |
| `isFresh` | 沿用 feat/manifest 已新增的函数，无需额外改动 |
| `getState` | 沿用 feat/manifest 已新增的局部常量，无需额外改动 |

#### 插入性改动（在 dev 原有代码的固定位置嵌入，不修改任何 dev 已有代码行）

| 位置 | 内容 |
|---|---|
| `loadSkills` 末尾（Remove disabled skills 逻辑之后） | 追加快照写入块，调用 `buildManifest` 后写入快照 |

```typescript
// Write manifest snapshot so isFresh() can detect external edits on the next access.
const snapshot = await buildManifest(directory, worktree, projectId)
await writeSnapshot(projectId, snapshot)
```

dev 上 `loadSkills` 末尾没有任何快照相关代码，这段是纯插入，移除后原有逻辑可完整复原。

其余所有 dev 原有函数（`scan`、`add`、`loadSkills` 主体、`get`/`all`/`dirs`/`available` 等）**均不改动**。

### 改动后的数据流

```
loadSkills() 结束时
        │
        ▼
buildManifest(directory, worktree, projectId)
  └── scanAllSkillPaths(...)   ← 与 isFresh Phase 2 完全相同的扫描逻辑
        └── fs.stat 每个路径   ← 得到 { path → mtime }
        │
        ▼
writeSnapshot(projectId, snapshot)
  快照现在包含所有扫描到的 SKILL.md（含 .archive/、无 frontmatter 的文件）

──────────────────────────────────────────────

isFresh() 校验时（逻辑不变）
        │
Phase 1: 遍历 snapshot 每条记录 → fs.stat 检测修改和删除  ✓
        │
Phase 2: scanAllSkillPaths(...) → 检查每条路径是否在 snapshot 中
         因为 snapshot 由同一扫描逻辑写入 → 路径集合完全一致 → Phase 2 始终通过  ✓
        │
        ▼
        返回 true（fresh）
```

### 与 feat/skill-evolution 的关系

| 维度 | feat/skill-evolution | 本方案 |
|---|---|---|
| 对称性保证 | `buildSources` 统一描述扫描逻辑，两端共用 | `buildManifest` 内部调用 `scanAllSkillPaths`，两端共用 |
| Global/Project 分离 | 有，两个独立 snapshot | 无，单一 snapshot（按 projectId 区分） |
| Snapshot 格式 | `{ version, manifest: { path: [mtime, size] }, skills: [...] }` | `{ path: mtime }`（保持现有格式不变） |
| 原子写入 | tmp + rename | 现有 writeSnapshot 行为（不改） |
| 侵入性 | 较大（重写整个缓存机制） | 极小（新增 1 函数 + 修改 1 处写入逻辑） |
| .archive/ 问题 | 根本不存在 | 修复 |
