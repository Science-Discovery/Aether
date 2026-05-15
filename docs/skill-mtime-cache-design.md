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
