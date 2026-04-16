# Aether Memory/Profile 发布说明（当前版本）

本文用于发布前同步给协作者，内容仅对应当前已落地实现。

## 1. 本次发布包含

- 双仓持久化：
  - `USER`（全局用户画像）
  - `MEMORY`（项目/工作区记忆）
- 主代理直连记忆工具：
  - `memory_write / memory_read / memory_list / memory_search / memory_reflect`
  - `session_search / session_read`
- 冻结快照注入：
  - 会话启动时加载 memory snapshot 并写入系统提示
  - 会话内后续写入即时落盘，但不回写当前会话已冻结 snapshot
- 强/轻反思：
  - 启动强反思（按设置）
  - 写入后轻反思（按设置）
  - 支持显式 `memory_reflect` 主动触发
- 跨会话搜索：
  - 文本 + 标题检索
  - 支持 title-only 会话（包括仅 receipt 文本 part 的会话）

## 2. 用户可见行为

- Settings > Memory 可配置：
  - 跨会话搜索开关
  - 跨会话搜索范围（当前项目/全局）
  - 反思开关
  - 用户画像总开关
  - 是否注入 inferred 用户画像
- Memory 页面为只读仓视图：
  - `MEMORY` 条目列表
  - `USER` 按 `explicit / inferred` 分组展示
- 用户画像注入优先级在 snapshot 中明确：
  1. 当前轮用户指令最高优先
  2. explicit 用户画像为强 standing instructions/preferences
  3. inferred 仅作为弱提示
- `session_read` 仅在用户明确要求完整历史时可读，且翻页授权绑定目标会话。

## 3. 设置面（当前有效字段）

- `cross_session_search_enabled`（默认 `true`）
- `cross_session_search_scope`（默认 `current_project`）
- `memory_reflection_enabled`（默认 `true`）
- `user_profile_enabled`（默认 `true`）
- `user_profile_include_inferred`（默认 `true`）

兼容性说明：以下旧字段不再作为产品有效能力暴露：

- `memory_management_model`
- `user_profile_history_extract_enabled`
- `user_profile_history_extract_limit`

## 4. 手工测试清单与启动命令

### 4.1 启动命令（本地）

```bash
# 终端 1：在仓库根目录启动后端服务
bun dev serve

# 终端 2：在仓库根目录启动 Web（Settings > Memory）
bun run dev:web
```

### 4.2 发布前手工检查

1. Settings > Memory 字段仅包含 5 个有效配置项（见上文），无旧字段入口。  
2. `user_profile_enabled=false` 时 USER 仓逻辑关闭且 UI 显示禁用提示。  
3. `user_profile_include_inferred=false` 时 inferred 不注入 snapshot。  
4. `session_search`：
   - 多关键词可命中
   - 标题可命中
   - title-only 会话可命中
5. `session_read`：
   - 未显式请求完整历史时被阻止
   - 显式请求后可分页继续
6. 写入风险内容（注入/密钥/外泄/不可见字符）会被安全扫描阻断并生成失败事件。  
7. 仓逼近容量时可观察到反思压缩/合并；仍超限时写入阻断。  

### 4.3 建议最小校验命令

```bash
bun run --cwd packages/opencode typecheck
bun run --cwd packages/opencode test test/memory/memory-system.test.ts
```

## 5. 已知边界 / 非目标

- 当前不使用 embedding/向量检索，也未引入 FTS。
- Memory 页面暂不提供手工编辑器，仅提供只读展示。
- 没有单独的 memory-management LLM/router 热路径；由主代理直接决策并调用工具。
- `session_search` 为关键词命中与会话聚合结果，不是语义召回系统。
