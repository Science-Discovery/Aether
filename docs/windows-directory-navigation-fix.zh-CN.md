# Windows 目录导航与校验修复

## 背景

用户在同一项目内切换普通对话时，收到“请求失败：URL 中的目录无效”，随后回到首页。

PR [#1151](https://github.com/Science-Discovery/Aether/pull/1151) 已修复 Windows 盘符路径的正反斜杠比较。修复提交 `44e255662` 及后续规范化跳转修复 `eb36f8839` 均包含在本地 `v0.7.4` 标签中。本次在现有修复上补充导航、请求失败和已知目录列表的处理。

## 已复现的问题与修复

### 同项目切换会话重复校验

侧栏可能保留 `F:/Desktop/Paper`，而后端返回 `F:\Desktop\Paper`，当前页面随之规范化为后者。再次点击侧栏会话时，目录参数的字符串发生变化，重新请求 `/project/directories`。旧代码在请求失败时将其当成无效目录并返回首页。

目录校验现在保留最近一次通过的 `{dir, key}`。当前页面内，同一服务器的等价目录写法可以复用结果；新目录、另一服务器、退出项目后重新进入仍需校验。渲染 scoped SDK 前也核对结果属于当前服务器和目录，避免响应式更新期间使用上一目录的结果。

### 请求失败被误判为无效目录

现在区分两种结果：

- 请求成功，但后端目录列表中没有目标目录：显示无效目录提示并返回首页。
- 请求失败：保留会话路由，显示可读错误和“重试”按钮；通过校验前不挂载目录内的数据提供器。

重试仍使用无目录作用域的 fresh global SDK，不会用待验证目录的 scoped 请求来探测或创建项目。

### 规范化跳转截错 URL

旧代码从完整 pathname 开头按重新编码的目录长度截取后缀，遗漏了 Web 部署的 `basePath`；带 Base64 padding 的目录参数也会留下多余字符。

现在使用路由器解析出的当前目录路由边界，保留普通会话、阅读会话、查询参数及 hash。旧目录的数据提供器只有在当前路由仍属于自己时才能规范化地址。

### UNC 网络共享目录误判

新增对完整 UNC 路径的等价匹配，例如 `//server/share/Paper` 与 `\\server\share\Paper`。继续区分不同共享、大小写、父目录片段及 POSIX 路径中的字面反斜杠；不将 Windows 设备路径当作普通共享目录。

### 已注册工作区和会话目录遗漏

`Project.directories()` 原先直接使用首页 `recentList()`。首页会隐藏同项目的部分工作区条目，因此一个已经注册并有会话的目录也可能被目录守卫拒绝。

接口现在独立读取当前服务器的注册记录，并合并有效项目中的根目录、目录元数据和已有会话目录。只有项目数据库存在且仍有对应项目行时才读取其内容；不扫描历史数据库文件，不触发 `Instance` 初始化。删除项目或工作区后，残留数据库文件、映射、旧会话不会使它们重新出现。

### 一次性打开意图残留

每个服务器现在只保留下一次目录导航的目标。消费时无论是否命中都会丢弃，退出目录页面时清理对应服务器的意图。异步选择项目最后打开哪个会话之后，才在实际导航前标记目标，避免预先标记的目录遗留到之后的 URL 回放。

异步打开项目时还会核对发起操作的服务器及页面是否仍有效，防止切服后的旧响应修改路由或写入新服务器的打开意图。刷新工作区列表之后，后续会话查找使用更新后的目录集合。

## 验证

前端的路由回归使用真实 `MemoryRouter` 和 `DirectoryLayout`，只替换外围数据提供器和网络响应。覆盖普通会话、阅读会话、Windows 分隔符及尾分隔符、UNC、Web 子路径、Base64 padding、错误重试、未知目录、跨服务器、离开项目、延迟响应和校验等待状态。

后端使用临时目录、真实项目数据库和 `ProjectRoutes` HTTP handler，覆盖目录完整性、删除生命周期及不触发项目初始化的只读查询。

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
