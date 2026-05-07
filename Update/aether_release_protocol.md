# Aether 远端发布协议

这份文档定义 Aether 安装入口脚本、Aether 软件前端/后端、以及远端发布存储之间的统一协议。

目标：

- 统一 Windows / macOS / Linux 的远端目录结构
- 统一安装入口脚本的行为边界
- 统一 Aether 对脚本结果的消费方式
- 允许不同版本保留各自独立的安装逻辑

## 总体原则

安装入口脚本只负责：

- 确定工作目录
- 检查远端版本信息
- 下载目标版本包和该版本对应安装脚本
- 输出退出码
- 生成结果文件 `last-result.yml`

安装入口脚本不负责：

- 不直接执行版本安装脚本
- 不直接决定是否安装
- 不直接弹业务确认框

后续动作由 Aether 软件决定：

- 是否提示用户
- 是否开始安装
- 使用哪个版本安装脚本
- 是否迁移数据
- 是否重启软件

## 远端目录结构

根路径：

- `https://aether.aiphys.cn/download`

最新版 manifest：

- Windows x64
  `https://aether.aiphys.cn/download/latest/windows-x64.yml`
- macOS arm64
  `https://aether.aiphys.cn/download/latest/mac-arm64.yml`
- macOS x64
  `https://aether.aiphys.cn/download/latest/mac-x64.yml`
- Linux x64
  `https://aether.aiphys.cn/download/latest/linux-x64.yml`
- Linux arm64
  `https://aether.aiphys.cn/download/latest/linux-arm64.yml`

指定版本 manifest：

- Windows x64
  `https://aether.aiphys.cn/download/<version>/windows-x64.yml`
- macOS arm64
  `https://aether.aiphys.cn/download/<version>/mac-arm64.yml`
- macOS x64
  `https://aether.aiphys.cn/download/<version>/mac-x64.yml`
- Linux x64
  `https://aether.aiphys.cn/download/<version>/linux-x64.yml`
- Linux arm64
  `https://aether.aiphys.cn/download/<version>/linux-arm64.yml`

推荐的版本目录示例：

```text
download/
  latest/
    windows-x64.yml
    mac-arm64.yml
    mac-x64.yml
    linux-x64.yml
    linux-arm64.yml
  1.2.3/
    windows-x64.yml
    mac-arm64.yml
    mac-x64.yml
    linux-x64.yml
    linux-arm64.yml
    aether-windows-x64.zip
    aether-darwin-arm64.dmg
    aether-darwin-x64.dmg
    aether-linux-x64.zip
    aether-linux-arm64.zip
    update_windows.bat
    update_darwin.command
    update_darwin_x64.command
    update_linux.sh
    update_linux_arm64.sh
    notes.md
```

## Manifest 格式

每个平台对应一个 `yml` 文件。

示例：

```yml
version: 1.2.3
package:
  url: aether-windows-x64.zip
  sha512: BASE64_SHA512_OPTIONAL
installer:
  url: update_windows.bat
notes_url: 1.2.3/notes.md
```

macOS 示例：

```yml
version: 1.2.3
package:
  url: aether-darwin-arm64.dmg
  sha512: BASE64_SHA512_OPTIONAL
installer:
  url: update_darwin.command
notes_url: 1.2.3/notes.md
```

Linux 示例：

```yml
version: 1.2.3
package:
  url: aether-linux-x64.zip
  sha512: BASE64_SHA512_OPTIONAL
installer:
  url: update_linux.sh
notes_url: 1.2.3/notes.md
```

字段说明：

- `version`
  目标版本号
- `package.url`
  安装包地址，支持相对路径或完整 URL
- `package.sha512`
  可选；存在时安装入口脚本必须校验
- `installer.url`
  该版本专属安装脚本地址，支持相对路径或完整 URL
- `notes_url`
  可选；供 Aether 前端展示更新说明

约束：

- `version` 必填
- `package.url` 必填
- `installer.url` 必填
- `notes_url` 可选
- 脚本应容忍额外字段存在

## 安装入口脚本模式

所有平台的安装入口脚本统一支持三种模式：

- `init`
  首次安装入口
- `auto <current-version>`
  自动更新检查
- `manual <target-version>`
  手动指定版本下载

行为约束：

- `init`
  默认允许面向用户交互，例如选择工作目录
- `auto`
  默认无阻塞退出，供 Aether 后台调用
- `manual`
  默认无阻塞退出，供 Aether 后台调用

## 工作目录规则

Windows：

- 默认工作目录
  `%LOCALAPPDATA%\Programs\Aether`

macOS：

- 默认工作目录
  `~/Applications/Aether`

Linux：

- 默认工作目录
  `~/.local/share/applications/Aether`

非 `init` 模式：

- 若安装入口脚本位于某个版本目录下，例如 `Aether/aether-1.2.3/`
  工作目录取其上一层，即 `Aether/`
- 若安装入口脚本直接放在工作目录根下
  直接使用脚本所在目录

## 本地下载目录

所有平台统一下载到：

- `工作目录/downloads`

其中保存：

- 目标版本安装包
- 目标版本安装脚本
- `last-result.yml`

## 退出码协议

安装入口脚本必须返回以下退出码：

- `0`
  `init` 成功结束
- `10`
  发现并下载了最新版，等待 Aether 决定是否安装
- `11`
  指定版本存在且已下载完成，等待 Aether 决定是否安装
- `20`
  当前已经是最新版本
- `21`
  指定版本不存在
- `30`
  元数据拉取失败或网络错误
- `31`
  文件下载失败
- `32`
  文件校验失败
- `40`
  工作目录创建失败或无权限
- `50`
  参数错误

说明：

- `auto` 和 `manual` 应主要通过退出码驱动 Aether 行为
- `init` 可在控制台显示更多文本，但最终也应返回明确状态

## 结果文件协议

路径：

- Windows
  `工作目录\downloads\last-result.yml`
- macOS / Linux
  `工作目录/downloads/last-result.yml`

统一格式：

```yml
mode: 'auto'
status: 'update_ready'
code: 10
current_version: '1.2.2'
target_version: '1.2.3'
requested_version: ''
work_dir: 'C:\Users\name\AppData\Local\Programs\Aether'
download_dir: 'C:\Users\name\AppData\Local\Programs\Aether\downloads'
package_path: 'C:\Users\name\AppData\Local\Programs\Aether\downloads\aether-windows-x64-1.2.3.zip'
installer_path: 'C:\Users\name\AppData\Local\Programs\Aether\downloads\update_windows-1.2.3.bat'
manifest_url: 'https://aether.aiphys.cn/download/latest/windows-x64.yml'
notes_url: 'https://aether.aiphys.cn/download/1.2.3/notes.md'
```

字段说明：

- `mode`
  `init` / `auto` / `manual`
- `status`
  当前脚本执行结果
- `code`
  与退出码一致
- `current_version`
  当前已安装版本，仅 `auto` 常用
- `target_version`
  远端解析出的目标版本
- `requested_version`
  `manual` 模式下用户请求的版本
- `work_dir`
  工作目录
- `download_dir`
  下载目录
- `package_path`
  已下载安装包路径
- `installer_path`
  已下载安装脚本路径
- `manifest_url`
  本次使用的 manifest 地址
- `notes_url`
  更新说明地址

推荐 `status` 枚举：

- `init_ready`
- `update_ready`
- `manual_ready`
- `up_to_date`
- `version_missing`
- `meta_error`
- `download_error`
- `checksum_error`
- `dir_error`
- `arg_error`

## Aether 软件侧约定

Aether 调用安装入口脚本后，推荐按以下顺序处理：

1. 读取进程退出码
2. 读取 `last-result.yml`
3. 根据 `code` 和 `status` 决定 UI 行为

推荐处理方式：

- `10`
  提示发现新版本，可展示 `notes_url`，允许用户选择是否安装
- `11`
  提示指定版本已准备好，可继续安装
- `20`
  提示已是最新版本，或静默结束
- `21`
  提示指定版本不存在
- `30`
  提示远端元数据获取失败
- `31`
  提示下载失败
- `32`
  提示包校验失败
- `40`
  提示工作目录或权限问题
- `50`
  记录调用错误并提示开发侧修复

## 版本安装脚本约定

版本安装脚本由 Aether 在合适的时机再调用。

推荐原则：

- 每个版本保留自己的安装逻辑
- 允许不同版本迁移策略不同
- 允许不同版本安装位置不同
- 允许不同版本附加依赖安装不同

入口脚本无需理解这些差异。

## 平台文件建议

推荐的安装入口文件名：

- Windows
  `aether_windows_installer.bat`
- macOS
  `aether_darwin_installer.command`
- Linux
  `aether_linux_installer.sh`

推荐的版本安装脚本文件名：

- Windows
  `update_windows.bat`
- macOS arm64
  `update_darwin.command`
- macOS x64
  `update_darwin_x64.command`
- Linux x64
  `update_linux.sh`
- Linux arm64
  `update_linux_arm64.sh`

## 发布侧检查清单

- 每个发布版本目录都存在对应平台 manifest
- `latest/` 下的 manifest 始终指向最新稳定版本
- `package.url` 指向真实可下载文件
- `installer.url` 指向真实可下载脚本
- `sha512` 与安装包内容一致
- `notes_url` 若存在则可被前端访问
- 安装脚本文件名和平台匹配

## 向后兼容建议

- 允许 manifest 新增字段，不影响老版本安装入口脚本
- 旧字段若未来废弃，建议保留一个过渡周期
- `latest/` 是逻辑别名，历史版本必须始终可通过 `<version>/...` 访问

## 当前平台映射

当前文档约定的平台标识：

- Windows x64
  `windows-x64`
- macOS Apple Silicon
  `mac-arm64`
- macOS Intel
  `mac-x64`
- Linux x64
  `linux-x64`
- Linux arm64
  `linux-arm64`

如果未来新增平台，例如：

- `windows-arm64`

可沿用同一目录结构和同一 manifest 协议。
