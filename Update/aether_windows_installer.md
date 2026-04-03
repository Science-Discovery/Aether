# Aether Windows 安装入口设计

这个脚本是 Windows 版本安装入口，不直接执行具体版本的安装脚本，而是负责：

- 选择或推导工作目录
- 拉取远端 `yml` 元数据
- 下载目标版本压缩包和对应版本安装脚本
- 输出标准退出码
- 生成 `last-result.yml`，供 Aether 软件读取并决定后续交互

文件：

- `Update/aether_windows_installer.bat`

## 模式

- `init`
  首次安装入口。默认工作目录是 `%LOCALAPPDATA%\Programs\Aether`，允许用户改路径。
- `auto <current-version>`
  自动更新检查。用于 Aether 软件后台调用。
- `manual <target-version>`
  手动指定版本下载。用于 Aether 软件后台调用。

## 工作目录

- `init`
  使用用户输入路径，默认 `%LOCALAPPDATA%\Programs\Aether`
- `auto` 和 `manual`
  默认取安装器所在目录的上一层
  如果安装器直接放在工作目录根下，则直接使用脚本所在目录

## 脚本职责

统一流程：

1. 读取远端 `yml` manifest
2. 得到目标版本、压缩包地址、版本安装脚本地址
3. 下载到 `工作目录\downloads`
4. 把结果写入 `工作目录\downloads\last-result.yml`
5. 用退出码把状态返回给 Aether

说明：

- 入口脚本不再直接执行远端版本安装脚本
- 具体是否提示用户、是否开始安装、何时重启，都由 Aether 软件决定

## 远端约定

最新版本：

- `https://aether.aiphys.cn/download/latest/windows-x64.yml`
- `https://aether.aiphys.cn/download/latest/mac-arm64.yml`

指定版本：

- `https://aether.aiphys.cn/download/<version>/windows-x64.yml`
- `https://aether.aiphys.cn/download/<version>/mac-arm64.yml`

示例：

```yml
version: 1.2.3
package:
  url: windows/1.2.3/aether-1.2.3.zip
  sha512: BASE64_SHA512_OPTIONAL
installer:
  url: windows/1.2.3/install.bat
notes_url: windows/1.2.3/notes.md
```

说明：

- `package.url` 支持相对路径或完整 URL
- `installer.url` 支持相对路径或完整 URL
- `package.sha512` 可选，存在时会做校验
- `notes_url` 可选，供前端展示更新说明

## 返回给 Aether 的方式

推荐 Aether 以这两种信息作为判断依据：

- 退出码
- `工作目录\downloads\last-result.yml`

不再把上下文直接传给“版本安装脚本”。

## 退出码

- `0`
  `init` 成功结束
- `10`
  发现并下载了最新版本，等待 Aether 决定是否安装
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

## 结果文件

路径：

- `工作目录\downloads\last-result.yml`

示例：

```yml
mode: 'auto'
status: 'update_ready'
code: 10
current_version: '1.2.2'
target_version: '1.2.3'
requested_version: ''
work_dir: 'C:\Users\name\AppData\Local\Programs\Aether'
download_dir: 'C:\Users\name\AppData\Local\Programs\Aether\downloads'
package_path: 'C:\Users\name\AppData\Local\Programs\Aether\downloads\aether-1.2.3.zip'
installer_path: 'C:\Users\name\AppData\Local\Programs\Aether\downloads\install.bat'
manifest_url: 'https://aether.aiphys.cn/download/latest/windows-x64.yml'
notes_url: 'https://aether.aiphys.cn/download/1.2.3/notes.md'
```

常见 `status`：

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

## 暂停行为

- `init`
  默认暂停，方便用户看到结果
- `auto` 和 `manual`
  默认不暂停，便于 Aether 直接读取退出码
- 所有模式都支持 `--no-pause`

## 用法

```bat
Update\aether_windows_installer.bat init
Update\aether_windows_installer.bat auto 1.2.3
Update\aether_windows_installer.bat manual 1.2.0
Update\aether_windows_installer.bat --no-pause auto 1.2.3
```
