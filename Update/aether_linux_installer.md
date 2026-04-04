# Aether Linux 安装入口设计

这个脚本是 Linux 版本安装入口，负责：

- 选择或推导工作目录
- 拉取远端 `yml` 元数据
- 下载目标版本压缩包和对应版本安装脚本
- 输出标准退出码
- 生成 `last-result.yml`，供 Aether 软件读取并决定后续交互
- 在 `init` 模式下，下载完成后直接执行对应版本安装脚本完成首次安装

文件：

- `Update/aether_linux_installer.sh`

## 模式

- `init`
  首次安装入口。默认工作目录是 `~/.local/share/applications/Aether`，默认不交互。可通过 `--path <dir>` 指定父目录。下载完成后会自动执行下载到本地的版本安装脚本。
- `auto <current-version>`
  自动更新检查。用于 Aether 软件后台调用。
- `manual <target-version>`
  手动指定版本下载。用于 Aether 软件后台调用。

## 工作目录

- `init`
  默认工作目录为 `~/.local/share/applications/Aether`。若传入 `--path <dir>`，则输入的是父目录，实际工作目录固定归一化为 `父目录/Aether`。
- `auto` 和 `manual`
  默认使用安装器脚本所在目录（即 `.../Aether`）

## 远端约定

最新版本：

- `https://aether.aiphys.cn/download/latest/linux-x64.yml`
- `https://aether.aiphys.cn/download/latest/windows-x64.yml`

指定版本：

- `https://aether.aiphys.cn/download/<version>/linux-x64.yml`
- `https://aether.aiphys.cn/download/<version>/windows-x64.yml`

说明：

- Linux 路径这里按与 Windows/macOS 相同的命名模式实现，当前假设平台标识为 `linux-x64`

示例：

```yml
version: 1.2.3
package:
  url: 1.2.3/aether-1.2.3-linux-x64.tar.gz
  sha512: BASE64_SHA512_OPTIONAL
installer:
  url: 1.2.3/install-linux.sh
notes_url: 1.2.3/notes.md
```

## 返回给 Aether 的方式

- 退出码
- `工作目录/downloads/last-result.yml`

说明：

- `init`：会直接执行下载到本地的版本安装脚本。
- `auto` / `manual`：只下载并写结果，不直接安装。

## 退出码

- `0` `init` 成功结束
- `10` 发现并下载了最新版本
- `11` 指定版本存在且已下载完成
- `20` 当前已经是最新版本
- `21` 指定版本不存在
- `30` 元数据拉取失败或网络错误
- `31` 文件下载失败
- `32` 文件校验失败
- `33` `init` 模式执行本地安装脚本失败
- `40` 工作目录创建失败或无权限
- `50` 参数错误

## 结果文件

路径：

- `工作目录/downloads/last-result.yml`

示例：

```yml
mode: "manual"
status: "manual_ready"
code: 11
current_version: ""
target_version: "1.2.3"
requested_version: "1.2.3"
work_dir: "/home/name/.local/share/applications/Aether"
download_dir: "/home/name/.local/share/applications/Aether/downloads"
package_path: "/home/name/.local/share/applications/Aether/downloads/aether-1.2.3-linux-x64.tar.gz"
installer_path: "/home/name/.local/share/applications/Aether/downloads/install-linux.sh"
manifest_url: "https://aether.aiphys.cn/download/1.2.3/linux-x64.yml"
notes_url: "https://aether.aiphys.cn/download/1.2.3/notes.md"
```

## 暂停行为

- `init` 默认暂停
- `auto` 和 `manual` 默认不暂停
- 所有模式都支持 `--no-pause`

## 用法

```bash
Update/aether_linux_installer.sh init
Update/aether_linux_installer.sh --path /home/name/Desktop init
Update/aether_linux_installer.sh auto 1.2.3
Update/aether_linux_installer.sh manual 1.2.0
Update/aether_linux_installer.sh --no-pause auto 1.2.3
```
