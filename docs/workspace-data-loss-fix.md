# 工作区数据丢失原因分析与修复方案

## 问题概述

在 Aether 中创建 workspace 后，重启 Aether 发现 workspace 记录和关联的 session 记录消失，但 workspace 对应的 git worktree 分支（`fix/ui-and-session-bugs`）仍然存在于磁盘上。

## 现象

| 检查项                                  | 状态                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| workspace 表                            | 空（0 行）                                                                                            |
| session.workspace_id                    | 全部为空                                                                                              |
| event / event_sequence 表               | 空（0 行）                                                                                            |
| git worktree 物理目录                   | 存在，位于 `~/.local/share/aether/worktree/<projectId>/gentle-island`，分支 `fix/ui-and-session-bugs` |
| project_recent 中 worktree 路径条目     | 存在但会被 `registerUntrackedProjects` Phase 2 删除                                                   |
| global_project_map 中 worktree 路径条目 | 存在                                                                                                  |
| project 行                              | 存在，worktree 指向主项目目录                                                                         |

## 根本原因

### 原因 1：`Workspace.create()` 未确保 project 行先存在，FK 约束导致插入静默失败

**代码位置**: `packages/opencode/src/control-plane/workspace.ts:58-90`

`Workspace.create()` 的执行流程：

```ts
// 1. 获取 adaptor 并 configure
const adaptor = await getAdaptor(input.type)
const config = await adaptor.configure({ ...input, id, name: null, directory: null })

// 2. 直接插入 workspace 行
Database.useProject(input.projectID, (db) => {
  db.insert(WorkspaceTable)
    .values({ id: info.id, type: info.type, ..., project_id: info.projectID })
    .run()
})

// 3. 创建物理 worktree（即使 DB 插入失败也会执行）
await adaptor.create(config)
```

**问题**：第 2 步直接向项目 DB 插入 workspace 行，但 `Database.useProject()` 调用 `Database.attach()`，后者设置 `PRAGMA foreign_keys = ON`（`db.ts:451`）。workspace 表有 FK 约束：

```sql
CONSTRAINT fk_workspace_project_id_project_id_fk
  FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
```

如果 project 行在项目 DB 中不存在（尚未被 `Project.fromDirectory()` upsert），workspace 的插入会因为 FK 约束违反而抛出异常。但第 3 步 `adaptor.create()` 仍然执行，导致 **磁盘上的 worktree 存在，但 DB 中没有 workspace 记录**。

**对比 `Session.createNext()`**：session 创建流程（`session/index.ts:826-857`）在插入 session 之前，先确保 project 行存在：

```ts
// Session.createNext() 正确做法
if (!Database.hasProject(project.id)) {
  Database.attach(project.id)
}
Database.useProject(project.id, (d) =>
  d.insert(ProjectTable).values({ ... })
    .onConflictDoUpdate({ target: ProjectTable.id, set: { ... } })
    .run()
)
```

`Workspace.create()` 缺少这一步骤。

### 原因 2：`registerUntrackedProjects` Phase 2 删除 worktree 路径的 project_recent 条目

**代码位置**: `packages/opencode/src/storage/db.ts:688-700`

每次 Aether 启动时，`Database.Client` 初始化会调用 `registerUntrackedProjects()`（`db.ts:284`）。Phase 2 的逻辑：

```ts
// Phase 2: Delete project_recent entries whose directory is not the project's canonical worktree
const staleRows = sqlite
  .prepare("SELECT key, project_id FROM project_recent WHERE kind = 'project' AND project_id IS NOT NULL")
  .all()

for (const row of staleRows) {
  if (!existingDbIds.has(row.project_id) || !validWorktreeKeys.has(row.key)) {
    sqlite.prepare("DELETE FROM project_recent WHERE key = ?").run(row.key)
  }
}
```

`validWorktreeKeys` 的构建逻辑（`db.ts:677-680`）：

```ts
const wt = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid)
if (wt?.worktree && wt.worktree !== "/") validWorktreeKeys.add(`dir:${norm(wt.worktree)}`)
```

project 表中 `worktree` 字段指向的是 **主项目目录** `/Users/lx/Desktop/code/AI/Aether-dev/Aether`，而非 sandbox worktree 路径。因此 `validWorktreeKeys` 只包含 `dir:/users/lx/desktop/code/ai/aether-dev/aether`。

sandbox worktree 的 project_recent 条目 key 为 `dir:/users/lx/.local/share/aether/worktree/<projectId>/gentle-island`，不在 `validWorktreeKeys` 中，会被判定为 stale 并删除。

**效果**：即使 workspace 记录在 DB 中存在，其对应的 project_recent 条目也会被删除，导致 UI 不显示该工作区目录。用户重启后看不到之前创建的工作区。

### 原因 3：`OPENCODE_EXPERIMENTAL_WORKSPACES` 未开启导致无审计追踪

**代码位置**: `packages/opencode/src/flag/flag.ts:69`

```ts
export const OPENCODE_EXPERIMENTAL_WORKSPACES = OPENCODE_EXPERIMENTAL || truthy("OPENCODE_EXPERIMENTAL_WORKSPACES")
```

当此 flag 关闭时：

1. **workspace context 不设置**：`workspace-router-middleware.ts:40-42` 跳过 workspace 路由，`WorkspaceContext.workspaceID` 始终为空，session 的 `workspace_id` 字段不会被填充。
2. **event 不记录**：`sync/index.ts:120` 中，event 行不写入 `EventTable`，导致 event 和 event_sequence 表为空，无法追溯操作历史。
3. **session 使用 legacy Bus.publish**：`session/index.ts:868-875` 使用旧版 Bus 发布事件而非 SyncEvent 系统。

## 数据流分析

```
Workspace.create()
  │
  ├─ adaptor.configure() → 生成 workspace info
  │
  ├─ Database.useProject(projectID, db => db.insert(WorkspaceTable).values(...).run())
  │    │
  │    └─ Database.attach(projectID)
  │    │    └─ PRAGMA foreign_keys = ON
  │    │    └─ workspace.project_id FK → project.id
  │    │    └─ ⚠ 如果 project 行不存在：FK 约束违反，插入失败
  │    │
  │    └─ ❌ workspace 行未写入 DB
  │
  ├─ adaptor.create(config)
  │    └─ ✅ git worktree 物理创建成功（不受 DB 失败影响）
  │
  └─ return info（但 DB 中无对应行）

重启后：
  │
  ├─ Database.Client 初始化
  │    └─ registerUntrackedProjects(db)
  │         ├─ Phase 1: syncDirectoryMetaToGlobal → 添加 worktree 路径到 project_recent
  │         ├─ Phase 2: validWorktreeKeys 只含主项目路径 → 删除 worktree project_recent 条目
  │         ├─ Phase 3: project DB 文件存在 → 不删除 global_project_map 条目
  │
  ├─ Workspace.list(project) → workspace 表空 → 返回空列表
  │
  └─ UI 不显示任何 workspace
```

## 修复方案

### 修复 1：`Workspace.create()` 在插入 workspace 行前先 upsert project 行

**文件**: `packages/opencode/src/control-plane/workspace.ts:58-90`

在 `Database.useProject(input.projectID, ...)` 的回调中，先确保 project 行存在，再插入 workspace 行。与 `Session.createNext()` 的做法一致：

```ts
export const create = fn(CreateInput, async (input) => {
  const id = WorkspaceID.ascending(input.id)
  const adaptor = await getAdaptor(input.type)
  const config = await adaptor.configure({ ...input, id, name: null, directory: null })

  const info: Info = {
    id,
    type: config.type,
    branch: config.branch ?? null,
    name: config.name ?? null,
    directory: config.directory ?? null,
    extra: config.extra ?? null,
    projectID: input.projectID,
  }

  if (!Database.hasProject(input.projectID)) {
    Database.attach(input.projectID)
  }

  const project = Instance.project
  Database.useProject(input.projectID, (db) => {
    db.insert(ProjectTable)
      .values({
        id: project.id,
        worktree: project.worktree,
        vcs: project.vcs ?? null,
        name: project.name ?? null,
        icon_url: project.icon?.url ?? null,
        icon_color: project.icon?.color ?? null,
        time_created: project.time.created,
        time_updated: project.time.updated,
        time_initialized: project.time.initialized ?? null,
        sandboxes: project.sandboxes ?? [],
        commands: project.commands ?? null,
      })
      .onConflictDoUpdate({
        target: ProjectTable.id,
        set: {
          worktree: project.worktree,
          vcs: project.vcs ?? null,
          name: project.name ?? null,
          time_updated: project.time.updated,
          sandboxes: project.sandboxes ?? [],
          commands: project.commands ?? null,
        },
      })
      .run()

    db.insert(WorkspaceTable)
      .values({
        id: info.id,
        type: info.type,
        branch: info.branch,
        name: info.name,
        directory: info.directory,
        extra: info.extra,
        project_id: info.projectID,
      })
      .run()
  })

  await adaptor.create(config)
  return info
})
```

### 修复 2：`registerUntrackedProjects` Phase 2 保留 workspace worktree 路径的 project_recent 条目

**文件**: `packages/opencode/src/storage/db.ts:688-700`

当前 Phase 2 只将 project 的 canonical worktree 视为有效路径，忽略了 workspace 的 worktree 目录。需要在 Phase 1 阶段从每个项目 DB 的 workspace 表中读取 worktree 目录，将其也加入 `validWorktreeKeys`：

```ts
// Phase 1 中，读取 workspace 目录并加入 validWorktreeKeys
for (const pid of existingDbIds) {
  const fullPath = path.join(chDir, `aether-${pid}.db`)
  const pSqlite = new BunSqlite(fullPath)
  try {
    ensureDirectoryMeta(pSqlite, pid, recentLookup)
    syncDirectoryMetaToGlobal(sqlite, pSqlite, pid)

    const wt = pSqlite.prepare("SELECT worktree FROM project WHERE id = ?").get(pid) as { worktree: string } | undefined
    if (wt?.worktree && wt.worktree !== "/") validWorktreeKeys.add(`dir:${norm(wt.worktree)}`)

    // 新增：将 workspace 的 directory 也视为有效路径
    const workspaceRows = pSqlite.prepare("SELECT directory FROM workspace WHERE project_id = ?").all(pid) as {
      directory: string
    }[]
    for (const ws of workspaceRows) {
      if (ws.directory) validWorktreeKeys.add(`dir:${norm(ws.directory)}`)
    }

    synced++
  } finally {
    pSqlite.close()
  }
}
```

这样 Phase 2 在检查 `validWorktreeKeys.has(row.key)` 时，workspace 的 worktree 路径也会被认为是有效的，不会被误删。

### 修复 3（可选）：workspace FK 级联删除风险防护

workspace 表的 `project_id` FK 约束设置了 `ON DELETE CASCADE`。这意味着如果 project 行被删除（例如 `Project.remove()` 或 `Session.createNext()` 的 conflictDoUpdate 导致临时删除），所有 workspace 行会被级联删除。

虽然 `Session.createNext()` 使用 `onConflictDoUpdate` 是安全的（upsert 而非 delete+insert），但仍有潜在风险。建议审查所有可能删除 project 行的路径，确认不会触发意外的级联删除。

### 修复 4（建议）：split migration 增加 workspace 计数校验

**文件**: `packages/opencode/src/storage/split-migration.ts`

`verifySplit()`（第 353-379 行）目前只校验 session、message、part 的行数，**不校验 workspace 行数**。如果 split migration 丢失了 workspace 数据，不会被检测到。

建议在 `verifySplit()` 中增加 workspace 行数校验：

```ts
// 在 verifySplit() 中增加 workspace 校验
const srcWorkspaceCount = srcSqlite.prepare("SELECT count(*) as cnt FROM workspace").get() as { cnt: number }
const dstWorkspaceCount = Object.values(projectDbCounts).reduce((sum, c) => sum + c.workspaceCount, 0)
if (srcWorkspaceCount.cnt !== dstWorkspaceCount) {
  throw new Error(`workspace count mismatch: source=${srcWorkspaceCount.cnt}, destination=${dstWorkspaceCount}`)
}
```

## 影面范围

| 问题                              | 影响范围                                                                    | 严重程度                                                  |
| --------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| workspace 插入 FK 约束失败        | 所有通过 `Workspace.create()` 创建的 workspace（如果 project 行未预先存在） | **严重** — 数据永久丢失                                   |
| project_recent 误删 worktree 条目 | 所有 sandbox/worktree 类型的 workspace 目录                                 | **中等** — UI 不可见但 DB 数据仍在（前提是修复 1 解决后） |
| event 表无记录                    | 所有未开启 `OPENCODE_EXPERIMENTAL_WORKSPACES` 的实例                        | **低** — 影响可追溯性但不影响功能                         |
| split migration 不校验 workspace  | 迁移过程中可能丢失 workspace 数据                                           | **中等** — 迁移窗口内的数据丢失不可检测                   |

## 测试方案

1. **FK 约束测试**：在 workspace 插入前 project 行不存在时，验证 workspace 能正确创建（upsert project 行后插入 workspace 行）。
2. **project_recent 保留测试**：创建 sandbox worktree workspace 后重启 Aether，验证 project_recent 中 worktree 路径条目未被删除。
3. **workspace 数据持久化测试**：创建 workspace → 关闭 Aether → 重启 → 验证 workspace 表有对应行且 UI 可见。
4. **split migration workspace 校验测试**：在包含 workspace 数据的 DB 上执行 split migration，验证 workspace 行数匹配。
