# Skill 优先级与覆盖规则

同名 skill 以扫描位置决定胜出者：`loadSkills` 采用**后覆盖先（last wins）**策略，扫描越靠后的目录优先级越高。本文档描述完整的优先级顺序，以及演化系统新增路径在其中的位置。

---

## 目录

- [基础规则](#基础规则)
- [对旧文件的修改](#对旧文件的修改)
- [完整优先级表](#完整优先级表)
- [演化系统新增路径](#演化系统新增路径)
  - [Shadow 目录（用户显式演化）](#shadow-目录用户显式演化)
  - [skill-sessions 目录（AI 后台评审）](#skill-sessions-目录ai-后台评审)
- [关键文件速查](#关键文件速查)
- [实际效果示例](#实际效果示例)

---

## 基础规则

优先级遵循两条规则：

1. **project 级 > global 级**：project 内任意来源均覆盖 global 来源
2. **同一父目录内**：`.aether` > `.opencode` > `.claude` > `.agents`

> `directory` = session 的工作目录（CWD）；`worktree` = git 仓库根目录。通常两者相同，只在 session 于子目录打开时才出现多层。

---

## 对旧文件的修改

`skill/index.ts` 的 `loadSkills` 目前扫描顺序为：global EXTERNAL_DIRS → project Filesystem.up → Config.directories → skills.paths → skills.urls。skill-sessions 路径不在其中，需要在 global 扫描之后、project Filesystem.up 之前插入：

```
packages/opencode/src/skill/index.ts    ← 接入点
  └─ 在 global EXTERNAL_DIRS 扫描结束后、Filesystem.up 之前插入：
       const skillSessionsDir = path.join(
         Global.Path.home, ".aether", "skill-sessions", projectId, "skills"
       )
       if (await Filesystem.isDir(skillSessionsDir))
         await scan(state, skillSessionsDir, SKILL_PATTERN, { dot: true, scope: "project" })

  └─ project Filesystem.up 阶段改为先收集、再反转后扫描（使 inner 赢 outer）：
       const projectDirs: string[] = []
       for await (const root of Filesystem.up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })) {
         projectDirs.push(root)
       }
       for (const root of projectDirs.toReversed()) {
         await scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
       }
```

---

## 完整优先级表

目标优先级（低 → 高）：

| 优先级 | 来源 | scope |
|--------|------|-------|
| 1 | binary dir `.aether` / `.opencode`（内置默认） | global |
| 2 | `~/.config/aether/`（XDG） | global |
| 3 | `~/.agents` | global |
| 4 | `~/.claude` | global |
| 5 | `~/.opencode` | global |
| 6 | `~/.aether` | global |
| 7 | `~/.aether/skill-sessions/<project>/skills/`（AI 后台评审自动创建） | project（最低） |
| 8 | worktree `.agents` | project（outer） |
| 9 | worktree `.claude` | project（outer） |
| 10 | worktree `.opencode` | project（outer） |
| 11 | worktree `.aether` | project（outer） |
| … | … 中间各层（若 directory ≠ worktree）… | project |
| N-3 | `directory` `.agents` | project（inner） |
| N-2 | `directory` `.claude` | project（inner） |
| N-1 | `directory` `.opencode` | project（inner） |
| N | `directory` `.aether` | project（inner） |
| N+1 | `Config.directories()` 内置配置目录 | internal |
| N+2 | `skills.paths` 自定义路径 | custom |
| N+3 | `skills.urls` 远程路径 | remote |

---

## 演化系统新增路径

演化系统引入两类新路径，分别对应不同的写入场景，在优先级体系中各有其位置。

### Shadow 目录（用户显式演化）

Agent 演化 skill 时，所有写入都发生在与原始来源平行的 `.aether/skills/` 目录中（shadow 目录），原始文件丝毫不动。

**Shadow 目录的计算规则：**

在原始路径中找到第一个配置目录标记（`.claude`、`.agents`、`.opencode`、`.aether`），取其上级目录作为基准，然后在该基准目录下新建 `.aether/skills/<name>/` 路径。

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

**优先级保证：**

shadow 目录（`.aether/`）在优先级规则中拥有同父目录内最高类型优先级，shadow 版本天然覆盖所有来自 `.claude/`、`.agents/`、`.opencode/` 的同名 skill。一旦 Agent 演化了某个 skill，用户在 `.claude/skills/` 中的原始版本被"遮蔽"，但原始文件本身丝毫未动，可随时回查或通过 rollback 还原。

### skill-sessions 目录（AI 后台评审）

后台评审自动创建的 skill 写入专属目录，优先级低于所有用户手动放置的来源：

```
~/.aether/skill-sessions/<project>/skills/   ← AI 后台评审自动创建，仅对关联项目可见
```

此路径属于 project 级，但优先级低于 project 内所有用户手动放置或显式演化的同名 skill（对应完整优先级表中的优先级 7），防止后台评审结果意外覆盖用户预期行为。

**三类路径的优先级对比（低 → 高）：**

```
~/.aether/skill-sessions/<project>/skills/   ← AI 后台评审自动创建，优先级最低
<project>/.claude/skills/ 等                 ← 原始 skill 来源，只读
<project>/.aether/skills/                    ← 用户显式演化（shadow），优先级最高
```

---

## 关键文件速查

| 文件 | 职责 | 是否为新增文件 |
|------|------|:---:|
| `packages/opencode/src/skill/index.ts` | `loadSkills` 扫描顺序，新增 skill-sessions 路径插入点；project EXTERNAL 阶段改为收集后反转扫描（inner 赢 outer） | ⚠️ 仅接入 |
| `packages/opencode/src/skill-evolution/shadow-writer.ts` | 按优先级规则将演化写入 shadow 目录（`.aether/skills/`） | ✅ 新增 |
| `packages/opencode/src/skill-evolution/spawner.ts` | 确定 skill-sessions 路径（`~/.aether/skill-sessions/<project>/skills/`） | ✅ 新增 |

---

## 实际效果示例

```
~/.aether/skills/foo         被  /project/.claude/skills/foo  覆盖
→ project 级高于 global 级

/project/.claude/skills/foo  被  /project/.aether/skills/foo  覆盖
→ 同父目录内 .aether 优先（shadow 天然胜出原始来源）

worktree/.aether/skills/foo  被  directory/.agents/skills/foo  覆盖
→ 同类型 inner 层高于 outer 层

~/.aether/skill-sessions/<project>/skills/foo  被  /project/.agents/skills/foo  覆盖
→ AI 后台评审创建的 skill 优先级最低，任何用户来源均可覆盖它
```
