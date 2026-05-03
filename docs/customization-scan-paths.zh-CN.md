# Aether 当前对 Skills、Commands、Subagents、Rules 的支持、扫描路径与优先级

总体结论：

1. `skills`：支持用户自定义。
2. `commands`：支持用户自定义。
3. `subagents`：支持用户自定义。
4. `rules`：支持，但分两类：
   - 指令型规则：支持 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` 与 `instructions`
   - 通用 IDE 规则目录：不支持自动扫描 `.cursor/rules`、`.windsurf/rules.md`、`.github/copilot-instructions.md` 这类目录/文件作为运行时规则源

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
- `packages/opencode/src/tool/skill.ts`
- `packages/opencode/src/tool/skill-manage.ts`

### 2.1 是否支持

支持用户自定义 skills。

### 2.2 扫描路径

按实际装载顺序，低到高为：

1. 打包或仓库自带的默认 skills
   - `Config.getDefaultSkillsDir()` 会优先寻找 `.aether/skills`，找不到时回退到 `.opencode/skills`
   - 打包发行版优先从 binary 所在目录查找；本地开发环境会从 `process.cwd()` 向上查找
   - 测试环境中不会启用这一路径，以避免仓库自带 skills 污染测试临时目录
2. 全局外部 skills
   - `~/.claude/skills/**/SKILL.md`
   - `~/.agents/skills/**/SKILL.md`
3. 项目内外部 skills
   - 从当前目录向上到 `worktree` 查找：
   - `.claude/skills/**/SKILL.md`
   - `.agents/skills/**/SKILL.md`
4. 配置目录内的 legacy `.opencode` skills 及其它非 `.aether` 配置根
   - 对每个 `Config.directories()` 根目录扫描，但会跳过当前默认 skills 所在配置根，并暂时跳过 basename 为 `.aether` 的根：
   - `{skill,skills}/**/SKILL.md`
   - 典型路径如：
     - `~/.config/aether/skill/**/SKILL.md`
     - `~/.config/aether/skills/**/SKILL.md`
     - `<项目>/.opencode/skill/**/SKILL.md`
     - `<项目>/.opencode/skills/**/SKILL.md`
     - `~/.opencode/skill/**/SKILL.md`
     - `~/.opencode/skills/**/SKILL.md`
5. `config.skills.paths`
   - 每个目录扫描 `**/SKILL.md`
   - 相对路径相对于当前项目目录
   - 绝对路径会根据它是否位于当前项目目录或 worktree 下，被归入 project 或 global scope；相对路径固定归入 project scope
6. `config.skills.urls`
   - 拉取远端 `index.json`
   - 下载到缓存目录后再扫描
7. 配置目录内的 `.aether` skills
   - 对 `Config.directories()` 中 basename 为 `.aether` 的根扫描 `{skill,skills}/**/SKILL.md`
   - 典型路径如：
     - `<项目>/.aether/skill/**/SKILL.md`
     - `<项目>/.aether/skills/**/SKILL.md`
     - `~/.aether/skill/**/SKILL.md`
     - `~/.aether/skills/**/SKILL.md`
   - 这一步晚于 `skills.paths` 和 `skills.urls`，因此同名时 `.aether` 的演化版本通常拥有更高优先级
8. 当前默认 skills 所在父级的 `.aether` 目录
   - 若默认 skills 目录存在，程序还会尝试扫描同一父级下的 `.aether/{skill,skills}/**/SKILL.md`
   - 这一步主要覆盖打包目录或本地仓库中的 `.aether` skills

### 2.3 覆盖规则

1. skill 以 frontmatter 的 `name` 为主键。
2. 同名 skill 不会在扫描阶段立即丢弃；global scope 与 project scope 会各自保留候选列表，最后合并时再按扫描顺序选择优先级最高的可用版本。
3. 每个来源在 `buildSources()` 中都有一个递增的 `order`。最终合并时会把 global 候选和 project 候选放到一起按 `order` 排序；同名 skill 后出现者覆盖先出现者。因此优先级主要由 2.2 的来源顺序决定，而不是简单地由 global/project scope 决定。
4. `skills.disabled` 存储的是 skill 目录绝对路径，而不是 skill 名。合并时如果某个候选的 `SKILL.md` 所在目录在 disabled 集合中，就跳过该候选。
5. disabled 是“跳过具体路径”，不是“删除这个名字”。因此禁用 `.aether/skills/foo` 后，如果 `.opencode/skills/foo` 或默认 skills 中还有同名候选，低优先级版本可以作为 fallback 重新生效。
6. 旧的 name-based disabled 条目不会匹配任何绝对目录路径，因此不会影响运行时合并；相关列表接口会清理已不存在的 disabled 路径。
7. 若启用 `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`，则 `.claude` / `.agents` 外部 skill 来源整体失效。
   需要注意级联关系：`OPENCODE_DISABLE_CLAUDE_CODE` 是总开关，为 true 时会隐式激活 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`，进而隐式激活 `OPENCODE_DISABLE_EXTERNAL_SKILLS`，所以设置 `OPENCODE_DISABLE_CLAUDE_CODE=true` 也等同于关闭外部 skills。
8. `platforms` frontmatter 会被解析并保存在 skill 信息中，但当前 `Skill.available()` / 系统提示构建路径没有实际用它过滤可用列表。
9. `metadata.hermes` 下的 `requires_tools`、`requires_toolsets`、`fallback_for_tools`、`fallback_for_toolsets` 会被解析为 `conditions`。系统提示构建时会根据当前可用工具集合过滤这些条件；`skill` 工具描述本身仍来自 `Skill.available()`，只按 agent permission 过滤。

#### 2.3.1 Linux 示例：同名 skills 如何覆盖

假设 Linux 用户在项目 `/home/alice/work/acme` 下运行 Aether，当前配置文件 `/home/alice/work/acme/aether.jsonc` 包含如下内容。下文中的 `~` 表示 `/home/alice`，并假设 `OPENCODE_CONFIG_DIR=/etc/aether-config`：

```json
{
  "skills": {
    "paths": ["./team-skills"],
    "urls": ["https://example.com/aether-skills"]
  }
}
```

同时，下面这些 `SKILL.md` 都存在，并且 frontmatter 里都声明同一个名字：

```yaml
---
name: review
description: Review code changes
---
```

那么同名 `review` skill 会按下面顺序进入候选列表，越靠后的候选优先级越高。带“可选”的行只有对应目录或环境变量存在时才参与：

| 顺序 | 来源 | 示例路径 | scope | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 默认内置 skill | `/opt/aether/.aether/skills/review/SKILL.md` | global | 先成为 `review` |
| 2 | 全局外部 skill | `~/.claude/skills/review/SKILL.md` | global | 覆盖默认版本 |
| 3 | 全局外部 skill | `~/.agents/skills/review/SKILL.md` | global | 覆盖全局 `.claude` 版本 |
| 4 | 项目外部 skill | `/home/alice/work/acme/.claude/skills/review/SKILL.md` | project | 覆盖全局 `.agents` 版本 |
| 5 | 项目外部 skill | `/home/alice/work/acme/.agents/skills/review/SKILL.md` | project | 覆盖项目 `.claude` 版本 |
| 6 | 全局配置目录 | `~/.config/aether/skills/review/SKILL.md` | global | 覆盖项目外部版本 |
| 7 | 项目 legacy 配置目录 | `/home/alice/work/acme/.opencode/skills/review/SKILL.md` | project | 覆盖全局配置目录版本 |
| 8 | home legacy 配置目录 | `~/.opencode/skills/review/SKILL.md` | global | 覆盖项目 `.opencode` 版本 |
| 9 | `OPENCODE_CONFIG_DIR` 可选 | `/etc/aether-config/skills/review/SKILL.md` | global | 覆盖 home `.opencode` 版本 |
| 10 | `skills.paths` | `/home/alice/work/acme/team-skills/review/SKILL.md` | project | 覆盖前面的非 `.aether` 配置根版本 |
| 11 | `skills.urls` 下载缓存 | `~/.cache/aether/skills/review/SKILL.md` | global | 覆盖 `skills.paths` 版本 |
| 12 | 项目 `.aether` 配置目录 | `/home/alice/work/acme/.aether/skills/review/SKILL.md` | project | 覆盖远端缓存版本 |
| 13 | home `.aether` 配置目录 | `~/.aether/skills/review/SKILL.md` | global | 覆盖项目 `.aether` 版本 |
| 14 | 默认 skills 父级 `.aether` 复扫，可选 | `/opt/aether/.aether/skills/review/SKILL.md` | global | 如果存在同名候选，会成为最终生效版本 |

因此，在这个例子里，如果第 14 行存在且没有被禁用，模型看到和调用的 `review` 会来自：

```text
/opt/aether/.aether/skills/review/SKILL.md
```

如果第 14 行没有同名候选，则会退回到第 13 行：

```text
~/.aether/skills/review/SKILL.md
```

这里有几个容易踩错的点：

1. 全局 skill 不只有 `~/.claude` / `~/.agents`。`~/.config/aether`、`~/.opencode`、`~/.aether` 这些配置根里的 `SKILL.md` 也会参与候选合并。
2. home 级 `.opencode` 在这个链路中晚于项目 `.opencode`，所以 `~/.opencode/skills/review` 可以覆盖 `/home/alice/work/acme/.opencode/skills/review`。
3. `skills.urls` 下载到 `~/.cache/aether/skills/<name>/` 后作为 global 来源参与合并，但它的 `order` 晚于 `skills.paths`，所以在上面的例子中会覆盖 `./team-skills` 里的同名版本。
4. `~/.aether/skills/review` 晚于项目 `.aether/skills/review`，所以 home 级 `.aether` 可以覆盖项目级 `.aether`。
5. 默认 skills 父级 `.aether` 的复扫发生在最后；如果打包目录中同名 skill 存在，它可能再次覆盖前面所有候选。若它只是第 1 行同一个文件的重复扫描，效果就是默认版本在链路末尾再次写入。

如果用户通过配置或 UI 禁用了某个版本，写入全局配置的 disabled 项应该是 skill 目录绝对路径。例如禁用第 13 行：

```json
{
  "skills": {
    "disabled": ["/home/alice/.aether/skills/review"]
  }
}
```

这时程序只会跳过这个具体目录。如果第 14 行不存在，下一个高优先级候选 `/home/alice/work/acme/.aether/skills/review/SKILL.md` 会作为 fallback 生效。如果继续禁用这个项目 `.aether` 目录，则会再回退到 `~/.cache/aether/skills/review/SKILL.md`。

相反，如果配置里写的是旧式名字：

```json
{
  "skills": {
    "disabled": ["review"]
  }
}
```

它不会匹配任何 skill 目录绝对路径，因此不会禁用上面任何一个 `review` 候选。

### 2.4 运行时加载与缓存机制

扫描路径只回答“哪些地方有可能被发现”。运行时还必须回答另一个问题：程序启动后，文件系统里发生变化时，Aether 会不会马上重新扫描、重新加载？

结论是：**Aether 当前有针对 skill 目录的缓存失效与热更新机制**。skill 的发现结果仍会按当前工作目录缓存，但程序会监听相关目录，发现 `SKILL.md` 新增、修改、删除后按 global/project scope 清理对应缓存。下一次构建系统提示、调用 `Skill.all()`、`Skill.available()`、`Skill.get()` 或 `Skill.dirs()` 时，会重新读取最新的 skill 列表。

为了理解这一点，需要先区分几个运行时概念：

| 名称 | 含义 | 和 skills 的关系 |
| --- | --- | --- |
| `Instance.directory` | 当前请求、会话或 CLI 命令所在的工作目录。服务端会根据请求里的 `directory`、请求头里的目录，或默认的 `process.cwd()` 建立当前 instance。 | skill 缓存以它为 key。同一个目录会复用同一份 skill 列表；不同目录会各自初始化、各自缓存。 |
| `Instance.worktree` | 当前项目的工作区根目录，通常是 git worktree 根。 | 扫描项目内 `.claude/skills` 和 `.agents/skills` 时，会从 `Instance.directory` 向上查找到 `Instance.worktree` 为止。 |
| `loadSkillsData(directory, worktree)` | skill 模块中真正执行扫描、快照读取和合并的函数。 | 它按 2.2 的顺序构建来源，分别读取 global/project 磁盘快照或重新扫描，再按 disabled path 合并。 |
| `state.skills` | skill 模块的内存表，形如 `skill 名 -> skill 信息`。 | 每条记录保存 `name`、`description`、`location`、`content`。其中 `location` 是 `SKILL.md` 的绝对路径，`content` 是扫描当时读到的正文快照。 |
| `state.dirs` | 当前已发现 skill 所在目录的集合。 | 后续会被 agent 权限初始化逻辑使用，让 skill 目录里的资源文件更容易被读取。 |
| `InstanceState` | 按 `Instance.directory` 缓存运行时状态的通用机制。 | skill 模块把 `state.skills` 和 `state.dirs` 放进 `InstanceState`。因此同一个目录里，第一次需要 skills 时会扫描；之后再读 skills 时通常只读缓存。 |
| 磁盘快照 | skill 模块把 global 和 project 扫描结果分别写入 cache。 | global 快照位于 `Global.Path.cache/.skills_prompt_snapshot.global.json`；project 快照位于 `Global.Path.cache/skills-prompt/<project>.<hash>.json`。快照用 `SKILL.md` 的路径、mtime 和 size 组成 manifest 判定是否可复用。 |
| skill watcher | 每个 instance 会维护独立 watcher 状态。 | 默认尝试 `@parcel/watcher`，失败时退回轮询；测试环境跳过 watcher。global 变更清理所有 active instances，project 变更只清理当前 project instance。 |
| `Skill.all()` | 返回当前目录的全部 skills。 | 如果当前目录还没有内存缓存，会触发加载；如果 watcher 或配置更新清掉了缓存，下次调用会重新加载。 |
| `Skill.available(agent)` | 返回当前 agent 可用的 skills。 | 在 `Skill.all()` 的基础上按该 agent 的 skill permission 过滤。系统提示还会额外按 tool conditions 过滤。 |
| `Skill.get(name)` | 从当前目录的 skill 表里按名字取一个 skill。 | 如果内存缓存已失效，会先重新加载；否则直接从当前缓存中取。 |
| `Skill.dirs()` | 返回当前目录的 skill 目录列表。 | 如果内存缓存已失效，会先重新加载；否则只读缓存。主要用于权限系统允许读取 skill 附带资源。 |
| `Skill.clearSkillsPromptCache(scope)` | 主动清理 skill 内存缓存。 | `scope="all"` 清理所有 active instances；传入某个项目目录时只清理对应 instance。 |
| `SkillTool.execute()` | agent 真正调用内置 `skill` 工具时执行的逻辑。 | 它先用 `Skill.get(name)` 找缓存记录，再按缓存记录里的 `location` 重新读取该 `SKILL.md` 的正文。 |
| `skill_manage` | agent 修改 skill 的专用工具。 | 对 `create`、`edit`、`patch`、`delete`、`rollback` 等操作会写入 `.aether/skills/<name>/` shadow 目录，并主动清理 skill 缓存；写入时会用 mark/cooldown 避免 watcher 重复触发。 |
| `Discovery.pull(url)` | 处理 `config.skills.urls` 的远端下载逻辑。 | 它会拉取远端 `index.json`，把远端 skill 文件下载到 `Global.Path.cache/skills/<skill-name>`，然后把这个缓存目录纳入 `loadSkillsData()` 的扫描来源。 |

这意味着，程序里有两类“加载”必须分开看：

1. **发现并登记 skill 列表**：扫描路径、解析 frontmatter、确定 `name` / `description` / `location` / `content` / `conditions` / `platforms`、处理同名覆盖和禁用。这一步会被内存缓存和磁盘快照缓存。
2. **真正调用某个 skill 工具时注入正文**：agent 调用 `skill({ name })` 后，程序会根据缓存中的 `location` 再读一次这个 `SKILL.md` 的正文。这一步可以读到已登记 skill 的最新正文。

### 2.5 一个 skill 从被扫描到使用完成的完整链路

无论 skill 来自哪一种路径，最终都会收敛到同一套运行时流程。也就是说，`~/.claude/skills/foo/SKILL.md`、项目内 `.aether/skills/foo/SKILL.md`、`config.skills.paths` 下的 `foo/SKILL.md`、远端 URL 下载到缓存后的 `foo/SKILL.md`，只要被扫描到，后续处理逻辑都是一样的。

完整链路如下：

| 阶段 | 发生了什么 | 结果 |
| --- | --- | --- |
| 1. 建立当前 instance | 请求、会话或 CLI 命令进入后，Aether 确定当前 `Instance.directory` 和 `Instance.worktree`。 | 后续所有 skill 扫描和缓存都绑定到这个目录上下文。 |
| 2. 某个入口第一次需要 skills | 常见入口包括：构建系统提示里的 `<available_skills>`、初始化 `skill` 工具描述、调用 `/skill` API、构建 skill-as-command、初始化 agent 的 skill 目录权限白名单。 | 程序开始读取当前目录对应的 skill 状态。 |
| 3. 确保 watcher 已启动 | `Skill.get/all/available/dirs` 会先调用 `ensureWatch()`。 | 如果当前 instance 还没有 watcher，会建立 watcher；如果 watcher 已失效，会按节流规则重启。 |
| 4. 查询 `InstanceState` | skill 模块通过 `InstanceState.get()` 按 `Instance.directory` 查内存缓存。 | 如果这个目录已有有效内存缓存，直接复用；如果没有，进入磁盘快照或扫描流程。 |
| 5. 构建扫描来源 | `buildSources()` 按 2.2 的顺序列出 global/project 来源。 | 得到后续 manifest、快照和扫描所需的来源列表。 |
| 6. 构建 manifest | 程序分别为 global 来源和 project 来源收集 `SKILL.md` 的路径、mtime、size。 | 用于判断磁盘快照是否仍然有效。 |
| 7. 读取或重建磁盘快照 | global/project 快照命中时直接读取；未命中时扫描对应来源并写入新快照。 | 得到 global 候选列表和 project 候选列表。 |
| 8. 解析 `SKILL.md` | 每个候选文件由 `ConfigMarkdown.parse()` 解析 frontmatter 和正文。 | 只有 frontmatter 至少满足 `name` 和 `description` 的文件会被登记为有效 skill；`conditions` 和 `platforms` 也会被保存。 |
| 9. 处理同名覆盖和禁用项 | 合并 global/project 候选时，先跳过 disabled path，再按来源 `order` 让后发现的同名候选覆盖先发现候选。 | 被禁用的具体路径不进入可用列表；同名低优先级候选可作为 fallback 生效。 |
| 10. 缓存扫描结果 | 完整的 `state.skills` 和 `state.dirs` 被保存在当前目录的 `InstanceState` 中。 | 后续同目录读取 skills 时先复用内存缓存，直到 watcher、配置更新或主动清理使其失效。 |
| 11. 暴露给模型 | `SystemPrompt.skills(agent)` 调用 `Skill.available(agent)`，把可用 skill 的 `name`、`description` 写入系统提示；`SkillTool.init()` 也用 `Skill.available(agent)` 生成工具描述。 | 模型知道“有哪些 skills 可以用”，但还没有拿到完整正文；系统提示不暴露 `location`。 |
| 12. 模型决定调用 skill 工具 | 当模型判断任务匹配某个 skill 时，会调用内置工具 `skill({ name })`。 | 程序进入 `SkillTool.execute()`。 |
| 13. 从缓存取目标 skill | `SkillTool.execute()` 调用 `Skill.get(name)`，从缓存的 `state.skills` 里取这个名字。 | 如果缓存里没有这个名字，则报错并列出当前缓存里有哪些 skill。 |
| 14. 检查文件是否仍存在 | 程序检查缓存记录里的 `location` 是否还能访问。 | 如果文件已经被删除或不可访问，会报 “Skill not found”。 |
| 15. 重新读取正文 | 程序重新解析 `location` 指向的 `SKILL.md`，取最新正文；如果解析失败，则回退到扫描时缓存的旧 `content`。 | 已登记 skill 的正文修改，通常可以在下一次 `skill` 工具调用时生效。 |
| 16. 申请 skill 权限 | 程序通过权限系统请求 `permission: "skill"`，匹配目标 skill 名。 | 权限允许后才继续返回 skill 内容；权限拒绝则不会把 skill 内容注入上下文。 |
| 17. 枚举 skill 附带文件 | 程序在 skill 所在目录下采样最多 10 个非 `SKILL.md` 文件。 | 输出里会提示 `scripts/`、`references/` 等资源路径以 skill 基础目录为准。 |
| 18. 返回工具输出 | 工具返回 `<skill_content name="...">`，其中包含 skill 正文、base directory、采样文件列表。 | 这段输出进入对话上下文，模型之后就可以按 skill 的完整说明继续工作。 |

这里还要特别区分 `skill` 工具路径和 skill-as-command 路径：

| 使用方式 | 用户/模型看到的形式 | 走不走 `SkillTool.execute()` | 正文来源 | 运行中修改正文后是否立刻生效 |
| --- | --- | --- | --- | --- |
| 内置 `skill` 工具 | 模型调用 `skill({ name: "foo" })` | 走 | 先通过缓存找到 `location`，再重新读取 `SKILL.md` 正文 | 通常生效，因为执行时会重新读正文 |
| skill-as-command | 用户输入 `/foo`，其中 `foo` 来自 skill 名 | 不走 | `Command.state` 构建命令表时使用扫描时缓存的 `skill.content` | 不会立刻生效，需要重新扫描后命令模板才更新 |

skill-as-command 的存在容易造成误解。它只是 command 层把已发现的 skill 补充注册成同名 slash command；它不改变 skill 本身的发现、缓存和覆盖规则。执行 `/foo` 时，程序走的是 command 模板展开流程，而不是 `skill` 工具的执行流程，因此不会像 `skill({ name: "foo" })` 那样重新读取 `SKILL.md` 正文。

### 2.6 什么时候会放弃旧缓存并重新扫描

对用户来说，判断规则可以概括为：

1. **第一次访问某个目录的 skills**：会扫描。
2. **访问一个还没有缓存过的新目录**：会扫描。
3. **当前目录的 skill 内存缓存被 watcher、配置更新或主动 API 清理后再次访问 skills**：会重新加载。
4. **新增、修改、删除 `SKILL.md` 文件**：watcher 会按 global/project scope 清理内存缓存；下一次访问 skills 时会重新加载。
5. **修改已登记 skill 的正文并通过 `skill` 工具调用**：即使内存缓存尚未失效，也可能读到新正文，因为工具执行阶段会重新读缓存 `location` 对应的文件。

更具体地说：

| 用户可感知场景 | 是否会重新扫描 skills | 说明 |
| --- | --- | --- |
| 第一次在某个目录里发送会触发 skill 列表的请求 | 会 | 当前 `Instance.directory` 还没有 skill 缓存，第一次访问会跑 `loadSkillsData()`。 |
| 在 Web/App/TUI 中切换到一个从未访问过的项目目录 | 会 | 新目录对应新的 `Instance.directory`，没有旧缓存。 |
| 切回之前访问过、且未被清理的目录 | 通常不会 | 之前的 `InstanceState` 仍在内存里，会复用旧 skill 列表；如果 watcher 或配置更新已经清理了该 instance，则会重新加载。 |
| 重启 Aether 服务端、桌面端、TUI worker 或 CLI 进程 | 会 | 运行时内存消失，下次访问时重新初始化。 |
| 服务端调用 `/instance/dispose` | 会，但发生在下次访问当前目录时 | 该接口清理当前 `Instance.directory` 的 instance 状态。清理后，下次需要 skills 才重新扫描。 |
| 服务端调用 `/global/dispose` | 会，但发生在下次访问各目录时 | 该接口清理所有目录的 instance 状态。 |
| PATCH `/config` 更新当前项目配置 | 会 | `Config.update()` 写入当前目录的 `config.json` 后调用 `Instance.dispose()`。 |
| PATCH `/global` 更新全局配置 | 会，但清理是异步触发 | `Config.updateGlobal()` 会触发 `Instance.disposeAll()`，用于让全局配置变化影响所有目录。 |
| `/config/skills/toggle` 启用或禁用 skill | 会 | 该接口更新全局 `skills.disabled`，并调用 `Skill.clearSkillsPromptCache()`；全局 managed skill 清所有实例，项目 skill 清对应项目实例。 |
| `/config/skills/defaults` 复制默认 skill 到当前项目 | 会 | 复制动作会落到项目 `.aether/skills/` 下；watcher 可感知新增目录或文件，后续访问会重新加载。 |
| `/config/skills` 保存或更新默认 skill 文件 | 会 | 如果写入位置属于 watcher 监听范围，后续访问会重新加载；已登记 skill 通过 `skill` 工具调用时也会重新读取正文。 |
| DELETE `/config/skills/:name` 删除默认 skill 文件 | 会 | 如果删除位置属于 watcher 监听范围，后续访问会重新加载；在清理前调用旧缓存记录可能因文件不存在失败。 |
| `skill_manage create/edit/patch/delete/rollback` | 会 | `skill_manage` 会写入 `.aether/skills/<name>/` shadow 目录，并主动调用 `Skill.clearSkillsPromptCache()` 清理缓存。 |
| 手动在任意扫描路径下新增 `SKILL.md` | 会，在 watcher 生效后 | watcher 会监听 `.aether` / `.opencode` / `.claude` / `.agents` 候选目录和已知来源目录；新增文件后下一次访问 skills 会重新加载。 |
| 手动修改已发现 skill 的正文 | 会，在 watcher 生效后；通过 `skill` 工具调用通常也能读到新正文 | watcher 会清理列表缓存；同时 `SkillTool.execute()` 会重新读取缓存 `location` 指向的文件正文。 |
| 手动修改已发现 skill 的 `name` | 会，在 watcher 生效后 | 重新加载后新名字成为缓存键；清理前旧缓存仍以旧名字索引。 |
| 手动修改已发现 skill 的 `description` | 会，在 watcher 生效后 | 重新加载后系统提示和工具描述会使用新描述。 |
| 手动修改 `skills.paths` 配置文件，但没有通过配置 API 触发 dispose | 会被 watcher 周期性检查到 | watcher 会定期比较 `skills.paths` 的签名；变化后会重建 watcher roots 并清理相关缓存。 |
| 手动修改 `skills.urls` 配置文件，但没有通过配置 API 触发 dispose | 不保证立即生效 | watcher roots 的签名只跟踪 `skills.paths`；`skills.urls` 更稳定的刷新方式仍是通过配置 API、dispose / reload 或重启触发重新加载。 |
| git 初始化导致项目 worktree 信息变化 | 会 | 项目状态变化时相关路径会调用 `Instance.reload()`，随后重新建立 instance。 |
| 飞书集成中切换到新项目且触发项目初始化 | 会 | 对非 git 项目初始化后会调用 `Instance.reload()`。 |

需要注意三个细节：

1. watcher 和 `Skill.clearSkillsPromptCache()` 清理的是内存缓存；真正重新扫描或读取磁盘快照发生在下一次有代码调用 `Skill.all()`、`Skill.available()`、`Skill.get()` 或 `Skill.dirs()` 时。
2. watcher 默认先尝试 native 后端，失败时退回轮询。测试环境会跳过 watcher，因此测试中通常需要显式清理 instance 或缓存。
3. `Config.updateGlobal()` 触发的全局状态清理可能是异步的。一般用户会感知为“全局配置更新后后续请求会刷新”，但严格说，接口返回和清理完成之间可能有很短的时间差。

### 2.7 运行中修改 skills 的具体效果

把 2.4 到 2.6 合在一起，可以得到下面这些直接结论：

| 运行中发生的变化 | 当前已缓存 instance 能否立刻看到 | 具体原因 |
| --- | --- | --- |
| 新增一个 skill | 会，在 watcher 清理缓存后的下一次访问生效 | 新文件会改变 manifest；重新加载后进入 `state.skills`。 |
| 删除一个已发现 skill | 会，在 watcher 清理缓存后的下一次访问生效 | 重新加载后旧记录会消失；清理前调用旧缓存记录可能因文件不存在失败。 |
| 修改已发现 skill 的正文 | 通过 `skill` 工具通常能立即读到；列表缓存也会在 watcher 后刷新 | `skill` 工具执行时会重新读正文；watcher 会清理列表缓存。 |
| 修改已发现 skill 的 `description` | 会，在 watcher 清理缓存后的下一次系统提示构建生效 | `description` 来自扫描时缓存，需要重新加载。 |
| 修改已发现 skill 的 `name` | 会，在 watcher 清理缓存后的下一次访问生效 | 重新加载后新名字成为索引键。 |
| 修改 `skills.disabled` | 通过 toggle API 会立即清理缓存；手改配置文件取决于配置刷新路径 | 禁用按 skill 目录绝对路径匹配。 |
| 修改 `skills.paths` | 会，在 watcher 周期性检查到签名变化后生效 | watcher 会重建 roots 并触发缓存失效；配置 API 更新也会清理 instance。 |
| 修改 `skills.urls` | 需要重新加载后才会重新拉取远端 index | 远端发现逻辑仍只在 skill 加载过程中执行。 |
| 修改远端 skill 文件内容 | 不一定会更新 | 远端文件下载到本地缓存；如果目标文件已存在，下载逻辑会直接复用，不覆盖。 |

因此，对于用户最关心的两个问题，可以明确回答：

1. **运行过程中加入新的 skills，Aether 能否检测到并使用？**
   - 可以。只要新增文件位于 watcher 关注的候选目录或已知扫描目录中，缓存会在文件事件或轮询检测后失效。
   - 缓存失效后，下一次访问 skills 会重新读取磁盘快照或重新扫描。
   - 重新加载后，只要新 `SKILL.md` 位于支持的扫描路径中，frontmatter 有合法 `name` 和 `description`，且其目录没有被 `skills.disabled` 禁用，就可以被发现并使用。

2. **运行过程中修改已有 skill，Aether 能否使用修改后的版本？**
   - 如果只是修改正文，并且模型通过内置 `skill` 工具调用这个已登记 skill，通常可以直接读到修改后的正文。
   - 如果修改的是 `name`、`description`、禁用状态或扫描路径，需要等 watcher、配置 API、dispose / reload 或重启触发重新加载。
   - 如果通过 `/skill-name` 这种 skill-as-command 使用，则取决于 command 层自身的命令表缓存，不等同于 `skill` 工具执行时的重新读正文。
   - 如果修改后 `SKILL.md` 解析失败，`skill` 工具会回退到扫描时缓存的旧正文。

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
| skills | 支持 | 默认 skills + 外部目录 + 全局/项目 `.aether` / `.opencode/{skill,skills}` + `skills.paths` + `skills.urls` | 同名后加载覆盖先加载；`skills.disabled` 按目录绝对路径跳过候选 |
| commands | 支持 | `config.command` + `.aether` / `.opencode/{command,commands}` + MCP + skill-as-command | 内建 < config.command < MCP；skill 只能补位不能覆盖 |
| subagents | 支持 | `config.agent` + `.aether` / `.opencode/{agent,agents}` | 内建 agents 先建，`config.agent` 后覆盖；`disable: true` 可删除 |
| rules | 支持部分形式 | `AGENTS/CLAUDE/CONTEXT` + `instructions` + permission config | 指令文件按固定顺序装载；permission 采用最后匹配生效 |

## 7. 兼容性补充：Skills、Commands、Subagents 与 Rules

下面补充回答一个很容易混淆的问题：四类能力对 `.aether` / `.opencode`、`.claude`、`.agents`、固定文件名协议、IDE rules 目录等外部生态，到底分别兼容到什么程度。

结论先行：

1. `skills`：兼容最广，显式支持 `.claude` / `.agents` 外部 skills，以及 `.aether` / `.opencode`、额外路径、远端 URL。
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
| 默认 `.aether/skills/**/SKILL.md` | 支持 | `Config.getDefaultSkillsDir()` 优先从 binary 目录或本地仓库向上查找 `.aether/skills` | 是 skills 装载链的基础层之一，后续来源可覆盖同名 skill | 打包时会把 `.opencode/skills` 复制到 binary 旁的 `.aether/skills` |
| 默认 `.opencode/skills/**/SKILL.md` | 支持 | 仅在找不到默认 `.aether/skills` 时作为 fallback | 与默认 `.aether/skills` 二选一，不是同轮并行 | legacy 默认 skills 目录 |
| `~/.claude/skills/**/SKILL.md` | 支持 | `buildSources()` 显式扫描全局外部目录 `.claude` | 晚于默认 skills；同名后发现覆盖先发现 | 可被 `OPENCODE_DISABLE_EXTERNAL_SKILLS` 或 `OPENCODE_DISABLE_CLAUDE_CODE` 整体关闭 |
| `~/.agents/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `~/.claude/skills` 同级 |
| 项目内 `.claude/skills/**/SKILL.md` | 支持 | 从当前目录向上到 `worktree`，逐级找 `.claude` 后扫描其 `skills/**/SKILL.md` | 晚于全局 `.claude` / `.agents`，同名后发现覆盖先发现 | 这是显式目录兼容，不是偶然命中 |
| 项目内 `.agents/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与项目内 `.claude/skills` 同级 |
| `~/.config/aether/skill/**/SKILL.md` | 支持 | 全局配置目录 `Global.Path.config` 属于 `Config.directories()` 的第一个根 | 晚于外部 skills，早于项目 `.opencode`、`skills.paths`、`skills.urls` 和 `.aether` 阶段 | Linux 默认全局配置根 |
| `~/.config/aether/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `.aether/skill/**/*.md` | 不支持 | 无此模式 | 不参与 | skills 只认 `SKILL.md` 文件名，不认任意 markdown |
| `.aether/skill/**/SKILL.md` | 支持 | 对 `Config.directories()` 中 basename 为 `.aether` 的根扫描 `{skill,skills}/**/SKILL.md` | 在 skills 装载链中晚于 `.opencode`、`skills.paths`、`skills.urls`，同名通常覆盖这些来源 | 新品牌目录名，也是 skill 演化写入的主要 shadow 目录 |
| `.aether/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `.opencode/skill/**/*.md` | 不支持 | 无此模式 | 不参与 | skills 只认 `SKILL.md` 文件名，不认任意 markdown |
| `.opencode/skill/**/SKILL.md` | 支持 | 对 `Config.directories()` 中非 `.aether` 根扫描 `{skill,skills}/**/SKILL.md` | 晚于外部 skills，但早于 `skills.paths`、`skills.urls` 和 `.aether` skills | legacy 目录名 |
| `.opencode/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `~/.aether/skills/**/SKILL.md` | 支持 | home 目录下的 `.aether` 属于 `Config.directories()` 的一员，也可作为 `skill_manage` 默认写入位置 | 在 `.aether` 阶段按来源 `order` 参与合并，晚于项目 `.aether` | home 目录扫描 |
| `~/.opencode/skills/**/SKILL.md` | 支持 | home 目录下的 `.opencode` 属于 `Config.directories()` 的一员 | 在非 `.aether` 配置根阶段参与合并，晚于项目 `.opencode`，早于 `skills.paths` | legacy home 目录扫描 |
| `OPENCODE_CONFIG_DIR/{skill,skills}/**/SKILL.md` | 支持 | `OPENCODE_CONFIG_DIR` 属于 `Config.directories()`；basename 为 `.aether` 时进入 `.aether` 阶段，否则进入非 `.aether` 配置根阶段 | 由它在对应阶段中的 `order` 决定；通常晚于 home `.opencode`，早于 `skills.paths`，若 basename 为 `.aether` 则晚于 home `.aether` | 可选环境变量 |
| 默认 skills 父级 `.aether/{skill,skills}/**/SKILL.md` | 支持 | 若 `Config.getDefaultSkillsDir()` 命中，程序最后还会扫描该默认目录父级下的 `.aether` 根 | 在当前 skills 装载链最后参与合并；同名时可能覆盖前面所有候选 | 主要用于打包目录或本地仓库中的 `.aether` skills |
| `config.skills.paths` | 支持 | 每个目录递归扫描 `**/SKILL.md` | 晚于 `.opencode` skills，早于 `.aether` skills | 相对路径相对当前项目目录 |
| `config.skills.urls` | 支持 | 拉取远端索引到缓存目录后再扫描 `**/SKILL.md` | 晚于 `skills.paths`，早于 `.aether` skills；同名继续后发现覆盖 | 属于当前四类能力里唯一内建远端发现 |
| `config.skills.disabled` | 支持 | 存储并匹配 skill 目录绝对路径 | 跳过被禁用的具体候选路径；同名低优先级候选可 fallback | 旧的 name-based 条目不会匹配运行时路径 |
| `metadata.hermes.requires_tools` 等条件 | 支持 | 解析为 `conditions` 后，在系统提示构建时按当前工具集合过滤 | 只影响系统提示注入列表；`Skill.available()` 本身只按 permission 过滤 | 包含 `requires_tools`、`requires_toolsets`、`fallback_for_tools`、`fallback_for_toolsets` |
| `platforms` frontmatter | 部分支持 | 会解析并保存在 skill 信息中 | 当前未参与 `Skill.available()` 或系统提示过滤 | 代码中有平台匹配函数，但没有接入可用性过滤路径 |
| skill 自动暴露为 command | 支持，但属于 command 侧行为 | skill 装好后，命令层再把 skill 注册成同名 command | 不改变 skill 本身覆盖规则 | 这是跨能力映射，不是 skill 发现来源 |

补充说明：

1. `skills` 是四类能力里兼容最丰富的一类，既支持默认内置 skills、外部生态目录，也支持 `.aether` / `.opencode`、本地附加路径和远端 URL。
2. skill 的主键是 frontmatter 的 `name`，不是目录名，也不是文件夹名。
3. `SKILL.md` 正文会同时作为 skill content 保留；后续若被自动暴露为 command，则正文会变成该 command 的模板。
4. 上表只说明“哪些路径会在扫描时被纳入候选”。运行中是否会自动看到新增、删除、修改后的 skill，取决于 2.4 到 2.7 描述的内存缓存、磁盘快照、watcher 与主动缓存清理机制。

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
| `packages/opencode/src/skill/index.ts` | skill 主发现器、global/project 快照、watcher、禁用路径过滤、可用性过滤 | skills |
| `packages/opencode/src/skill/discovery.ts` | 远端 `skills.urls` 下载与缓存 | skills |
| `packages/opencode/src/skill/seed.ts` | 默认 skills 的启动期种子复制与 manifest 记录 | skills |
| `packages/opencode/src/tool/skill-manage.ts` | skill 创建、编辑、patch、删除、回滚与 shadow `.aether/skills` 写入 | skills |
| `packages/opencode/src/tool/skill-versions.ts` | skill 版本快照、历史列表与回滚 bundle | skills |
| `packages/opencode/src/tool/skill-guard.ts` | agent-created skill 的安全扫描 | skills |
| `packages/opencode/src/session/skill-evolution.ts` | 会话后 skill review、后台演化与 `skill.saved` 事件 | skills |
| `packages/opencode/src/session/skill-dirty.ts` | 记录会话中被修改的 skill 名称 | skills |
| `packages/opencode/src/session/skill-refresh.ts` | 将 dirty skill 的最新正文注入后续提示 | skills |
| `packages/opencode/src/effect/instance-state.ts` | 按当前 `Instance.directory` 缓存运行时状态，并在 instance dispose / reload 时失效 | skills, commands, subagents 等运行时状态 |
| `packages/opencode/src/project/instance.ts` | 建立当前目录 instance，提供 `directory` / `worktree` 上下文，并实现 `dispose` / `reload` / `disposeAll` | skills, commands, subagents, rules |
| `packages/opencode/src/server/server.ts` | 服务端请求入口；根据请求目录建立 instance，并提供 `/instance/dispose` | skills |
| `packages/opencode/src/server/routes/config.ts` | 配置、默认 skills、evolution skills 列表与 skill toggle API | skills |
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
| `packages/opencode/test/config/config.test.ts` | config 合并优先级、commands/agents/instructions 等装载测试 | commands, subagents, rules |
| `packages/opencode/test/session/instruction.test.ts` | `AGENTS.md`/全局 rules 优先级测试 | rules |
| `packages/opencode/test/permission-task.test.ts` | permission.task 与最后匹配生效测试 | rules |

## 9. 最终结论

当前程序对用户自定义 `skills`、`commands`、`subagents`、`指令型 rules` 都是支持的，但这四者并不是四套完全对称的插件系统：

1. `skills` 的发现机制最丰富，支持默认内置、本地、外部目录、额外路径、远端 URL，并带有 skill 专用 watcher 与缓存失效机制。
2. `commands` 与 `subagents` 主要依附统一 config roots 扫描；该扫描现同时搜索 `.aether` 和 `.opencode`，且还包含 home 目录和 binary 目录。
3. `rules` 的核心不是“任意 rules 目录自动接入”，而是固定的 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` + `instructions`。
4. IDE 生态的 `.cursor/rules`、`.windsurf/rules.md`、`.github/copilot-instructions.md` 当前不会被核心运行时自动扫描，只能通过人工汇总进 `AGENTS.md` 或 `config.instructions` 来间接纳入。
5. 项目已从 `opencode` 品牌迁移至 `aether` 品牌。多数配置扫描逻辑采取“双名并行”策略：`.aether` 和 `.opencode`（`aether.*` 和 `opencode.*`）同时被搜索和装载。commands 与 subagents 在同一层级中通常是 `.opencode` 版同名定义覆盖 `.aether` 版；skills 的装载链有专门排序，`.aether` skills 会在 `skills.paths` / `skills.urls` 之后参与合并，因此演化后的 `.aether` skill 通常拥有更高覆盖权。项目级迁移代码（仅覆盖 skills 子目录）已定义但未激活。
