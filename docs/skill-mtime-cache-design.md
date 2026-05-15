# Skill 缓存 mtime 校验设计

当前 `InstanceState` 缓存在同一项目实例生命周期内只初始化一次，只有 `Instance.dispose()` 或 `shadow-writer.ts` 主动调用时才会失效。用户在外部手动编辑 `SKILL.md` 后，若没有重启实例，变化无法被感知。

本文档提出一种 **mtime 快照校验机制**：在每次读内存缓存之前，先把磁盘上所有 `SKILL.md` 的当前修改时间，与上次加载时保存在磁盘上的快照做比对。一致则直接用内存缓存，不一致则清空内存缓存并重新从磁盘加载，加载完后更新快照。

---

## 目录

- [现有缓存流程（改动前）](#现有缓存流程改动前)
- [改动后流程](#改动后流程)
- [isFresh 内部逻辑](#isfresh-内部逻辑)
- [快照文件](#快照文件)
- [State 结构不变](#state-结构不变)
- [改动位置](#改动位置)
- [能检测到的变化 vs 检测盲区](#能检测到的变化-vs-检测盲区)
- [与 skill-watcher 的关系](#与-skill-watcher-的关系)

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
│  ① 用 fs.stat 读取磁盘上所有已知 SKILL.md 的当前 mtime        │
│  ② 读取磁盘上的 mtime 快照文件（上次加载时保存的旧 mtime）      │
│  ③ 逐一比对                                                   │
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
           { path → mtime }    （视为不 fresh，需要重新加载）
                   │
                   ▼
遍历快照中每一条记录（path, 快照里的 mtime）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  fs.stat(path) 读取该文件当前的 mtime                         │
│                                                              │
│  stat 失败（文件已被删除）→ 立即返回 false                     │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼────────────────────────┐
               │  当前 mtime === 快照里的 mtime？     │
               └───────────┬────────────────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
           继续检查下一个     立即返回 false
           文件              （文件内容已被修改）

所有文件检查完毕，全部一致
        │
        ▼
返回 true
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
  async function isFresh(projectId: string): Promise<boolean> {
    const snapshot = await readSnapshot(projectId)
    if (!snapshot) return false
    for (const [skillPath, cachedMtime] of Object.entries(snapshot)) {
      const s = await fs.stat(skillPath).catch(() => null)
      if (!s || s.mtimeMs !== cachedMtime) return false
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

## 能检测到的变化 vs 检测盲区

```
能检测（mtime 会变化）：
  ✓ 编辑已有 SKILL.md 的内容
  ✓ 删除已有 SKILL.md（stat 失败 → 返回 false）
  ✓ 替换 SKILL.md（覆盖写入 → mtime 更新）
  ✓ 进程重启后文件发生了变化（快照持久化在磁盘上）

检测盲区：
  ✗ 在已监控目录下新增 SKILL.md
    → 新路径不在快照中，不会被检查到
    → isFresh 仍返回 true，新技能不可见
    → 依赖 Instance.dispose() 或 skill-watcher 兜底
```

新增技能的检测盲区是此方案的已知局限。如需覆盖，可在快照中额外记录各 `skills/` 目录本身的 mtime（目录 mtime 在子文件增删时会更新），但这是独立需求，本文档不展开。

---

## 与 skill-watcher 的关系

```
变更类型                   mtime 快照校验              skill-watcher
─────────────────────────  ─────────────────────────   ─────────────────────
手动编辑现有 SKILL.md       ✓ 下次访问时感知             ✓ 文件事件驱动，实时感知
                             （拉取式，有一次访问延迟）
shadow-writer.ts 写入       ✓ 兜底                      ✓ 主动失效优先
进程重启后文件有变化         ✓ 快照在磁盘上，跨进程有效   ✓ 重启后重新监听
新增 SKILL.md               ✗ 快照中无此路径，感知不到   ✓ 目录监听可感知
删除 SKILL.md               ✓ stat 失败 → 不 fresh       ✓ 文件事件驱动
```

mtime 快照校验是**拉取式**保险：无需额外进程，每次访问时顺带检查，在 skill-watcher 不可用时独立生效。两者互补，不冲突。
