# Aether 当前对 Skills、Commands、Subagents、Rules 的支持、扫描路径与优先级

总体结论：

1. `skills`：支持用户自定义。
2. `commands`：支持用户自定义。
3. `subagents`：支持用户自定义。
4. `rules`：支持，但分两类：
   - 指令型规则：支持 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` 与 `instructions`
   - 通用 IDE 规则目录：不支持自动扫描 `.cursor/rules`、`.windsurf/rules.md`、`.github/copilot-instructions.md` 这类目录/文件作为运行时规则源

## 0. 前置概念：Instance.directory 与 Instance.worktree

文档后续多处引用两个运行时概念，它们由 `Instance` 模块（`packages/opencode/src/project/instance.ts`）在每次请求进入时确定，并绑定到当前请求的上下文中。所有扫描、缓存、配置查找都以它们为基准。

### Instance.directory

当前请求、会话或 CLI 命令所在的工作目录，是一个绝对路径。在服务端场景下，它来自 HTTP 请求的 `?directory=` 查询参数或 `x-opencode-directory` 请求头，经 `Filesystem.resolve()` 规范化。它不一定是项目根目录，可以是项目内的任意子目录。

### Instance.worktree

当前项目的工作区根目录。由 `ProjectIdentity.resolve()`（`packages/opencode/src/project/identity.ts`）从 `Instance.directory` 向上查找 `.git` 来确定，规则如下：

1. 找不到 `.git`：`worktree` 与 `directory` 相同，表示无 git 项目。
2. 找到 `.git` 是一个**目录**（普通 git 仓库）：`worktree` 就是 `.git` 所在目录，即仓库根目录。
3. 找到 `.git` 是一个**文件**（git worktree）：读取文件内容，解析 `gitdir:` 指向的实际 `.git` 位置，`worktree` 为该 `.git` 文件所在目录。

注意区分：`Project.Info.worktree`（主仓库根）与 `Instance.worktree`（`.git` 所在目录，即 sandbox）是两个不同字段。对普通 git 仓库两者相同；对 git worktree，`Instance.worktree` 是 worktree 检出目录，而 `Project.Info.worktree` 是主仓库目录。

### 举例

假设项目结构为：

```
/home/user/projects/my-app/        ← git 仓库根（有 .git/ 目录）
├── .git/
├── src/
│   └── components/
│       └── Button.tsx
└── packages/
    └── core/
```

| 场景 | `Instance.directory` | `Instance.worktree` |
|------|---------------------|---------------------|
| 在项目根目录打开 Aether | `/home/user/projects/my-app` | `/home/user/projects/my-app` |
| `cd src/components/` 后打开 | `/home/user/projects/my-app/src/components` | `/home/user/projects/my-app` |
| `cd packages/core/` 后打开 | `/home/user/projects/my-app/packages/core` | `/home/user/projects/my-app` |

git worktree 场景：

```
/home/user/projects/my-app/           ← 主仓库（.git/ 是目录）
├── .git/
└── ...

/home/user/projects/my-app-feature/   ← git worktree（.git 是文件）
├── .git                              ← 内容：gitdir: /home/user/projects/my-app/.git/worktrees/my-app-feature
└── src/
    └── ...
```

| 场景 | `Instance.directory` | `Instance.worktree` |
|------|---------------------|---------------------|
| 在 worktree 根目录打开 | `/home/user/projects/my-app-feature` | `/home/user/projects/my-app-feature` |
| `cd src/` 后打开 | `/home/user/projects/my-app-feature/src` | `/home/user/projects/my-app-feature` |

（此时 `Project.Info.worktree = "/home/user/projects/my-app"`，与 `Instance.worktree` 不同。）

无 git 项目：

```
/home/user/notes/                     ← 没有 .git
├── todo.md
└── ideas/
```

| 场景 | `Instance.directory` | `Instance.worktree` |
|------|---------------------|---------------------|
| 在此目录打开 Aether | `/home/user/notes` | `/home/user/notes` |

（此时 `Project.Info.worktree = "/"`，表示无 git 项目。）

### 对扫描的影响

Skills、Rules 等模块中频繁出现的 `Filesystem.up({ start: directory, stop: worktree })` 含义是：从用户当前所在目录向上一级级查找到项目根为止，逐级检查每层是否有目标目录或文件。这意味着：

- 如果用户在子目录工作，中间层级放置的配置或 skill 也能被发现。
- 如果用户就在项目根工作，则只扫描根目录一级。
- 扫描不会越过 `worktree` 向上到更外层的目录。

### 两点补充说明

#### `worktree` 语义差异：Instance vs Project

`worktree` 这个名字在两个上下文中指向不同的路径，容易混淆。

`ProjectIdentity.resolve()` 返回两个字段：`root`（主仓库根）和 `sandbox`（`.git` 所在目录）。它们被分别映射到：

| 源字段 | 目标 | 含义 |
|--------|------|------|
| `root` | `Project.Info.worktree` | 项目身份锚点，用于计算 Project ID |
| `sandbox` | `Instance.worktree` | 当前工作区根，用于扫描边界和缓存 key |

在普通 git 仓库中 `root === sandbox`，差异被掩盖；在 git worktree 中两者不同：

| 字段 | 普通 git 仓库 | git worktree |
|------|-------------|--------------|
| `Instance.worktree`（= sandbox） | `.git` 所在目录 = 仓库根 | `.git` 文件所在目录 = worktree 检出目录 |
| `Project.Info.worktree`（= root） | 同上 = 仓库根 | 主仓库目录 |

这导致两个重要后果：

1. **Project ID 与 DB 共享**：ID 由 `Hash.fast(norm(root))` 计算，即基于 `Project.Info.worktree`（主仓库根）。因此主仓库与其所有 worktree 共享同一个 Project ID 和同一个 per-project 数据库（`aether-{projectId}.db`）。
2. **扫描边界不同**：skill 等模块的 `Filesystem.up({ start: directory, stop: worktree })` 用的是 `Instance.worktree`（sandbox）。worktree 中扫描上界是 worktree 检出目录，不会向上越过到主仓库目录。

#### Project ID 的计算与 DB 命名

Project ID 由 `ProjectID.fromDirectory()`（`packages/opencode/src/project/schema.ts`）计算，流程为 `Hash.fast(norm(root))`，其中 `Hash.fast` 是 SHA-1，`norm` 做规范化（`path.resolve` + 反斜杠转正斜杠 + 去尾斜杠 + 全小写）。per-project 数据库文件名为 `aether-{projectId}.db`，存放在 channel 目录下。

`root` 的取值决定了哪些目录被视为同一项目：

| 场景 | `root` 的值 | 是否共享 DB |
|------|------------|------------|
| 同一普通 git 仓库的不同子目录 | 都是仓库根 | 共享 |
| 主仓库与其 git worktree | 都是主仓库根 | 共享 |
| 不同的 git 仓库 | 各自的仓库根 | 不共享 |
| 无 git 的不同目录 | 各自的 `directory`（没有向上聚合） | 不共享 |
| 无 git 的父子目录（如 `/home/user/notes` 与 `/home/user/notes/ideas`） | 各自的 `directory` | 不共享 |

最后一条需要特别注意：无 git 场景下，`root = path.resolve(directory)`，没有向上查找机制，因此两个不同目录即使有父子关系也是不同的项目。这与有 git 仓库时子目录向上聚合到仓库根的行为不同。

## 1. 统一配置装载顺序

许多自定义能力最终都依赖统一配置装载链。核心实现位于：

- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/config/paths.ts`

按代码中的实际优先级，配置源从低到高为：

1. 远端 `.well-known/opencode`
2. 全局配置目录 `Global.Path.config`（含 `aether.json`/`aether.jsonc` 与 `opencode.json`/`opencode.jsonc`）
3. `OPENCODE_CONFIG`
4. 项目内向上查找的 `aether.jsonc` / `aether.json` 与 `opencode.jsonc` / `opencode.json`
5. 各级 `.aether` / `.opencode` 目录与 `OPENCODE_CONFIG_DIR`
6. `OPENCODE_CONFIG_CONTENT`
7. 账号远端 `/api/config`
8. enterprise managed config 目录，最高优先级

需要特别注意三点：

1. `instructions` 与 `plugin` 不是简单覆盖，而是“拼接后去重”。
2. `.aether` / `.opencode` 目录列表由 `ConfigPaths.directories()` 生成，当前实现中包含五个来源：
   - 全局配置目录 `Global.Path.config`
   - 项目目录从近到远枚举的 `.aether` / `.opencode`（向上到 worktree）
   - home 目录下的 `.aether` / `.opencode`（只检查 home 本身一层）
   - binary 所在目录下的 `.aether` / `.opencode`（用于打包发行版）
   - `OPENCODE_CONFIG_DIR`（如果设置了）
   后加载覆盖先加载，因此更上层的目录会覆盖更下层的同名定义。
3. 在同一层级中，`Filesystem.up()` 的 `targets` 数组为 `[PROJECT, LEGACY_PROJECT]` 即 `[".aether", ".opencode"]`，`.opencode` 排在第二位、被 yield 在 `.aether` 之后，因此在装载链中位置稍后，同名定义时 `.opencode` 版拥有更高的覆盖权。

## 2. Skills

核心实现：

- `packages/opencode/src/skill/index.ts`
- `packages/opencode/src/skill/discovery.ts`

### 2.1 是否支持

支持用户自定义 skills。

### 2.2 扫描路径

`Skill.loadSkills()` 的实际扫描顺序如下。skill 的覆盖规则是“同名后加载覆盖先加载”，因此这里也是从低优先级到高优先级排列：

1. 全局外部 skills
   - 依次扫描 `Global.Path.home` 下的：
   - `~/.agents/skills/**/SKILL.md`
   - `~/.claude/skills/**/SKILL.md`
   - `~/.opencode/skills/**/SKILL.md`
   - `~/.aether/skills/**/SKILL.md`
   - 同名时，上述顺序中越靠后的目录优先级越高，即全局 `.aether` 覆盖全局 `.opencode`，再覆盖全局 `.claude` / `.agents`。
2. 项目隔离的 skill-sessions
   - `~/.aether/skill-sessions/<projectId>/skills/**/SKILL.md`
   - 这是 AI 后台评审/自进化相关的项目级落盘位置。
   - 它晚于全局外部 skills、早于项目目录 skills，因此可覆盖全局同名 skill，但会被任何项目内用户来源覆盖。
3. 项目内外部 skills
   - 从当前 `Instance.directory` 向上到 `Instance.worktree` 查找以下目录：
   - `.agents/skills/**/SKILL.md`
   - `.claude/skills/**/SKILL.md`
   - `.opencode/skills/**/SKILL.md`
   - `.aether/skills/**/SKILL.md`
   - 实现细节是先用 `Filesystem.up()` 从内到外收集，再 `toReversed()` 后扫描。因此在这一阶段中，外层目录先扫、内层目录后扫，内层同名 skill 会覆盖外层；同一层级内的类型优先级为 `.agents < .claude < .opencode < .aether`。
4. 配置目录内的 skills
   - 对每个 `Config.directories()` 根目录扫描：
   - `{skill,skills}/**/SKILL.md`
   - 典型路径包括：
     - `Global.Path.config/{skill,skills}/**/SKILL.md`：用户全局配置目录下的 `skill/` 或 `skills/`，通常是 `~/.config/aether/{skill,skills}`，也可能是 legacy 的全局 opencode 配置目录。
     - `<某级>.aether/{skill,skills}/**/SKILL.md`：从当前 `Instance.directory` 向上到 `Instance.worktree` 途中发现的某一级项目配置目录，例如 `<project>/.aether/skills/foo/SKILL.md` 或 `<project>/subdir/.aether/skill/foo/SKILL.md`。
     - `<某级>.opencode/{skill,skills}/**/SKILL.md`：同上，但使用 legacy 项目配置目录 `.opencode`。
     - `<binaryDir>/.aether/{skill,skills}/**/SKILL.md`：Aether 可执行文件所在目录旁边的 `.aether/skill` 或 `.aether/skills`，用于打包发行版随 binary 携带默认配置/skills。
     - `<binaryDir>/.opencode/{skill,skills}/**/SKILL.md`：同上，但使用 legacy binary 旁 `.opencode` 目录。
     - `<OPENCODE_CONFIG_DIR>/{skill,skills}/**/SKILL.md`：环境变量 `OPENCODE_CONFIG_DIR` 指向的自定义配置目录下的 `skill/` 或 `skills/`。
   - 这些配置目录本身的扫描顺序也是低到高：
     1. `Global.Path.config`
     2. 项目路径从当前 `Instance.directory` 向上到 `Instance.worktree` 途中发现的 `.aether` / `.opencode`
     3. `Global.Path.home` 下的 `.aether` / `.opencode`
     4. `<binaryDir>` 下的 `.aether` / `.opencode`
     5. `OPENCODE_CONFIG_DIR`
   - 若 `OPENCODE_DISABLE_PROJECT_CONFIG=true`，第 2 段项目路径配置目录不会加入；若未设置 `OPENCODE_CONFIG_DIR`，第 5 段不存在。
   - 项目路径这一段要特别注意：`Filesystem.up()` 从当前目录开始向父目录枚举，且同一级按 `.aether` 再 `.opencode` 的顺序 yield；`Skill.loadSkills()` 在配置目录阶段不反转这个列表。因此同名 skill 在这一阶段的覆盖方向是：
     - 更靠近 `Instance.worktree` 的外层项目配置目录覆盖更靠近 `Instance.directory` 的内层项目配置目录。
     - 同一目录层级中，`.opencode` 覆盖 `.aether`。
   - 但对 skills 来说，`Global.Path.home` 下的 `.aether` / `.opencode` 会被下面的例外跳过，所以它们不会在这个配置目录阶段获得覆盖权；全局 home 外部 skills 已在第 1 阶段按 `.agents < .claude < .opencode < .aether` 处理。
   - 这里有一个重要例外：`~/.agents`、`~/.claude`、`~/.opencode`、`~/.aether` 这四个 home 外部目录会在此阶段被跳过，避免它们借助较晚的 `Config.directories()` 扫描覆盖项目级 skill。因此 `~/.aether/skills/**/SKILL.md` 和 `~/.opencode/skills/**/SKILL.md` 来自第 1 阶段，而不是此阶段；`~/.aether/skill/**/SKILL.md` 和 `~/.opencode/skill/**/SKILL.md` 当前不会被扫描。
5. `config.skills.paths`
   - 指配置文件中的 `skills.paths` 数组，例如 `aether.jsonc` / `opencode.jsonc` 里可以写：
     ```jsonc
     {
       "skills": {
         "paths": ["./my-skills", "~/shared-skills", "/absolute/path/to/skills"]
       }
     }
     ```
   - 对每个配置项解析出目录后扫描 `**/SKILL.md`。
   - `~/` 会按 `os.homedir()` 展开。
   - 绝对路径直接使用。
   - 相对路径相对于当前 `Instance.directory`，不是相对于配置文件所在目录。
   - 不存在的目录只记录 warn，不中断加载。
6. `config.skills.urls`
   - 对每个 URL 拉取远端 `index.json`。
   - `index.json` 中每个 skill 必须声明包含 `SKILL.md` 的 `files` 列表，否则跳过。
   - 文件下载到 `Global.Path.cache/skills/<skill-name>/`，再对该缓存目录扫描 `**/SKILL.md`。
   - 下载时如果目标文件已存在会直接复用，不会覆盖本地缓存文件。
7. `config.skills.disabled`
   - 所有来源加载结束后，按 skill 名删除。
   - 这是最终关闭层，不是扫描源。

注意：第 3 阶段已经会扫描项目内 `.aether/skills` / `.opencode/skills`，第 4 阶段又会通过 `Config.directories()` 扫描项目内 `.aether/{skill,skills}` / `.opencode/{skill,skills}`。同一个 `SKILL.md` 可能被命中两次；最终仍然遵循“后加载覆盖先加载”。

⚠ 警示：项目路径上的 `.aether/skills/**/SKILL.md` 与 `.opencode/skills/**/SKILL.md` 会被重复扫描和重复加载。对从当前 `Instance.directory` 向上到 `Instance.worktree` 的每一级目录 `D`，以下路径既会在第 3 阶段作为项目内外部 skills 被扫描，也会在第 4 阶段作为配置目录内 skills 被扫描，而且第 4 阶段不会跳过它们：

```text
D/.aether/skills/**/SKILL.md
D/.opencode/skills/**/SKILL.md
```

必须特别强调：重复进入第 4 阶段后，同一目录层级里的 `.aether/skills` 会先扫，`.opencode/skills` 会后扫；因此同名 skill 的最终结果是 `.opencode` 覆盖 `.aether`。

这些相似路径不会重复：

```text
D/.agents/skills/**/SKILL.md     # 只在第 3 阶段扫描
D/.claude/skills/**/SKILL.md     # 只在第 3 阶段扫描
D/.aether/skill/**/SKILL.md      # 只在第 4 阶段扫描
D/.opencode/skill/**/SKILL.md    # 只在第 4 阶段扫描
```

全局 home 下的 `~/.aether/skills/**/SKILL.md` 和 `~/.opencode/skills/**/SKILL.md` 也不会在第 4 阶段重复，因为 `Skill.loadSkills()` 会跳过 `Global.Path.home` 下的 `.agents` / `.claude` / `.opencode` / `.aether`。如果设置 `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`，第 3 阶段不执行，重复消失；如果设置 `OPENCODE_DISABLE_PROJECT_CONFIG=true`，第 4 阶段的项目配置目录不加入，重复也消失。

### 2.3 覆盖规则

1. skill 以 frontmatter 的 `name` 为主键，不以目录名或文件名为主键。
2. 只有 frontmatter 至少满足 `name: string` 和 `description: string` 的 `SKILL.md` 才会登记为有效 skill。
3. 同名 skill 后发现者覆盖先前 skill；覆盖时只保留后一条的 `name`、`description`、`location`、`content`。
4. 被成功登记的 skill 目录会写入 `state.dirs`，供 agent 默认权限把 skill 附带资源目录加入可读白名单。
5. `skills.disabled` 在最后执行，因此拥有最终关闭权。
6. `Skill.available(agent)` 还会按 agent 的 `permission.skill` 做二次过滤；这只影响某个 agent 可见/可用的列表，不改变全局扫描结果。

按当前代码，可以把主要覆盖层理解为：

1. 全局 home 外部目录：`.agents < .claude < .opencode < .aether`。
2. skill-sessions：覆盖全局 home 外部目录，但低于项目目录。
3. 项目外部阶段：外层 < 内层；同层 `.agents < .claude < .opencode < .aether`。
4. 配置目录阶段：按 `Config.directories()` 返回顺序加载；同层 `.aether` 先于 `.opencode`，所以同层 `.opencode` 在此阶段覆盖 `.aether`。项目内 `.aether/.opencode` 的 `skills/` 会在这一阶段再次参与覆盖。
5. `skills.paths`：覆盖前面所有本地发现来源。
6. `skills.urls`：覆盖 `skills.paths` 及前面所有来源。
7. `skills.disabled`：按名称最终删除。

### 2.4 禁用开关

若启用 `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`，`Skill.loadSkills()` 中的外部阶段整体失效，具体包括：

1. 全局 home 外部目录 `~/.agents/skills`、`~/.claude/skills`、`~/.opencode/skills`、`~/.aether/skills`。
2. `~/.aether/skill-sessions/<projectId>/skills`。
3. 从当前目录向上查找的项目内 `.agents/skills`、`.claude/skills`、`.opencode/skills`、`.aether/skills` 外部阶段扫描。

但这个开关不会关闭后续的 `Config.directories()`、`skills.paths`、`skills.urls`。因此项目内 `.aether/{skill,skills}` / `.opencode/{skill,skills}` 仍可能通过配置目录阶段被扫描；若要连项目配置目录也关闭，需要另看 `OPENCODE_DISABLE_PROJECT_CONFIG` 对 `Config.directories()` 的影响。

需要注意级联关系：`OPENCODE_DISABLE_CLAUDE_CODE` 是总开关，为 true 时会隐式激活 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`，进而隐式激活 `OPENCODE_DISABLE_EXTERNAL_SKILLS`，所以设置 `OPENCODE_DISABLE_CLAUDE_CODE=true` 也等同于关闭上述外部 skills 阶段。

### 2.5 运行时缓存与变更感知

skills 使用 `InstanceState` 按当前 `Instance.directory` 缓存。首次调用 `Skill.get()`、`Skill.all()`、`Skill.dirs()` 或 `Skill.available()` 时会执行 `loadSkills()`；之后再次访问前，会先用 mtime snapshot 检查磁盘状态。

当前实现的缓存校验链路是：

1. `loadSkills()` 完成扫描、覆盖和禁用处理后，调用 `buildManifest()`。
2. `buildManifest()` 复用 `scanAllSkillPaths()`，收集除 `skills.urls` 之外的所有本地扫描来源中的 `SKILL.md` 路径，并记录 `mtimeMs`。
3. snapshot 写入 `~/.aether/skill-snapshots/<directory-slug>.json`。
4. 下次访问 skill state 前，`isFresh()` 先读取 snapshot。
5. snapshot 中已有路径被删除或 mtime 改变时，判定不 fresh。
6. 重新扫描本地路径时发现新增 `SKILL.md` 不在 snapshot 中，也判定不 fresh。
7. 不 fresh 时先 `InstanceState.invalidate()`，随后重新执行 `loadSkills()`。

这意味着手动新增、删除或修改本地扫描路径里的 `SKILL.md`，会在下一次访问 skills 时触发重新扫描，不需要重启进程。`skills.urls` 不参与 `scanAllSkillPaths()`，因此远端源变化和 `Global.Path.cache/skills/<name>` 下的缓存文件变化都不会触发 mtime snapshot 重扫；已登记的 URL skill 若通过内置 `skill` 工具执行，正文仍会按缓存中的 `location` 重新读取。

### 2.6 使用入口

被扫描到的 skill 会进入多个运行时入口：

1. `SystemPrompt.skills(agent)` 调用 `Skill.available(agent)`，把可用 skill 的 `name`、`description`、`location` 写入系统提示。
2. `SkillTool` 初始化工具描述时调用 `Skill.available(agent)`，让模型知道可以加载哪些 skill。
3. agent 默认权限初始化会调用 `Skill.dirs()`，把已发现 skill 目录下的资源文件加入 `external_directory` allow 列表。
4. command 层会遍历 `Skill.all()`，把未被已有 command 占用的 skill 名注册为同名 slash command。

内置 `skill` 工具执行时会先用 `Skill.get(name)` 找到缓存记录，再重新解析该 `location` 指向的 `SKILL.md` 正文；如果重新解析失败，则回退到扫描时缓存的旧 `content`。skill-as-command 不走 `SkillTool.execute()`，它使用 command state 初始化时捕获的 `skill.content`。

## 3. Commands

核心实现：

- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/command/index.ts`

### 3.1 是否支持

支持用户自定义 commands。

### 3.2 来源与扫描路径

commands 实际来自四类来源：

1. 内建命令
   - `init`
   - `review`
2. 配置对象 `config.command`
3. markdown 命令文件
   - 对每个 `Config.directories()` 根目录扫描：
   - `{command,commands}/**/*.md`
   - 典型路径如：
     - `~/.config/aether/command/**/*.md`
     - `~/.config/aether/commands/**/*.md`
     - `~/.config/opencode/command/**/*.md`
     - `~/.config/opencode/commands/**/*.md`
     - `<某级>.aether/command/**/*.md`
     - `<某级>.aether/commands/**/*.md`
     - `<某级>.opencode/command/**/*.md`
     - `<某级>.opencode/commands/**/*.md`
     - `<OPENCODE_CONFIG_DIR>/command/**/*.md`
     - `<OPENCODE_CONFIG_DIR>/commands/**/*.md`
     - `~/.aether/commands/**/*.md`
     - `~/.opencode/commands/**/*.md`
4. skill 名自动暴露为 command

### 3.3 命名规则

1. 文件扩展名去掉。
2. 保留相对嵌套路径。
3. 例如 `nested/child.md` -> `nested/child`。

### 3.4 覆盖规则

按运行时装配顺序：

1. 内建 `init` / `review`
2. `config.command`
3. MCP prompt
4. skill-as-command

因此：

1. `config.command` 可覆盖内建同名命令。
2. MCP prompt 可覆盖前面已有同名命令。
3. skill 只能在该名称尚未被占用时注册，不能覆盖前面任一来源。

### 3.5 双名并行与覆盖

markdown 命令文件在 `loadCommand()` 中通过 patterns 列表提取相对路径名，该列表同时包含 `/.aether/command/` 和 `/.opencode/command/` 的路径模式。这意味着 `.aether/commands/foo.md` 和 `.opencode/commands/foo.md` 都会被注册为同名 command `foo`。由于 `directories` 列表中同一层级 `.opencode` 在 `.aether` 之后被 yield，同层级同名命令 `.opencode` 版拥有更高的覆盖权。

## 4. Subagents

核心实现：

- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/agent/agent.ts`

### 4.1 是否支持

支持用户自定义 subagents。

### 4.2 来源与扫描路径

来源有两种：

1. `config.agent.<name>`
   - 当其 `mode: "subagent"` 时，作为自定义 subagent
2. markdown agent 文件
   - 对每个 `Config.directories()` 根目录扫描：
   - `{agent,agents}/**/*.md`
   - 典型路径如：
     - `~/.config/aether/agent/**/*.md`
     - `~/.config/aether/agents/**/*.md`
     - `~/.config/opencode/agent/**/*.md`
     - `~/.config/opencode/agents/**/*.md`
     - `<某级>.aether/agent/**/*.md`
     - `<某级>.aether/agents/**/*.md`
     - `<某级>.opencode/agent/**/*.md`
     - `<某级>.opencode/agents/**/*.md`
     - `<OPENCODE_CONFIG_DIR>/agent/**/*.md`
     - `<OPENCODE_CONFIG_DIR>/agents/**/*.md`
     - `~/.aether/agents/**/*.md`
     - `~/.opencode/agents/**/*.md`

此外还有：

1. `{mode,modes}/*.md`
2. 但它们被强制视作 `primary`，不能真正定义 subagent

### 4.3 覆盖规则

1. 先创建内建 agents：
   - `build`
   - `plan`
   - `general`
   - `explore`
   - `compaction`
   - `title`
   - `summary`
2. 再遍历 `cfg.agent`
3. 同名时对现有 agent 逐字段覆盖
4. 不存在时新建 agent
5. 若 `disable: true`，则删除该 agent

### 4.4 与 default agent 的关系

1. `default_agent` 不能指向 `mode: "subagent"` 的 agent。
2. 也不能指向 `hidden: true` 的 agent。

### 4.5 双名并行与覆盖

与 commands 同理，markdown agent 文件也通过 patterns 列表提取相对路径名，列表同时包含 `/.aether/agent/` 和 `/.opencode/agent/` 模式。同一层级同名 agent，`.opencode` 版在装载顺序上稍后，拥有更高的逐字段覆盖权。

## 5. Rules

这里必须区分两种含义。

### 5.1 指令型 rules

核心实现：

- `packages/opencode/src/session/instruction.ts`

#### 5.1.1 系统级规则文件

项目内固定只认三种文件名：

1. `AGENTS.md`
2. `CLAUDE.md`
3. `CONTEXT.md`

扫描方式：

1. 从当前目录向上到 `worktree` 查找。
2. 文件类型优先级为：
   - `AGENTS.md`
   - `CLAUDE.md`
   - `CONTEXT.md`
3. 一旦某一类文件找到至少一个，就停止继续尝试后续文件类型。

因此：

1. 只要链路上存在任何 `AGENTS.md`，则 `CLAUDE.md` 与 `CONTEXT.md` 整体不会进入 system rules。
2. 对同一文件类型，会把从当前目录到根目录的所有匹配都加入。

#### 5.1.2 全局规则文件

优先级如下：

1. `OPENCODE_CONFIG_DIR/AGENTS.md`
2. `Global.Path.config/AGENTS.md`（当前实际路径为 `~/.config/aether/` 或 `~/.config/opencode/`）
3. `~/.claude/CLAUDE.md`

只取第一个存在的。

注意：如果 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` 或 `OPENCODE_DISABLE_CLAUDE_CODE` 为 true，则第3项 `~/.claude/CLAUDE.md` 不会被加入候选列表，相当于完全排除该来源。

#### 5.1.3 `config.instructions`

支持三类输入：

1. 相对路径
2. 绝对路径
3. HTTP(S) URL

相对路径解析规则：

1. 若未禁用 project config，则以 `globUp()` 从当前目录向上到 `worktree` 解析。
2. 若禁用了 project config，则仅在 `OPENCODE_CONFIG_DIR` 中解析。
3. 若同时禁用了 project config 且不存在 `OPENCODE_CONFIG_DIR`，则相对路径 instruction 被跳过。

合并规则：

1. `instructions` 为数组拼接去重，不是后者整体覆盖前者。

注意：配置文件本身现在优先查找 `aether.jsonc` / `aether.json`，但也会同时查找 `opencode.jsonc` / `opencode.json`（legacy）。instructions 字段的来源因此可能来自任一命名的配置文件。

#### 5.1.4 读取文件时的局部 rules 注入

当 agent 使用 `read` 工具读文件时，还会触发额外目录级规则解析：

1. 从目标文件所在目录一路向上到项目根。
2. 逐级寻找 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`。
3. 若该规则文件不属于系统级 rules、也未被读过、也未在当前 message 中声明过，则作为额外 reminder 注入。

这意味着规则不是只在会话初始化时生效一次；读文件时也会触发目录级规则继承。

### 5.2 通用 IDE 规则目录

当前实现不自动把以下来源作为运行时规则源：

1. `.cursor/rules/`
2. `.cursorrules`
3. `.windsurf/rules.md`
4. `.github/copilot-instructions.md`

这些内容只在内建 `/init` 模板中被提到，目的是提醒生成 `AGENTS.md` 时一并纳入，而不是运行时自动加载。

相关文件：

- `packages/opencode/src/command/template/initialize.txt`

### 5.3 如果把 permission 也视为 rules

也支持，但它是“配置型规则”，不是独立文件扫描系统。

来源：

1. 顶层 `config.permission`
2. agent 级 `config.agent.<name>.permission`
3. `OPENCODE_PERMISSION` 环境变量

规则求值要点：

1. 字符串规则会展开成 `pattern: "*"`
2. `~/` 与 `$HOME` 会被展开
3. 实际求值采用 `findLast()`，也就是最后匹配生效

## 6. 总结：四类能力支持情况

| 能力 | 是否支持用户自定义 | 主扫描/来源方式 | 覆盖规则 |
| --- | --- | --- | --- |
| skills | 支持 | home/project 外部目录 + skill-sessions + config roots `{skill,skills}` + `skills.paths` + `skills.urls` | 同名后加载覆盖先加载；`skills.disabled` 最终删除；本地 `SKILL.md` 变更由 mtime snapshot 触发重扫 |
| commands | 支持 | `config.command` + `.aether` / `.opencode/{command,commands}` + MCP + skill-as-command | 内建 < config.command < MCP；skill 只能补位不能覆盖 |
| subagents | 支持 | `config.agent` + `.aether` / `.opencode/{agent,agents}` | 内建 agents 先建，`config.agent` 后覆盖；`disable: true` 可删除 |
| rules | 支持部分形式 | `AGENTS/CLAUDE/CONTEXT` + `instructions` + permission config | 指令文件按固定顺序装载；permission 采用最后匹配生效 |

## 7. 兼容性补充：Skills、Commands、Subagents 与 Rules

下面补充回答一个很容易混淆的问题：四类能力对 `.aether` / `.opencode`、`.claude`、`.agents`、固定文件名协议、IDE rules 目录等外部生态，到底分别兼容到什么程度。

结论先行：

1. `skills`：兼容最广，显式支持 `.agents` / `.claude` / `.opencode` / `.aether` 外部 skills、skill-sessions、config roots、额外路径、远端 URL。
2. `commands`：不兼容 `.claude` / `.agents` 外部 command 目录，只走统一 config roots（含 `.aether` / `.opencode`）、`config.command`、MCP 与 skill-as-command。
3. `subagents`：没有 `.claude` / `.agents` 外部目录兼容，只走统一 config roots（含 `.aether` / `.opencode`）与 `config.agent`。
4. `rules`：属于“部分兼容”。
   - 项目内兼容固定文件名 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`
   - 全局兼容 `~/.claude/CLAUDE.md`
   - 不兼容 `.agents` 规则文件
   - 不兼容 `.cursor/rules`、`.windsurf/rules.md`、`.github/copilot-instructions.md` 这类 IDE 规则目录作为运行时自动来源

### 7.1 Skills 兼容矩阵

| 来源/生态 | 是否支持 | 实际扫描/接入方式 | 优先级/覆盖判定 | 备注 |
| --- | --- | --- | --- | --- |
| `~/.agents/skills/**/SKILL.md` | 支持 | `Skill.loadSkills()` 显式扫描全局 home 外部目录 `.agents` | 全局外部目录最低层；同名可被后续全局 `.claude/.opencode/.aether` 覆盖 | 可被 `OPENCODE_DISABLE_EXTERNAL_SKILLS` 或 `OPENCODE_DISABLE_CLAUDE_CODE` 整体关闭 |
| `~/.claude/skills/**/SKILL.md` | 支持 | `Skill.loadSkills()` 显式扫描全局 home 外部目录 `.claude` | 高于全局 `.agents`，低于全局 `.opencode/.aether` | 同上 |
| `~/.opencode/skills/**/SKILL.md` | 支持 | `Skill.loadSkills()` 显式扫描全局 home 外部目录 `.opencode` | 高于全局 `.agents/.claude`，低于全局 `.aether` | 这里是外部阶段扫描的 `skills/`，不是 `Config.directories()` 的 `{skill,skills}` |
| `~/.aether/skills/**/SKILL.md` | 支持 | `Skill.loadSkills()` 显式扫描全局 home 外部目录 `.aether` | 全局 home 外部目录中最高 | 同上 |
| `~/.aether/skill-sessions/<projectId>/skills/**/SKILL.md` | 支持 | `Skill.loadSkills()` 在全局外部目录之后扫描当前项目 ID 对应目录 | 覆盖全局 home 外部 skill，低于项目内用户 skill | AI 后台评审/自进化的项目隔离目录；也受 external skills 开关影响 |
| 项目内 `.agents/skills/**/SKILL.md` | 支持 | 从当前 `Instance.directory` 向上到 `Instance.worktree` 收集后反向扫描 | 项目外部阶段中同层最低；内层覆盖外层 | 这是显式目录兼容，不是偶然命中 |
| 项目内 `.claude/skills/**/SKILL.md` | 支持 | 同上 | 高于同层 `.agents`，低于同层 `.opencode/.aether` | 同上 |
| 项目内 `.opencode/skills/**/SKILL.md` | 支持 | 外部阶段扫描 `skills/**/SKILL.md`；随后还可能被 config roots 阶段再次扫描 | 项目外部阶段中高于 `.agents/.claude`，低于 `.aether`；config roots 阶段还会参与后续覆盖 | legacy 目录名 |
| 项目内 `.aether/skills/**/SKILL.md` | 支持 | 外部阶段扫描 `skills/**/SKILL.md`；随后还可能被 config roots 阶段再次扫描 | 项目外部阶段同层最高；config roots 阶段仍按 `Config.directories()` 顺序参与覆盖 | 新品牌目录名 |
| `.aether/skill/**/*.md` | 不支持 | 无此模式 | 不参与 | skills 只认 `SKILL.md` 文件名，不认任意 markdown |
| `.aether/skill/**/SKILL.md` | 支持 | 对每个 `Config.directories()` 根目录扫描 `{skill,skills}/**/SKILL.md` | 晚于外部 skills，故可覆盖前面同名 skill；同层级 `.aether` 在 `.opencode` 之前 yield，同名时 `.opencode` 覆盖权更高 | 新品牌目录名 |
| `.aether/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `.opencode/skill/**/*.md` | 不支持 | 无此模式 | 不参与 | skills 只认 `SKILL.md` 文件名，不认任意 markdown |
| `.opencode/skill/**/SKILL.md` | 支持 | 同上扫描方式 | 晚于外部 skills；同层级 `.opencode` 在 `.aether` 之后 yield，覆盖权更高 | legacy 目录名 |
| `.opencode/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `~/.aether/skill/**/SKILL.md` | 不支持 | home 外部 `.aether` 会在 config roots 阶段被跳过 | 不参与 | 当前 home `.aether` 只通过外部阶段扫描 `skills/` |
| `~/.opencode/skill/**/SKILL.md` | 不支持 | home 外部 `.opencode` 会在 config roots 阶段被跳过 | 不参与 | 当前 home `.opencode` 只通过外部阶段扫描 `skills/` |
| `Global.Path.config/{skill,skills}/**/SKILL.md` | 支持 | `Global.Path.config` 是 `Config.directories()` 的第一项 | config roots 阶段中较低；会被后续项目、binary、`OPENCODE_CONFIG_DIR` 同名 skill 覆盖 | 典型为 `~/.config/aether/{skill,skills}` 或 legacy config 路径 |
| `<binaryDir>/.aether/{skill,skills}/**/SKILL.md` | 支持 | binary 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于 home 目录之后 | 打包发行版专用 |
| `<binaryDir>/.opencode/{skill,skills}/**/SKILL.md` | 支持 | 同上 | 同上 | legacy 打包发行版 |
| `<OPENCODE_CONFIG_DIR>/{skill,skills}/**/SKILL.md` | 支持 | `OPENCODE_CONFIG_DIR` 属于 `Config.directories()` 的最后一项 | 在 config roots 阶段最高 | 不受 external skills 开关影响 |
| `config.skills.paths` | 支持 | 每个目录递归扫描 `**/SKILL.md` | 晚于所有内建本地扫描来源 | `~/` 展开到 `os.homedir()`；相对路径相对当前 `Instance.directory` |
| `config.skills.urls` | 支持 | 拉取远端索引到缓存目录后再扫描 `**/SKILL.md` | 晚于本地路径；同名继续后发现覆盖 | 属于当前四类能力里唯一内建远端发现；已存在的缓存文件不会被覆盖下载 |
| `config.skills.disabled` | 支持 | 在 skills 全部装载完成后按名字删除 | 拥有最终关闭权 | 优先级高于前面所有来源 |
| skill 自动暴露为 command | 支持，但属于 command 侧行为 | skill 装好后，命令层再把 skill 注册成同名 command | 不改变 skill 本身覆盖规则 | 这是跨能力映射，不是 skill 发现来源 |

补充说明：

1. `skills` 是四类能力里兼容最丰富的一类，既支持外部生态目录，也支持 `.aether` / `.opencode`、skill-sessions、本地附加路径和远端 URL。
2. skill 的主键是 frontmatter 的 `name`，不是目录名，也不是文件夹名。
3. `SKILL.md` 正文会同时作为 skill content 保留；后续若被自动暴露为 command，则正文会变成该 command 的模板。
4. 上表只说明“哪些路径会在扫描时被纳入候选”。运行中非 URL 本地来源的 `SKILL.md` 新增、删除、修改会通过 2.5 描述的 mtime snapshot 在下一次访问 skills 时触发重扫；远端 URL 源和下载缓存不会因此重新拉取或重扫。

### 7.2 Commands 兼容矩阵

| 来源/生态 | 是否支持 | 实际扫描/接入方式 | 优先级/覆盖判定 | 备注 |
| --- | --- | --- | --- | --- |
| 内建 `init` / `review` | 支持 | `Command.state` 启动时先注册 | 最低基础层 | 其中 `review` 默认 `subtask: true` |
| `config.command` | 支持 | 统一配置装载后，`Command.state` 遍历 `cfg.command` | 可覆盖内建同名 command | 属于显式配置，不依赖 markdown 文件 |
| `.aether/command/**/*.md` | 支持 | `loadCommand()` 对每个 `Config.directories()` 根目录扫描 `{command,commands}/**/*.md` | 先合并进 `cfg.command`；同层级 `.aether` 在 `.opencode` 之前 yield，同名时 `.opencode` 覆盖权更高 | 新品牌目录名 |
| `.aether/commands/**/*.md` | 支持 | 同上 | 同上 | 与 `command/` 等价 |
| `.opencode/command/**/*.md` | 支持 | 同上扫描方式 | 先合并进 `cfg.command`；同层级 `.opencode` 覆盖权高于 `.aether` | legacy 目录名 |
| `.opencode/commands/**/*.md` | 支持 | 同上 | 同上 | 与 `command/` 等价 |
| `~/.aether/commands/**/*.md` | 支持 | home 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于项目级之后 | home 目录扫描 |
| `~/.opencode/commands/**/*.md` | 支持 | home 目录下的 `.opencode` 属于 `Config.directories()` 的一员 | 同上 | legacy home 目录 |
| `<binaryDir>/.aether/commands/**/*.md` | 支持 | binary 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于 home 目录之后 | 打包发行版专用 |
| `<binaryDir>/.opencode/commands/**/*.md` | 支持 | 同上 | 同上 | legacy 打包发行版 |
| `OPENCODE_CONFIG_DIR/command(s)` | 支持 | 属于 `Config.directories()` 一部分 | 与其它 config roots 一起参与统一 merge | 没有单独的外部兼容语义 |
| `.claude/commands/**` | 不支持 | 无扫描逻辑 | 不参与 | 当前没有 Claude Code 风格 command 目录兼容 |
| `.agents/commands/**` | 不支持 | 无扫描逻辑 | 不参与 | 与 skills 不同，commands 没有 `.agents` 外部目录兼容 |
| MCP prompts | 支持 | `Command.state` 读取 `MCP.prompts()` 并注册为 command | 可覆盖内建与 `config.command` 同名项 | source 为 `mcp` |
| skill-as-command | 支持 | `Command.state` 最后遍历 `Skill.all()`，将 skill 注册成同名 command | 只能补位；若同名 command 已存在则跳过 | source 为 `skill`，template 为 `skill.content` |

补充说明：

1. `commands` 不存在类似 `skills` 的外部 `.claude` / `.agents` 目录兼容。
2. markdown command 文件只是 `cfg.command` 的一种来源；真正运行时命令表还会再叠加内建、MCP 和 skill-as-command。
3. `command` 这里是会话层 prompt command，不是 CLI 子命令，也不是 shell command。

### 7.3 Subagents 兼容矩阵

| 来源/生态 | 是否支持 | 实际扫描/接入方式 | 优先级/覆盖判定 | 备注 |
| --- | --- | --- | --- | --- |
| `config.agent.<name>` | 支持 | 统一配置装载后，由 `Agent.state` 遍历 `cfg.agent` 建立或覆盖 agent | 在内建 agents 之后应用；同名逐字段覆盖；`disable: true` 可删除 | 只有 `mode: "subagent"` 时才是 subagent；否则可能是 `primary` 或 `all` |
| `.aether/agent/**/*.md` | 支持 | 通过 `Config.directories()` 枚举的每个 config root 扫描 `{agent,agents}/**/*.md` | 先装入 `cfg.agent`；同层级 `.aether` 在 `.opencode` 之前 yield，同名时 `.opencode` 覆盖权更高 | 新品牌目录名 |
| `.aether/agents/**/*.md` | 支持 | 同上 | 同上 | 与 `agent/` 等价 |
| `.opencode/agent/**/*.md` | 支持 | 同上扫描方式 | 先装入 `cfg.agent`；同层级 `.opencode` 覆盖权高于 `.aether` | legacy 目录名 |
| `.opencode/agents/**/*.md` | 支持 | 同上 | 同上 | 与 `agent/` 等价 |
| `~/.aether/agents/**/*.md` | 支持 | home 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于项目级之后 | home 目录扫描 |
| `~/.opencode/agents/**/*.md` | 支持 | home 目录下的 `.opencode` 属于 `Config.directories()` 的一员 | 同上 | legacy home 目录 |
| `<binaryDir>/.aether/agents/**/*.md` | 支持 | binary 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于 home 目录之后 | 打包发行版专用 |
| `<binaryDir>/.opencode/agents/**/*.md` | 支持 | 同上 | 同上 | legacy 打包发行版 |
| `OPENCODE_CONFIG_DIR/agent(s)` | 支持 | 属于 `Config.directories()` 一部分 | 与其它 `.aether` / `.opencode` roots 一起按统一配置顺序并入 | 没有单独特权，仍受统一 merge 顺序约束 |
| `{mode,modes}/*.md` | 部分支持 | 会被扫描，但进入 `loadMode()` 后强制改成 `mode: "primary"` | 不会产出 subagent | 这是 mode 兼容层，不是 subagent 兼容层 |
| `.claude/agents/**` | 不支持 | 无扫描逻辑 | 不参与 | 当前代码没有为 agent/subagent 定义 Claude Code 风格外部目录兼容 |
| `.agents/**` | 不支持 | 无扫描逻辑 | 不参与 | 与 `skills` 不同，subagents 没有外部 `.agents` 目录兼容 |
| skill 自动暴露为 subagent | 不支持 | 无此逻辑 | 不参与 | 只有 skill 自动暴露为 command，没有 skill-as-subagent |

补充说明：

1. `subagents` 与 `commands` 一样，依附统一 config roots；不像 `skills` 那样有一套单独的外部目录发现逻辑。
2. 从实现上说，markdown agent 文件本身只是生成 `cfg.agent` 的一部分，真正决定“它是不是 subagent”的地方仍然是最终的 `mode` 值。
3. `default_agent` 不能指向 subagent，也不能指向 `hidden: true` 的 agent。

### 7.4 Rules 兼容矩阵

| 来源/生态 | 是否支持 | 实际扫描/接入方式 | 优先级/覆盖判定 | 备注 |
| --- | --- | --- | --- | --- |
| 项目内 `AGENTS.md` | 支持 | `systemPaths()` 从当前目录向上到 `worktree` 查找 | 在项目内文件类型优先级里最高；一旦任一路径找到 `AGENTS.md`，同轮不再尝试 `CLAUDE.md` / `CONTEXT.md` | 同类型命中的所有层级文件都会加入 |
| 项目内 `CLAUDE.md` | 支持 | 仅当项目链路上完全找不到任何 `AGENTS.md` 时才会向上查找 | 次于 `AGENTS.md`，高于 `CONTEXT.md` | 属于文件名兼容，不是 `.claude` 目录兼容 |
| 项目内 `CONTEXT.md` | 支持但已废弃 | 仅当 `AGENTS.md` 与 `CLAUDE.md` 都完全缺失时才查找 | 在三者中最低 | 代码中标注 deprecated |
| `OPENCODE_CONFIG_DIR/AGENTS.md` | 支持 | 作为全局规则文件第一优先级检查 | 全局规则只取第一个存在的文件 | 若存在，则压过 `Global.Path.config/AGENTS.md` 与 `~/.claude/CLAUDE.md` |
| `Global.Path.config/AGENTS.md` | 支持 | 全局规则文件第二优先级 | 仅在上者不存在时使用 | 当前实际路径为 `~/.config/aether/AGENTS.md` 或 `~/.config/opencode/AGENTS.md` |
| `~/.claude/CLAUDE.md` | 支持 | `globalFiles()` 的最后一个后备项 | 仅在前两者不存在时使用 | 这是当前 rules 对 Claude 生态最明确的一条兼容 |
| `.claude/CLAUDE.md`（项目内） | 间接支持 | 并非按目录名扫描，而是因为文件名正好叫 `CLAUDE.md`，会被项目向上查找命中 | 受 `AGENTS.md > CLAUDE.md > CONTEXT.md` 控制 | 也就是说支持的是文件名协议，不是 `.claude` 目录协议 |
| `.agents` 规则文件 | 不支持 | 无扫描逻辑 | 不参与 | 当前 rules 没有 `.agents` 对应兼容层 |
| `config.instructions` 本地路径 | 支持 | 作为额外 instructions 追加；相对路径通过 `globUp()` 解析 | 与其它 instructions 做数组拼接去重，不是整体覆盖 | 可用相对路径、绝对路径 |
| `config.instructions` URL | 支持 | `system()` 阶段直接 HTTP(S) 拉取文本 | 追加到系统 instructions 列表 | 失败静默为空字符串 |
| 读文件时的目录级 `AGENTS/CLAUDE/CONTEXT` | 支持 | `read` 工具触发 `InstructionPrompt.resolve()` 额外向上查找 | 不覆盖 system rules，而是作为额外 reminder 注入 | 仅对被读取文件所在目录链生效 |
| `.cursor/rules/` | 不支持 | 无运行时自动扫描 | 不参与 | 只在 `/init` 模板里被提醒人工整合 |
| `.cursorrules` | 不支持 | 无运行时自动扫描 | 不参与 | 同上 |
| `.windsurf/rules.md` | 不支持 | 无运行时自动扫描 | 不参与 | 同上 |
| `.github/copilot-instructions.md` | 不支持 | 无运行时自动扫描 | 不参与 | 同上 |

补充说明：

1. `rules` 不是对称的“目录插件系统”，而是“固定文件名协议 + instructions 列表 + read 时局部注入”的混合机制。
2. 项目内 `CLAUDE.md` 的兼容是很有限的：只有在整个向上链路中没有任何 `AGENTS.md` 时它才会生效。
3. 全局 `~/.claude/CLAUDE.md` 也只是最后一级 fallback；只要 `OPENCODE_CONFIG_DIR/AGENTS.md` 或全局 `AGENTS.md` 存在，它就不会被采用。
4. `permission` 若也视为 rules，仍然属于配置型规则，不属于 `.claude` / `.agents` / IDE rules 目录兼容范畴。

## 8. 涉及文件总表

下表总结了本次分析涉及到的主要实现文件、用途、以及它们与四类能力的关系。

| 文件 | 作用 | 关联能力 |
| --- | --- | --- |
| `packages/opencode/src/config/config.ts` | 统一配置装载、合并、目录扫描、command/agent/mode/plugin 装载 | commands, subagents, rules, skills |
| `packages/opencode/src/config/paths.ts` | 计算配置文件与配置目录扫描顺序 | commands, subagents, skills, rules |
| `packages/opencode/src/config/markdown.ts` | 解析 `.md` frontmatter | skills, commands, subagents |
| `packages/opencode/src/skill/index.ts` | skill 主发现器、去重、禁用、可用性过滤 | skills |
| `packages/opencode/src/skill/discovery.ts` | 远端 `skills.urls` 下载与缓存 | skills |
| `packages/opencode/src/effect/instance-state.ts` | 按当前 `Instance.directory` 缓存运行时状态；skills 会在读取缓存前额外做 mtime snapshot 校验 | skills, commands, subagents 等运行时状态 |
| `packages/opencode/src/project/instance.ts` | 建立当前目录 instance，提供 `directory` / `worktree` 上下文，并实现 `dispose` / `reload` / `disposeAll` | skills, commands, subagents, rules |
| `packages/opencode/src/server/server.ts` | 服务端请求入口；根据请求目录建立 instance，并提供 `/instance/dispose` | skills |
| `packages/opencode/src/server/routes/config.ts` | 配置与默认 skills API；不同接口对 skill 缓存的清理行为不同 | skills |
| `packages/opencode/src/server/routes/global.ts` | 全局配置与 `/global/dispose`；可触发所有 instance 状态清理 | skills |
| `packages/opencode/src/command/index.ts` | 运行时命令表装配，整合 builtin/config/MCP/skill | commands |
| `packages/opencode/src/command/template/initialize.txt` | `/init` 内建命令模板，提醒纳入 Cursor/Copilot rules | rules |
| `packages/opencode/src/agent/agent.ts` | 内建 agents、配置 agent 覆盖、自定义 subagent、生效权限 | subagents, rules |
| `packages/opencode/src/session/instruction.ts` | 规则文件 system paths、instruction 路径解析、read 时局部规则注入 | rules |
| `packages/opencode/src/permission/index.ts` | permission 配置转 ruleset、合并、工具禁用判断 | rules |
| `packages/opencode/src/permission/evaluate.ts` | permission 真正匹配逻辑，最后匹配生效 | rules |
| `packages/opencode/src/tool/skill.ts` | skill tool，将已发现 skill 注入会话上下文 | skills |
| `packages/opencode/src/session/system.ts` | 将可用 skills 列入系统提示 | skills |
| `packages/opencode/src/persist/naming.ts` | 定义 `.aether` / `.opencode` / `aether.*` / `opencode.*` 品牌常量 | 所有四类能力 |
| `packages/opencode/src/persist/migrate.ts` | 用户级与项目级命名迁移逻辑（项目级未激活） | skills（项目级迁移仅覆盖 skills） |
| `packages/opencode/src/util/filesystem.ts` | `findUp` / `up` / `globUp` 等向上扫描基础设施 | skills, rules, config roots |
| `packages/opencode/test/skill/skill.test.ts` | skill 本地/外部目录发现测试 | skills |
| `packages/opencode/test/skill/discovery.test.ts` | 远端 skills 下载、缓存测试 | skills |
| `packages/opencode/src/skill/skill-priority.test.ts` | skill 优先级、skill-sessions、shadow `.aether` 覆盖测试 | skills |
| `packages/opencode/src/skill/skill-mtime-cache.test.ts` | skill mtime snapshot 失效测试 | skills |
| `packages/opencode/test/config/config.test.ts` | config 合并优先级、commands/agents/instructions 等装载测试 | commands, subagents, rules |
| `packages/opencode/test/session/instruction.test.ts` | `AGENTS.md`/全局 rules 优先级测试 | rules |
| `packages/opencode/test/permission-task.test.ts` | permission.task 与最后匹配生效测试 | rules |

## 9. 最终结论

当前程序对用户自定义 `skills`、`commands`、`subagents`、`指令型 rules` 都是支持的，但这四者并不是四套完全对称的插件系统：

1. `skills` 的发现机制最丰富，支持外部目录、skill-sessions、config roots、额外路径、远端 URL，并通过 mtime snapshot 在下一次访问时感知本地 `SKILL.md` 变化。
2. `commands` 与 `subagents` 主要依附统一 config roots 扫描；该扫描现同时搜索 `.aether` 和 `.opencode`，且还包含 home 目录和 binary 目录。
3. `rules` 的核心不是“任意 rules 目录自动接入”，而是固定的 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` + `instructions`。
4. IDE 生态的 `.cursor/rules`、`.windsurf/rules.md`、`.github/copilot-instructions.md` 当前不会被核心运行时自动扫描，只能通过人工汇总进 `AGENTS.md` 或 `config.instructions` 来间接纳入。
5. 项目已从 `opencode` 品牌迁移至 `aether` 品牌。多数 config roots 采取“双名并行”策略：`.aether` 和 `.opencode`（`aether.*` 和 `opencode.*`）同时被搜索和装载；但 skills 的外部阶段还额外支持 `.agents` / `.claude`，且同层外部目录优先级为 `.agents < .claude < .opencode < .aether`。项目级迁移代码（仅覆盖 skills 子目录）已定义但未激活。
