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

### 2.1 是否支持

支持用户自定义 skills。

### 2.2 扫描路径

按实际装载顺序，低到高为：

1. 全局外部 skills
   - `~/.claude/skills/**/SKILL.md`
   - `~/.agents/skills/**/SKILL.md`
2. 项目内外部 skills
   - 从当前目录向上到 `worktree` 查找：
   - `.claude/skills/**/SKILL.md`
   - `.agents/skills/**/SKILL.md`
3. 配置目录内的 skills
   - 对每个 `Config.directories()` 根目录扫描：
   - `{skill,skills}/**/SKILL.md`
   - 典型路径如：
     - `.aether/skill/**/SKILL.md`
     - `.aether/skills/**/SKILL.md`
     - `.opencode/skill/**/SKILL.md`
     - `.opencode/skills/**/SKILL.md`
   - 注意：`Config.directories()` 还包含 home 目录下的 `.aether` / `.opencode` 以及 binary 目录下的 `.aether` / `.opencode`，这些都属于此阶段的扫描源
4. `config.skills.paths`
   - 每个目录扫描 `**/SKILL.md`
   - 相对路径相对于当前项目目录
5. `config.skills.urls`
   - 拉取远端 `index.json`
   - 下载到缓存目录后再扫描
6. `config.skills.disabled`
   - 最后按技能名删除

### 2.3 覆盖规则

1. skill 以 frontmatter 的 `name` 为主键。
2. 同名 skill 后发现者覆盖先前 skill。
3. `skills.disabled` 在最后执行，因此拥有最终关闭权。
4. 若启用 `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`，则 `.claude` / `.agents` 外部 skill 来源整体失效。
   需要注意级联关系：`OPENCODE_DISABLE_CLAUDE_CODE` 是总开关，为 true 时会隐式激活 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`，进而隐式激活 `OPENCODE_DISABLE_EXTERNAL_SKILLS`，所以设置 `OPENCODE_DISABLE_CLAUDE_CODE=true` 也等同于关闭外部 skills。

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
| skills | 支持 | 外部目录 + `.aether` / `.opencode/{skill,skills}` + `skills.paths` + `skills.urls` | 同名后加载覆盖先加载；`skills.disabled` 最终删除 |
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
| `~/.claude/skills/**/SKILL.md` | 支持 | `Skill.loadSkills()` 显式扫描全局外部目录 `.claude` | 在 skills 装载链最前部之一；同名后发现覆盖先发现 | 可被 `OPENCODE_DISABLE_EXTERNAL_SKILLS` 或 `OPENCODE_DISABLE_CLAUDE_CODE` 整体关闭 |
| `~/.agents/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `~/.claude/skills` 同级 |
| 项目内 `.claude/skills/**/SKILL.md` | 支持 | 从当前目录向上到 `worktree`，逐级找 `.claude` 后扫描其 `skills/**/SKILL.md` | 在外部 skills 阶段按发现顺序覆盖 | 这是显式目录兼容，不是偶然命中 |
| 项目内 `.agents/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与项目内 `.claude/skills` 同级 |
| `.aether/skill/**/*.md` | 不支持 | 无此模式 | 不参与 | skills 只认 `SKILL.md` 文件名，不认任意 markdown |
| `.aether/skill/**/SKILL.md` | 支持 | 对每个 `Config.directories()` 根目录扫描 `{skill,skills}/**/SKILL.md` | 晚于外部 skills，故可覆盖前面同名 skill；同层级 `.aether` 在 `.opencode` 之前 yield，同名时 `.opencode` 覆盖权更高 | 新品牌目录名 |
| `.aether/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `.opencode/skill/**/*.md` | 不支持 | 无此模式 | 不参与 | skills 只认 `SKILL.md` 文件名，不认任意 markdown |
| `.opencode/skill/**/SKILL.md` | 支持 | 同上扫描方式 | 晚于外部 skills；同层级 `.opencode` 在 `.aether` 之后 yield，覆盖权更高 | legacy 目录名 |
| `.opencode/skills/**/SKILL.md` | 支持 | 同上 | 同上 | 与 `skill/` 等价 |
| `~/.aether/skills/**/SKILL.md` | 支持 | home 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于项目级之后 | home 目录扫描 |
| `~/.opencode/skills/**/SKILL.md` | 支持 | home 目录下的 `.opencode` 属于 `Config.directories()` 的一员 | 同上 | legacy home 目录扫描 |
| `<binaryDir>/.aether/skills/**/SKILL.md` | 支持 | binary 目录下的 `.aether` 属于 `Config.directories()` 的一员 | 在 directories 列表中位于 home 目录之后 | 打包发行版专用 |
| `<binaryDir>/.opencode/skills/**/SKILL.md` | 支持 | 同上 | 同上 | legacy 打包发行版 |
| `config.skills.paths` | 支持 | 每个目录递归扫描 `**/SKILL.md` | 晚于 `.aether` / `.opencode` skills | 相对路径相对当前项目目录 |
| `config.skills.urls` | 支持 | 拉取远端索引到缓存目录后再扫描 `**/SKILL.md` | 晚于本地路径；同名继续后发现覆盖 | 属于当前四类能力里唯一内建远端发现 |
| `config.skills.disabled` | 支持 | 在 skills 全部装载完成后按名字删除 | 拥有最终关闭权 | 优先级高于前面所有来源 |
| skill 自动暴露为 command | 支持，但属于 command 侧行为 | skill 装好后，命令层再把 skill 注册成同名 command | 不改变 skill 本身覆盖规则 | 这是跨能力映射，不是 skill 发现来源 |

补充说明：

1. `skills` 是四类能力里兼容最丰富的一类，既支持外部生态目录，也支持 `.aether` / `.opencode`、本地附加路径和远端 URL。
2. skill 的主键是 frontmatter 的 `name`，不是目录名，也不是文件夹名。
3. `SKILL.md` 正文会同时作为 skill content 保留；后续若被自动暴露为 command，则正文会变成该 command 的模板。

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

1. `skills` 的发现机制最丰富，支持本地、外部目录、额外路径、远端 URL。
2. `commands` 与 `subagents` 主要依附统一 config roots 扫描；该扫描现同时搜索 `.aether` 和 `.opencode`，且还包含 home 目录和 binary 目录。
3. `rules` 的核心不是“任意 rules 目录自动接入”，而是固定的 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` + `instructions`。
4. IDE 生态的 `.cursor/rules`、`.windsurf/rules.md`、`.github/copilot-instructions.md` 当前不会被核心运行时自动扫描，只能通过人工汇总进 `AGENTS.md` 或 `config.instructions` 来间接纳入。
5. 项目已从 `opencode` 品牌迁移至 `aether` 品牌。所有扫描逻辑采取“双名并行”策略：`.aether` 和 `.opencode`（`aether.*` 和 `opencode.*`）始终同时被搜索和装载。项目级迁移代码（仅覆盖 skills 子目录）已定义但未激活。同一层级中 `.opencode` 版同名定义拥有更高覆盖权。
