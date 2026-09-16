# Windows 目录导航与校验修复

## 背景

用户在同一项目内切换普通对话时，收到“请求失败：URL 中的目录无效”，随后回到首页。

PR [#1151](https://github.com/Science-Discovery/Aether/pull/1151) 已修复 Windows 盘符路径的正反斜杠比较。修复提交 `44e255662` 及后续规范化跳转修复 `eb36f8839` 均包含在本地 `v0.7.4` 标签中。本次在现有修复上补充导航、请求失败和已知目录列表的处理。

## 修复范围

侧栏可能保留 `F:/Desktop/Paper`，而后端返回 `F:\Desktop\Paper`，当前页面随之规范化为后者。再次点击侧栏会话时，目录参数的字符串发生变化，重新请求 `/project/directories`。旧代码在请求失败时将其当成无效目录并返回首页。

修复集中在目录校验和规范化跳转：

- **复用已通过的校验**：保留最近一次通过的 `{dir, key}`，供当前页面内同一服务器的等价目录使用。渲染 scoped SDK 前核对结果所属的服务器和目录；新目录或重新进入页面仍按原有规则校验。
- **区分请求失败与未知目录**：请求失败时保留原路由，显示错误及重试按钮；仅在后端成功返回且目标目录不在列表中时回首页。校验及重试均使用无目录作用域的 global SDK，通过前不挂载目录内的数据提供器。
- **保留完整会话地址**：规范化目录时按实际路由边界替换目录段，避免 Web `basePath` 或 Base64 padding 导致截取错误，保留会话、查询参数和 hash；同时支持完整 UNC 路径的正反斜杠等价比较。
- **使用目录注册记录**：`Project.directories()` 读取 `ProjectRecentTable` 和 `GlobalProjectMapTable`，避免首页 `recentList()` 隐藏工作区而误拒绝。每个项目只核对一次是否仍有效，不遍历项目的元数据或会话表。

## 验证

前端使用真实路由器覆盖会话切换、路径等价、请求重试和校验边界；后端使用真实注册流程、项目数据库及 HTTP handler，覆盖工作区遗漏、删除后不再放行和只读查询。

在对应包目录运行：

```powershell
# packages/app
bun run test:unit
bun typecheck
bun run build

# packages/opencode
bun test ./test/project/directories.test.ts ./test/server/project-directories.test.ts ./test/project/sandbox-management.test.ts ./test/project/project-fromdirectory-order.test.ts --timeout 30000
bun typecheck
```

## 发布范围

这次修改涉及前端和后端。Electron renderer 直接导入 app 包并随桌面客户端打包，需要包含本次前端改动的桌面构建；单独更新后端 Web 静态资源不会替换 Electron renderer。浏览器版需要更新对应 Web 构建。目录接口的补全还需要包含本次后端改动的服务程序。
