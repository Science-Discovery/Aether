# Skill 系统架构

本文档描述 `feat/skill-evolution` 分支实现的 Skill 系统，包括技能加载、缓存机制、自进化流程，以及与 Hermes 参考实现的对比。

---

## 1. 整体架构

Skill 系统由三个主要部分构成：

1. **技能加载与缓存** — 扫描磁盘上的 SKILL.md 文件，缓存到内存，供系统 prompt 使用
2. **技能管理工具** — `skill_manage` 工具，允许 AI 对技能进行 CRUD 操作
3. **自进化流程** — 对话结束后自动触发后台评审 Agent，将有价值的经验保存为技能

```
┌──────────────────────────────────────────────────────────────┐
│                        用户发消息                              │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│               构建系统 prompt（每个 LLM 步骤）                 │
│                                                              │
│   Skill.available() → 技能列表 → 注入 <available_skills>      │
│   仅展示 name + description，不暴露文件路径                    │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                    LLM 执行工具调用                            │
│                                                              │
│   调用 skill(name)      → 加载技能内容，web 端显示标签          │
│   调用 skill_manage(…)  → 创建/修改/删除技能                   │
│   其他工具调用          → 步骤计数器 +1                        │
└─────────────────────────┬────────────────────────────────────┘
                          │ 对话正常结束 & 计数器达到阈值
                          ▼
┌──────────────────────────────────────────────────────────────┐
│              后台评审 Agent（独立 session）                    │
│                                                              │
│   读取完整对话历史 → 判断是否值得保存                           │
│   调用 skill_manage(create/patch) → 写入磁盘                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 技能加载与缓存机制

缓存分两层，目的是在保证数据新鲜度的同时尽量减少磁盘 I/O。

```
调用 Skill.available()
        │
        ▼
┌───────────────────────────────────────────────────┐
│  Layer 1：InstanceState（内存，per 项目目录）        │
│                                                   │
│  key = Instance.directory（当前项目路径）           │
└───────────┬───────────────────────────────────────┘
            │
     ┌──────▼──────┐
     │  内存命中？  │
     └──────┬──────┘
       是 /   \ 否
      /         \
     ▼           ▼
  直接返回    loadSkills()
  （零 I/O）       │
                   ▼
        ┌──────────────────────────────────────────────┐
        │  Layer 2：磁盘快照校验（global + project）   │
        │                                              │
        │  buildSkillsManifest(globalDirs)             │
        │  buildSkillsManifest(projectDirs)            │
        └──────────┬───────────────────────────────────┘
                   │
           ┌───────▼────────┐
           │ global 快照有效？│
           └───────┬────────┘
             是 /    \ 否
            /          \
           ▼            ▼
     读 global 快照   扫描 global 来源并回写 global 快照
                   │
           ┌───────▼─────────┐
           │ project 快照有效？│
           └───────┬─────────┘
             是 /    \ 否
            /          \
           ▼            ▼
    读 project 快照   扫描 project 来源并回写 project 快照
                   │
                   ▼
            mergeSkills(global, project)
            → 同名后者覆盖前者（保留扫描顺序语义）
                   │
                   ▼
            结果存入 InstanceState
            （本次对话后续调用走 Layer 1）
```

### 2.1 Layer 1：InstanceState（内存缓存）

`InstanceState` 是 Effect 框架的 per-项目缓存原语，以项目目录路径为 key：

- **同一项目**：第一次调用触发加载，后续调用直接读内存，零 I/O
- **切换项目**：`Instance.dispose()` 自动释放旧项目缓存，新项目重新加载
- **手动刷新**：`skill_manage` 的 `create/edit/patch/delete` 成功后会调用 `clearSkillsPromptCache()`，使缓存失效

`clearSkillsPromptCache()` 当前行为：

- 遍历当前进程的所有活动实例目录（`Instance.dirs()`）
- 在每个目录上下文中执行 `skill.invalidate()`
- 只清 Skill 的 `InstanceState`，不会销毁项目实例，也不会清其他模块状态
- 默认 `clearSnapshot=false`，仅清内存；显式传 `true` 才删除磁盘快照

> **限制：直接编辑 SKILL.md 文件不会自动刷新内存缓存。**
>
> 通过 `skill_manage` 修改技能时，工具会主动调用 `clearSkillsPromptCache()` 使内存失效，一切正常。
> 但如果直接用编辑器修改 SKILL.md，Layer 2 快照会在下次 manifest 校验时检测到 mtime 变化并更新，
> 而 Layer 1 内存缓存**不会感知到文件变化**，当前进程仍然使用旧数据。
> 需要重启 Aether 进程或切换项目目录才能强制刷新内存。

### 2.2 Layer 2：磁盘快照

快照文件路径已拆分为两类：

- global：`~/.cache/aether/.skills_prompt_snapshot.global.json`
- project：`~/.cache/aether/skills-prompt/<slug>.<hash>.json`

快照存储内容：

```json
{
  "version": 2,
  "manifest": {
    "/path/to/SKILL.md": [mtime毫秒, 字节数],
    ...
  },
  "skills": [ ...完整的 Info 对象数组... ]
}
```

校验逻辑：分别对 global/project 两套来源构建 manifest（mtime + size）并与各自快照比对。任何文件被修改、新增、删除都会导致对应 scope 的 miss，仅重扫对应 scope。

快照的价值在于**跨进程重启的持久化**：重启后 InstanceState 为空，但如果磁盘文件没有变化，可以直接从快照恢复，避免重新解析所有 SKILL.md。

### 2.3 扫描顺序与优先级

`loadSkillsFromDirs()` 按以下顺序扫描，**后扫描的覆盖先扫描的同名技能**（项目级优先于全局级）：

| 顺序 | 来源                         | 路径示例                                      |
| ---- | ---------------------------- | --------------------------------------------- |
| 1    | managed（skill_manage 创建） | `~/.local/share/aether/skills/`               |
| 2    | global                       | `~/.claude/skills/`、`~/.agents/skills/`      |
| 3    | project                      | `your-project/.claude/skills/` 向上查找       |
| 4    | config                       | `~/.config/aether/skills/`、`.aether/skills/` |
| 5    | custom paths                 | `config.skills.paths` 自定义路径              |
| 6    | url skills                   | `config.skills.urls` 远程拉取                 |

同名去重发生在加载阶段，以 `name` 字段为 key 写入 map，LLM 看到的列表中每个名字只有一个。

---

## 3. 系统 Prompt 中的技能展示

技能列表注入到系统 prompt 时，只包含 `name` 和 `description`，**不包含文件路径**：

```xml
<available_skills>
  <skill>
    <name>build-flow-analyzer</name>
    <description>Analyze a project's build/packaging workflow…</description>
  </skill>
</available_skills>
```

不暴露路径的原因：若 LLM 知道文件路径，会倾向于直接用文件读取工具读取内容，绕过 `skill` 工具，导致 web 端"使用技能"标签无法显示。去掉路径后，LLM 只能通过 `skill(name)` 工具加载技能内容，标签正常渲染。

---

## 4. skill 工具 vs skill_manage 工具

|          | `skill`                   | `skill_manage`                |
| -------- | ------------------------- | ----------------------------- |
| 用途     | 加载并使用技能内容        | 创建/修改/删除技能            |
| 触发标签 | 是（web 端"使用技能"）    | 是（web 端显示 action: name） |
| 数据来源 | 内存缓存（InstanceState） | 磁盘（直接写文件）            |

`skill_manage` 支持的 action：

| action        | 说明                                           |
| ------------- | ---------------------------------------------- |
| `create`      | 创建新技能目录和 SKILL.md                      |
| `edit`        | 全量覆写 SKILL.md                              |
| `patch`       | 局部 find-and-replace（推荐，支持 fuzzy 匹配） |
| `delete`      | 删除整个技能目录                               |
| `write_file`  | 写入 references/templates/scripts 等支撑文件   |
| `remove_file` | 删除支撑文件                                   |

`skill_manage` 的 `create/edit/patch/delete` 成功后会自动调用 `clearSkillsPromptCache()`，使 Skill 的 InstanceState 失效；`write_file/remove_file` 当前不触发该失效。

---

## 5. Skill 自进化流程

### 5.1 触发条件

每次 LLM 返回含工具调用的回复后，步骤计数器 `_iters_since_skill` +1。满足以下所有条件时触发后台评审：

- 计数器 ≥ 阈值（默认 10，可通过 `config.skills.creation_nudge_interval` 配置）
- `skill_manage` 工具在当前 agent 的工具集中
- 对话正常结束（`final_response = true`）
- 未被用户中断（`abort.aborted = false`）
- 当前不是评审 session 本身（防止递归触发）

调用 `skill_manage` 时，计数器会先重置为 0，再在同一步骤末尾统一 +1，因此该步结束后的净值为 1（与 Hermes 对齐）。

```
用户对话进行中
      │
      ▼ 每个 LLM 步骤（含工具调用）
_iters_since_skill += 1
      │
      ▼ 调用了 skill_manage？
     是 → _iters_since_skill = 0
      │
      ▼ 对话结束后检查
_iters_since_skill >= 阈值
  AND skill_manage 可用
  AND final_response
  AND not aborted
      │
      ├─ 否 → 不触发评审
      │
      └─ 是 → _iters_since_skill = 0（立即重置）
               │
               ▼
           spawn 后台评审 session
```

### 5.2 后台评审流程

```
后台评审 session 启动
      │
      ▼
传入完整对话历史 + SKILL_REVIEW_PROMPT：
  "Review the conversation... save or update a skill if appropriate."
      │
      ▼
评审 Agent 分析对话（最多 8 步）
      │
      ├─ 有价值 → 调用 skill_manage(create/patch)
      │                │
      │                ▼
      │            写入 ~/.local/share/aether/skills/
      │                │
      │                ▼
      │            日志：[skill review] AI原话
      │                  [skill review] 💾 create: skill-name
      │
      └─ 无价值 → 日志：[skill review] Nothing to save.
```

评审 session 的 `_iters_since_skill` 阈值设为 0，防止评审 Agent 再次触发评审形成递归。

### 5.3 评审提示词（SKILL_REVIEW_PROMPT）

```
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial and error,
or changing course due to experiential findings along the way, or did the user expect or
desire a different method or outcome?

If a relevant skill already exists, update it with what you learned.
Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, just say 'Nothing to save.' and stop.
```

### 5.4 系统 Prompt 中的引导（SKILLS_GUIDANCE）

每次对话的系统 prompt 都注入以下引导，主动推动 AI 保存技能：

```
After completing a complex task (5+ tool calls), fixing a tricky error,
or discovering a non-trivial workflow, save the approach as a skill with
skill_manage so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong,
patch it immediately with skill_manage(action='patch') — don't wait to be asked.
Skills that aren't maintained become liabilities.
```

---

## 6. SKILL.md 文件格式

```markdown
---
name: "my-skill"
description: "一句话描述这个技能的用途"
platforms: ["linux", "macos"] # 可选，平台过滤
metadata:
  hermes:
    requires_tools: ["mcp_database"] # 可选，需要这些工具才显示
    fallback_for_tools: ["web_search"] # 可选，这些工具不可用时才显示
---

# 技能正文

具体的工作流程、步骤、注意事项...
```

通过 `skill_manage` 创建的技能只有 `name` 和 `description`，`platforms` 和 `metadata.hermes` 需要手动编写。

---

## 7. 与 Hermes 的对比

### 7.1 对齐的部分

| 功能                | Hermes                                          | Aether                     |
| ------------------- | ----------------------------------------------- | -------------------------- |
| 技能文件格式        | `SKILL.md` + YAML frontmatter                   | 完全相同                   |
| 磁盘快照（Layer 2） | `.skills_prompt_snapshot.json`，mtime+size 校验 | 完全对齐                   |
| 条件字段解析        | `metadata.hermes.requires_tools` 等             | 完全对齐                   |
| 平台过滤            | `platforms: [macos, linux]`                     | 完全对齐                   |
| 自进化触发逻辑      | `_iters_since_skill` 计数器 + 阈值              | 完全对齐                   |
| 评审提示词          | `_SKILL_REVIEW_PROMPT`                          | 完全对齐                   |
| 系统 prompt 引导    | `SKILLS_GUIDANCE`                               | 完全对齐                   |
| 技能去重            | 后扫描覆盖先扫描                                | 完全对齐                   |
| 安全扫描            | `skills_guard.py`                               | 已实现（`skill-guard.ts`） |

### 7.2 差异

| 功能                  | Hermes                                             | Aether                                                                       |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Layer 1 缓存**      | 模块级 LRU dict，key = (目录, 工具集, 平台)        | **InstanceState**，key = 项目目录路径，Effect 生命周期管理                   |
| **条件过滤时机**      | 在 `build_skills_system_prompt` 中过滤，传入工具集 | 已在 `SystemPrompt.skills` 中调用 `matchesConditions` 进行过滤               |
| **后台评审实现**      | Python threading                                   | Aether 独立 session（与主 session 共用 Effect runtime）                      |
| **自进化计数单位**    | 每次工具调用 +1（多工具并行时按个数算）            | 每个 LLM 步骤 +1（一步内多工具调用只算 1 次）                                |
| **`<location>` 字段** | 系统 prompt 中不暴露文件路径                       | 已修复（删除），与 Hermes 一致                                               |
| **技能存储路径**      | `~/.hermes/skills/`                                | `~/.local/share/aether/skills/`（managed），也支持 `.claude/`、`.aether/` 等 |

### 7.3 待优化项

- **内存 LRU（Hermes Layer 1）**：Aether 用 InstanceState 替代，行为等价但不按工具集组合分 key
- **同一步重复读取 Skill.available**：当前 tool 构建和 system prompt 构建各调用一次（常见为两次 memory hit），可考虑单步复用结果减少重复读取

---

## 8. 相关文件

| 文件                                               | 职责                                               |
| -------------------------------------------------- | -------------------------------------------------- |
| `packages/opencode/src/skill/index.ts`             | 技能加载、缓存、扫描、格式化                       |
| `packages/opencode/src/tool/skill.ts`              | `skill` 工具（加载并使用技能）                     |
| `packages/opencode/src/tool/skill-manage.ts`       | `skill_manage` 工具（CRUD）                        |
| `packages/opencode/src/tool/skill-guard.ts`        | 安全扫描                                           |
| `packages/opencode/src/session/skill-evolution.ts` | 后台评审触发、SKILL_REVIEW_PROMPT、SKILLS_GUIDANCE |
| `packages/opencode/src/session/system.ts`          | 系统 prompt 构建，注入技能列表                     |
| `packages/opencode/src/session/prompt.ts`          | 主对话循环，计数器逻辑，触发后台评审               |
| `packages/ui/src/components/message-part.tsx`      | web 端技能标签渲染                                 |
| `skill-evolution-reference/`                       | Hermes 参考实现（Python）                          |
