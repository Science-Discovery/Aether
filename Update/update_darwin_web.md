# update_darwin.command（macOS Web 更新执行脚本）

这个脚本只负责**本地已下载安装包的版本安装**，不负责远端检查、下载、校验。

与 `aether_darwin_installer.command` 的职责分离如下：

- `aether_darwin_installer.command`：拉取元数据、下载包和安装器、写 `last-result.yml`
- `update_darwin.command`：消费本地 dmg，执行版本目录安装与切换

## 输入与前提

- 脚本位置：建议放在 `.../Aether/Update/` 目录执行。
- 安装包位置：脚本同目录（`Update/`）下必须存在至少一个 `.dmg`，并且文件名包含版本号（例如 `aether-darwin-arm64-web-0.3.1.dmg`）。
- 可选参数：`<version>`，指定要安装的版本号；不传则自动选择脚本目录中版本最高的 dmg。

## 执行流程

0. 确认工作目录为 `.../Aether`（自动推导，兜底 `~/Applications/Aether`）
1. 在脚本目录识别对应版本 dmg
2. 挂载 dmg 并安装到版本目录 `aether-<version>`
3. 设置权限与隔离属性：
   - `chmod +x ./aether ./Aether.command`
   - `xattr -cr ./aether ./Aether.command`
4. 维护入口：
   - 更新 `current -> aether-<version>` 软链接
   - 生成/更新工作目录顶层 `Aether.command`（统一启动入口）

## 版本策略

- 小版本更新（同 `major.minor`，如 `0.3.0 -> 0.3.1`）
  - 替换旧版本目录为新版本目录
  - 若旧目录存在 `.opencode`，会迁移到新目录并保留其内容
- 大版本更新（`major.minor` 变化，如 `0.3.2 -> 0.4.0`）
  - 创建并保留新版本目录
  - 旧 `0.3.x` 目录不删除，允许并存

## 版本记录

安装完成后会写入：

- `aether-<version>/.aether_web_version`
- `Aether/.aether_web_version`（当前激活版本）

## 典型用法

```bash
# 自动选择脚本目录中最高版本 dmg
./update_darwin.command

# 指定安装版本（脚本目录中必须有对应 dmg）
./update_darwin.command 0.3.1
```
