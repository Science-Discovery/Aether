# Aether Skill 加载机制

Aether 的 skill 加载机制负责在每次项目实例初始化时，将来自多个来源的 `SKILL.md` 文件合并成一张统一的 skill 注册表，供 AI 在对话中按需调用。加载结果按项目实例缓存在内存中，远程 skill 则额外缓存在本地磁盘。

---

## 目录

- [整体流程](#整体流程)
- [扫描来源与优先级](#扫描来源与优先级)
- [内存缓存机制（InstanceState）](#内存缓存机制instancestate)
- [执行时重读机制（SkillTool）](#执行时重读机制skilltool)
- [远程 Skill 的磁盘缓存（Discovery）](#远程-skill-的磁盘缓存discovery)
- [Default Skills（内置 Skill）](#default-skills内置-skill)
- [可用性过滤与权限](#可用性过滤与权限)
- [关键文件速查](#关键文件速查)

---

## 整体流程

Skill 加载由 Effect Layer 机制驱动，依附于项目实例的生命周期。整个流程分两个阶段：**按需初始化**（首次访问时扫描磁盘）和**执行时重读**（tool 调用时从磁盘取最新内容）。

```
项目实例创建（Instance.provide）
        │
        │  Skill.layer 作为 Effect Layer 挂载，
        │  其内部状态由 InstanceState（ScopedCache）管理
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  首次调用 Skill.all() / Skill.get() / Skill.available() 时   │
│  ScopedCache 检查当前 Instance.directory 是否已有缓存          │
│  （同一项目实例生命周期内只初始化一次）                          │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌─────────────────────────────────────────────┐
               │  Instance.directory 已有缓存？             │
               │  （即当前打开的项目目录，如 /home/foo/proj） │
               └───────────┬─────────────────────────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
              直接返回       执行 loadSkills()
              内存中的       按优先级扫描所有来源
              State          填充 state.skills
                   \               │
                    \              ▼
                     \   禁用列表过滤：
                      \  删除 cfg.skills.disabled 中的条目
                       \       │
                        └──────┘
                               │
                               ▼
                  skill 注册表就绪，
                  供对话中的 skill tool 调用
```

---

## 扫描来源与优先级

`loadSkills()` 按**低优先级→高优先级**的顺序依次扫描，后扫描的同名 skill 覆盖先扫描的。

```
──────────────────────────────────────────────────────────────────────
优先级 1（最低）：全局外部目录
──────────────────────────────────────────────────────────────────────

扫描 ~/.agents/、~/.claude/、~/.opencode/、~/.aether/ 中的
skills/**/SKILL.md
（EXTERNAL_DIRS 的顺序即优先级：.agents 最低，.aether 最高）

作用：用户在 home 目录放置的个人全局 skill，对所有项目生效

──────────────────────────────────────────────────────────────────────
优先级 2：AI 后台生成的 skill（项目级，优先级最低的项目来源）
──────────────────────────────────────────────────────────────────────

扫描 ~/.aether/skill-sessions/<projectId>/skills/ 中的 **/SKILL.md

作用：skill 自进化系统后台评审后自动写入的 skill，
      仅对当前项目可见，优先级刻意低于用户手动放置的内容，
      防止 AI 自动生成结果意外覆盖用户预期

──────────────────────────────────────────────────────────────────────
优先级 3：项目外部目录（项目目录 → worktree 路径向上遍历）
──────────────────────────────────────────────────────────────────────

从 directory 向上遍历到 worktree，
收集沿途的 .agents/、.claude/、.opencode/、.aether/ 目录，
反转后依序扫描，使内层（靠近 directory）的同名 skill 优先级更高

示例：
  /project/.aether/skills/foo/SKILL.md     ← 最高（内层 .aether）
  /project/.opencode/skills/foo/SKILL.md
  /project/.claude/skills/foo/SKILL.md
  /project/.agents/skills/foo/SKILL.md     ← 最低（内层 .agents）
  /worktree/.aether/skills/foo/SKILL.md    ← 比所有 directory 内来源优先级低

作用：项目团队共享的 skill（提交到代码仓库中）

──────────────────────────────────────────────────────────────────────
优先级 4：Config.directories() 中的配置目录
──────────────────────────────────────────────────────────────────────

遍历 Config.directories() 返回的目录列表，
扫描 {skill,skills}/**/SKILL.md

特别处理：已在优先级 1 扫描过的全局家目录（~/.*）被排除，
          防止这些目录再次参与扫描而错误覆盖项目级 skill

──────────────────────────────────────────────────────────────────────
优先级 5：cfg.skills.paths 自定义路径
──────────────────────────────────────────────────────────────────────

读取 opencode.json 中 skills.paths 字段，
支持 ~/ 展开和相对路径解析（相对于 directory），
扫描 **/SKILL.md

作用：允许用户将 skill 目录放在任意位置并在配置中显式声明

──────────────────────────────────────────────────────────────────────
优先级 6（最高）：cfg.skills.urls 远程注册表
──────────────────────────────────────────────────────────────────────

调用 Discovery.pull(url) 从远程拉取 skill 文件，
下载缓存到本地磁盘后，扫描缓存目录

（详见「远程 Skill 的磁盘缓存」章节）
```

所有来源扫描完成后，统一执行禁用列表过滤：

```
所有来源扫描完毕，state.skills 已填充
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  读取 cfg.skills.disabled 列表                                │
│  对列表中的每个 name，若 state.skills[name] 存在则删除         │
│  并写入日志 "skill disabled by config"                        │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
skill 注册表最终版本，等待内存缓存
```

---

## 内存缓存机制（InstanceState）

这是加载机制中最核心的内存管理部分。Skill 状态通过 `InstanceState`（底层为 Effect 的 `ScopedCache`）缓存在内存中，实现按项目隔离、懒加载、实例销毁时自动失效。

### 缓存结构

```
InstanceState<State>
        │
        └── ScopedCache<string, State>
                    │
                    key = Instance.directory（项目绝对路径）
                    │
                    每个项目实例维护一份独立的 State：
                    ┌────────────────────────────────────┐
                    │  State {                           │
                    │    skills: Record<name, Info>      │
                    │    dirs:   Set<string>             │
                    │  }                                 │
                    │                                    │
                    │  Info {                            │
                    │    name:     string                │
                    │    description: string             │
                    │    location: string  ← 磁盘绝对路径 │
                    │    content:  string  ← 扫描时读取  │
                    │  }                                 │
                    └────────────────────────────────────┘
```

### 缓存生命周期

```
首次调用 Skill.available() 或其他方法
        │
        │  此时 ScopedCache 中尚无当前目录的记录
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  执行 loadSkills()：遍历所有来源，读取 SKILL.md，填充 State    │
│  （I/O 密集操作，可能耗时数百毫秒，取决于 skill 数量）          │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  State 写入 ScopedCache，key = 当前 Instance.directory        │
│  后续同一实例的所有调用直接从内存读取，不再访问磁盘             │
└──────────────────────────────────────────────────────────────┘

        ─ ─ ─ ─ ─ ─ ─（对话正常进行中）─ ─ ─ ─ ─ ─ ─

项目实例销毁（Instance.dispose 被调用）
        │
        │  Skill.layer 在 Effect Scope 结束时
        │  通过 registerDisposer 回调自动触发
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  ScopedCache.invalidate(directory)                           │
│  内存中当前目录的 State 被清除                                 │
│  下次访问将重新扫描磁盘（捕获期间发生的文件变化）               │
└──────────────────────────────────────────────────────────────┘
```

**重要限制**：缓存不监听文件系统事件。在同一实例生命周期内（通常对应一次 Aether 启动），新增或删除 `SKILL.md` 文件不会被自动感知。Skill 自进化系统通过 `shadow-writer.ts` 写入后主动调用 `InstanceState.invalidate` 来使缓存失效，从而绕过这一限制。

---

## 执行时重读机制（SkillTool）

`InstanceState` 中缓存的 `Info.content` 是扫描时读取的快照。但 `skill` tool 在每次被调用时，会**绕过缓存，从磁盘重新读取 `SKILL.md`**，以确保 AI 拿到的是最新内容。

```
AI 调用 skill tool（params.name = "check-pr"）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  Skill.get(name)：从 InstanceState 中取出 Info               │
│  主要目的是获取 Info.location（磁盘绝对路径）                  │
│  以及判断 skill 是否存在                                      │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  skill 存在且文件可访问？  │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
┌──────────────────────────┐  向 AI 返回错误：
│  权限检查                 │  "Skill not found.
│  ctx.ask(permission:     │   Available skills: ..."
│    "skill", [name])      │
└──────────────┬───────────┘
               │
               ▼
┌──────────────────────────────────────────────────────────────┐
│  ConfigMarkdown.parse(skill.location)                        │
│  从磁盘重新读取 SKILL.md                                      │
│  ← 不使用 Info.content（扫描时的缓存），直接读磁盘             │
│  ← 这意味着修改 SKILL.md 内容后无需重启，下次 tool 调用即生效  │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  用 ripgrep 扫描 skill 目录，最多列出 10 个附属文件            │
│  （脚本、模板、参考资料等，SKILL.md 本身排除）                  │
│  提供给 AI 以便它能读取 skill 携带的辅助资源                   │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
封装成 <skill_content name="..."> 块返回给 AI，
其中包含完整的 skill 指令、基础目录路径、附属文件列表
```

两级内存的分工：

```
InstanceState（内存缓存）        SkillTool（执行时）
─────────────────────────       ─────────────────────────
存储：name, description,         使用：location（路径）
      location, content          重读：SKILL.md 最新内容
作用：快速列出可用 skill，         作用：保证 AI 拿到最新版本，
      供 fmt() 生成摘要注入        支持热修改（不重启生效）
      system prompt
```

---

## 远程 Skill 的磁盘缓存（Discovery）

通过 `cfg.skills.urls` 配置的远程 skill 注册表，由 `Discovery` 模块负责拉取，并将文件缓存到本地磁盘。本地磁盘缓存在进程重启后依然有效，相同文件不重复下载。

```
loadSkills() 处理 cfg.skills.urls 中的每个 URL
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  GET {url}/index.json                                        │
│  期望格式：                                                   │
│  { skills: [{ name: string, files: string[] }, ...] }        │
│  files 列表必须包含 "SKILL.md"，否则该条目被跳过              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
对 index 中每个有效 skill，并发（最多 4 个）处理：

┌──────────────────────────────────────────────────────────────┐
│  对 skill 的每个文件（并发最多 8 个）：                         │
│  dest = ~/.cache/aether/skills/<name>/<file>                 │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  dest 文件已存在？                                    │    │
│  └──────────┬──────────────────────────────────────────┘    │
│       是 /    \ 否                                           │
│      /          \                                           │
│     ▼            ▼                                          │
│  跳过下载     从远端 GET 下载，写入 dest                       │
│  （幂等，     失败时记录 error 日志，跳过该文件               │
│   保证缓存     不抛异常，其他 skill 继续处理）                  │
│   稳定性）                                                   │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  检查 dest/SKILL.md 是否存在                                   │
│  存在 → 将该缓存目录加入返回列表，后续由 scan() 扫描            │
│  不存在 → 下载失败，跳过该 skill                               │
└──────────────────────────────────────────────────────────────┘
```

磁盘缓存的特点：

```
~/.cache/aether/skills/
  └── <skill-name>/
        ├── SKILL.md              ← 永久保留直到手动删除
        └── （其他 skill 附属文件）

缓存策略：只新增，不更新，不过期
  ─ 远端 skill 内容更新时，本地旧版本不会自动覆盖
  ─ 需手动删除缓存目录后重启，才会重新下载最新版本
  ─ 网络不可用时，只要缓存目录存在，skill 仍可正常加载
```

---

## Default Skills（内置 Skill）

服务器启动时，通过 `findServerSkillsDirSync()` **同步、一次性**地确定内置 skill 目录，结果存为进程级常量，整个进程生命周期内不再变化。

```
Node.js 进程启动（模块加载时同步执行）
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  检查可执行文件同级目录（打包发布场景）：                         │
│  path.dirname(process.execPath) + /{.opencode,.aether}/skills/│
│  ← 适用于 macOS/Windows 打包后的单一可执行文件发布              │
│     skill 文件随二进制一起打包在相邻目录                        │
└──────────────────────────┬───────────────────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │  找到有效目录？            │
               └───────────┬──────────────┘
                     是 /    \ 否
                    /          \
                   ▼            ▼
          返回该目录       从 process.cwd() 向上遍历，
          赋值给           逐级检查 {.opencode,.aether}/skills/
          _serverSkillsDir  直到文件系统根目录
          （进程级常量）    ← 适用于 CLI / 开发环境，
                              从当前工作目录找到项目根
                               │
                    ┌──────────▼──────────┐
                    │  找到有效目录？       │
                    └──────────┬──────────┘
                         是 /    \ 否
                        /          \
                       ▼            ▼
              返回该目录         _serverSkillsDir = undefined
              赋值给             listDefaultSkills() 返回 []
              _serverSkillsDir
```

`listDefaultSkills()` / `saveDefaultSkill()` / `deleteDefaultSkill()` 均基于这个常量路径操作，供 UI 的「内置 skill 管理」功能使用。

---

## 可用性过滤与权限

`Skill.available(agent?)` 在返回 skill 列表前，会根据 agent 的权限配置进行过滤：

```
Skill.available(agent?) 被调用
        │
        ▼
从 InstanceState 取出全部 skills，
按 name 字母序排序（保证列表顺序稳定）
        │
        ▼
┌───────────────────────────────────┐
│  传入了 agent 参数？               │
└──────────────┬────────────────────┘
         是 /    \ 否
        /          \
       ▼            ▼
对每个 skill：      返回全部
Permission.evaluate(
  "skill",
  skill.name,
  agent.permission
)
       │
  ┌────┴──────────────┐
  │  evaluate 结果？   │
  └────┬──────────────┘
deny /   \ 其他（allow / ask / ...）
    /      \
   ▼        ▼
 过滤掉    保留，
 不可用    返回给调用方
```

权限配置示例（opencode.json）：

```
{
  "permission": {
    "skill": {
      "check-pr": "allow",
      "huashu-design": "deny"   ← 该 agent 看不到此 skill
    }
  }
}
```

---

## 关键文件速查

| 文件 | 职责 |
|------|------|
| [packages/opencode/src/skill/index.ts](packages/opencode/src/skill/index.ts) | 主加载逻辑、InstanceState 缓存、优先级扫描、available() 过滤 |
| [packages/opencode/src/skill/discovery.ts](packages/opencode/src/skill/discovery.ts) | 远程 URL 拉取与磁盘缓存 |
| [packages/opencode/src/tool/skill.ts](packages/opencode/src/tool/skill.ts) | skill tool：执行时重读磁盘、权限检查、附属文件列举 |
| [packages/opencode/src/config/config.ts:1464](packages/opencode/src/config/config.ts#L1464) | Default skills 目录查找（`findServerSkillsDirSync`，进程级常量） |
| [packages/opencode/src/effect/instance-state.ts](packages/opencode/src/effect/instance-state.ts) | InstanceState / ScopedCache 实现 |
| [packages/opencode/src/config/paths.ts](packages/opencode/src/config/paths.ts) | `Config.directories()` 配置目录枚举 |
