# Skill Evolution — 架构说明

**核心命题**：AI 对话中积累的知识，是否以及如何被自动固化为可复用的 Skill？

---

## 决策树

```
AI 对话中积累的知识，是否以及如何被固化为可复用 Skill？
│
├─[触发层]─ 本轮对话是否满足复盘触发条件？
│   │
│   ├── 否（步数 < nudge_interval，或 aborted，或无 finalResponse）
│   │   └── ✗ 不复盘，退出
│   │
│   └── 是
│       │
│       ├─[递归防护]─ 当前 session 是否本身就是 review session？
│       │   │
│       │   ├── 是（Instance.directory === SKILL_SESSIONS_ROOT）
│       │   │   └── ✗ 跳过，防止无限递归
│       │   │
│       │   └── 否
│       │       └── → 触发后台 review agent（spawnReview）
│       │
│       ├─[内容判断]─ 对话中是否存在值得固化的新知识？
│       │   │       （A: 有非平凡的可复用经验  AND  B: 方法正确有效）
│       │   │
│       │   ├── 否
│       │   │   └── ✗ 回复 "Nothing to save."
│       │   │
│       │   └── 是 → 执行 skill_manage 操作
│       │       │
│       │       ├─[存在性]─ 目标 Skill 是否已存在？
│       │       │   │
│       │       │   ├── 否 → action = create
│       │       │   │
│       │       │   └── 是
│       │       │       │
│       │       │       ├─[变更幅度]─ 更新是否影响 Skill 的整体结构或方向？
│       │       │       │   │
│       │       │       │   ├── 是 → action = edit（全量重写 SKILL.md）
│       │       │       │   ├── 否 → action = patch（old_str → new_str 局部替换）
│       │       │       │   └── Skill 已过时/错误 → action = delete
│       │       │       │
│       │       │       └── 需要附加文件（脚本/模板）→ action = write_file
│       │       │
│       │       ├─[写入路径]─ Skill 是否有已知的源文件路径（skillLocation）？
│       │       │   │
│       │       │   ├── 是（来自 .claude / .agents / .opencode / .aether）
│       │       │   │   └── Copy-on-Write → <project>/.aether/skills/<name>/
│       │       │   │
│       │       │   └── 否
│       │       │       │
│       │       │       ├─[创建来源]─ 是否由 review session 自主创建？
│       │       │       │   │
│       │       │       │   ├── 是（sessionProjectId 已绑定）
│       │       │       │   │   └── ~/.aether/skill-sessions/<folder>/skills/<name>/
│       │       │       │   │
│       │       │       │   └── 否（用户手动调用 skill_manage）
│       │       │       │       └── ~/.aether/skills/<name>/
│       │       │       │
│       │       └─[安全扫描]─ 写入内容是否通过 Guard 扫描？
│       │           │
│       │           ├── 通过（safe / caution）
│       │           │   ├── 创建版本快照（Versions.create）
│       │           │   └── 发布 skill.saved 事件（Publisher）
│       │           │
│       │           └── 拦截（dangerous：密钥/数据泄露/提示注入/破坏性命令）
│       │               └── 回滚到上一个版本快照
│       │
│       └─[版本管理]─ 快照数是否超过容量上限（VERSION_CAPACITY = 100）？
           │
           ├── 否 → 保留全部快照
           │
           └── 是 → Binary Ruler 剪枝
               ├── 永久保留 v001（原始版本）
               ├── 保留最近 50% 快照（active region）
               └── 其余按 v & -v 权重保留里程碑版本
```

---

## 模块索引

```
skill-evolution/
├── index.ts            公开 API（仅导出 SkillEvolutionHook 及类型）
│
├── hook.ts             入口：集成到 session 主循环
│                       onStep()    — 每次 tool call 后计数
│                       onLoopEnd() — 循环结束后检查触发条件
│
├── counter.ts          per-session 步数计数器（模块级 Map）
│
├── config-reader.ts    读取 ~/.aether/skill-evolution-config.json
│                       字段：creation_nudge_interval（默认 10）
│
├── review-agent.ts     后台 review session 的核心
│                       spawnReview()      — 在 Instance(SKILL_SESSIONS_ROOT) 中
│                                            fire-and-forget 运行 review agent
│                       isReviewSession()  — 递归防护检测
│                       buildReviewPrompt()— 拼装 XML 对话历史 + prompt
│                       serializeHistory() — 对话快照 → XML
│
├── spawner.ts          路径工具（纯函数，无副作用）
│                       skillFolderName()  — "<basename>-<shortId>"
│                       skillSessionsDir() — ~/.aether/skill-sessions/<folder>/skills/
│                       skillSessionsBase()— ~/.aether/skill-sessions/<folder>/
│
├── skill-manage-tool.ts  review agent 可调用的唯一写入工具
│                         actions: create / edit / patch / write_file /
│                                  delete / history / rollback
│                         createBoundSkillManageTool() — 绑定 projectId 的变体
│
├── shadow-writer.ts    Copy-on-Write 路径解析与安全校验
│                       resolveSkillDir()       — 三级路径优先级
│                       validateSkillLocation() — 白名单校验（必须含 <marker>/skills/）
│                       copyToShadowIfNeeded()  — 首次拷贝原始目录到 shadow
│
├── guard.ts            安全扫描（写入前对 skillDir 所有文本文件执行）
│                       规则：数据泄露 / 提示注入 / 破坏性命令 /
│                             持久化 / 供应链 / 硬编码凭证 / 不可见字符
│                       严重级别：safe → caution → dangerous
│
├── versions.ts         版本快照（bundle.json 存于 skillDir/.versions/）
│                       create()  — 打快照
│                       list()    — 列出所有版本
│                       rollback()— 恢复到指定版本
│                       prune()   — Binary Ruler 剪枝（容量 100）
│
├── publisher.ts        发布 skill.saved Bus 事件（通知 UI 刷新）
│
└── constants.ts        所有魔法数字/字符串的唯一来源
                        DEFAULT_NUDGE_INTERVAL = 10
                        VERSION_CAPACITY = 100
                        MAX_SCAN_FILES = 50 / MAX_FILE_SIZE = 256KB
```

---

## 数据流总览

```
session 主循环
    │  每个 tool-call step
    ↓
SkillEvolutionHook.onStep()
    │  计数 / skill_manage 调用时重置
    ↓
Counter（per-session Map）
    │
    │  loop 正常结束
    ↓
SkillEvolutionHook.onLoopEnd()
    │  读 ConfigReader.getNudgeInterval()
    │  count >= interval → 触发
    ↓
spawnReview()  [fire-and-forget，错误只 log]
    │
    ├─ 读取 MessageV2.stream(sessionID) → 对话快照
    ├─ collectCategories() → 已有 skill 类别（用于 prompt）
    ├─ buildReviewPrompt() → XML 历史 + 系统指令
    │
    ├─ Instance.provide({ directory: SKILL_SESSIONS_ROOT })
    │   ├─ findEvolutionSession() or Session.createNext()
    │   ├─ ToolRegistry.registerForSession(reviewSessionId, boundSkillManageTool)
    │   ├─ SessionPrompt.prompt({ tools: { skill_manage, read } })
    │   │       ↓  review agent 判断后调用 skill_manage
    │   │   SkillManageTool.execute()
    │   │       ├─ ShadowWriter.validateSkillLocation()  [白名单校验]
    │   │       ├─ ShadowWriter.resolveSkillDir()        [确定写入路径]
    │   │       ├─ ShadowWriter.copyToShadowIfNeeded()   [Copy-on-Write]
    │   │       ├─ 写入文件（atomicWrite / fs.rm）
    │   │       ├─ Guard.scan()                          [安全扫描]
    │   │       │   ├─ dangerous → Versions.rollback()
    │   │       │   └─ safe/caution
    │   │       │       ├─ Versions.create()             [打快照]
    │   │       │       │   └─ Versions.prune()          [Binary Ruler]
    │   │       │       └─ Publisher.publishSkillSaved() [通知 UI]
    │   │       └─ 返回 { ok, message, skillDir }
    │   └─ ToolRegistry.unregisterSession(reviewSessionId)
    │
    └─ Counter.reset(sessionID)
```

---

## 存储布局

```
~/.aether/
├── skill-evolution-config.json       nudge_interval 配置
│
├── skills/                           用户手动 skill_manage 创建的全局 skill
│   └── <name>/
│       ├── SKILL.md
│       └── .versions/
│           └── v001_create_<ts>.bundle.json
│
└── skill-sessions/
    └── <basename>-<shortId>/         每个项目一个隔离目录
        ├── db.sqlite                 review session 的 SQLite DB
        └── skills/                   review agent 自主创建的 skill
            └── <name>/
                ├── SKILL.md
                └── .versions/

<project>/
└── .aether/
    └── skills/                       Copy-on-Write shadow（来自 .claude/.agents/.opencode）
        └── <name>/
            ├── SKILL.md              修改在这里，原始文件不变
            └── .versions/
```

---

## 关键约束

| 约束 | 位置 | 说明 |
|---|---|---|
| 原始 skill 只读 | `shadow-writer.ts` | 写入前先 copy-on-write，源目录永不修改 |
| skillLocation 白名单 | `validateSkillLocation()` | 必须含 `<config-marker>/skills/` 路径段 |
| skill name 字符限制 | `SkillManageInput` schema | 仅 `[a-zA-Z0-9_-]`，禁止路径穿越 |
| 安全扫描在写入后 | `guardAndPublish()` | 先写再扫；dangerous 时回滚 |
| review session 不触发 review | `isReviewSession()` | Instance.directory 检测，防止递归 |
| 工具注册 per-session | `registerForSession` / `unregisterSession` | 并发 review 不互相覆盖 |
