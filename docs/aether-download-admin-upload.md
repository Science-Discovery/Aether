# Aether Download API 说明

本文档面向客户端开发者，说明 Aether 下载发布接口、下载地址约定，以及 macOS manifest 协议。

## 概览

Aether 下载服务分为两部分：

- 管理员上传接口：发布某个平台的新版本安装包，并刷新 `latest` 下载别名
- 下载接口：客户端按版本或按 `latest` 拉取 manifest 和安装包

当前支持的平台：

- macOS Apple Silicon
- Windows x64
- Linux x64

## 基础约定

下载根路径：

```text
https://aether.aiphys.cn/download
```

管理员上传接口：

```text
POST https://aether.aiphys.cn/api/download/admin/upload
```

开发者私有测试下载接口：

```text
GET https://aether.aiphys.cn/api/download2/...
```

开发者私有测试上传接口：

```text
POST https://aether.aiphys.cn/api/download2/admin/upload
```

版本目录约定：

- 最新通道：`/download/latest/`
- 解析规则：`latest` 会解析到当前可用的最新公开版本，不限制大版本号
- 指定版本：`/download/<version>/`

例如：

- `/download/latest/mac-arm64.yml`
- `/download/latest/aether-darwin-arm64.dmg`
- `/download/1.3.3/mac-arm64.yml`
- `/download/1.3.3/aether-darwin-arm64.dmg`

## 上传接口

### 请求

- Method: `POST`
- Content-Type: `multipart/form-data`
- 鉴权方式二选一：
  - 表单字段 `password`
  - 请求头 `x-download-admin-password`

### 必填字段

至少上传一个平台文件。每个已上传平台都必须带对应版本号。

| 平台 | 文件字段 | 版本字段 | 发布文件名 |
| --- | --- | --- | --- |
| macOS | `macos` | `macVersion` | `aether-darwin-arm64.dmg` |
| Windows | `windows` | `windowsVersion` | `aether-windows-x64.zip` |
| Linux | `linux` | `linuxVersion` | `aether-linux-x64.zip` |

### 可选安装脚本字段

| 字段 | 含义 |
| --- | --- |
| `macInstaller` | macOS 可选更新脚本文件，发布为 `update_darwin.command` |
| `winInstaller` | Windows 可选更新脚本文件，发布为 `update_windows.bat` |
| `linuxInstaller` | Linux 可选更新脚本文件，发布为 `update_linux.sh` |

### macOS 额外可选字段

| 字段 | 含义 |
| --- | --- |
| `macNotesUrl` | 可选发布说明地址，写入 manifest 的 `notes_url` |
| `releaseDate` | 可选发布时间，ISO 时间字符串；不传时由服务端生成 |

### 兼容别名

服务端兼容以下字段别名：

| 主字段 | 兼容别名 |
| --- | --- |
| `macos` | `darwin`、`mac`、`macPackage`、`aether-darwin-arm64.dmg` |
| `macInstaller` | `macCommand`、`installer`、`command`、`update_darwin.command` |
| `winInstaller` | `windowsInstaller`、`update_windows.bat` |
| `linuxInstaller` | `update_linux.sh` |
| `macNotesUrl` | `notesUrl`、`notes_url` |
| `macVersion` | `darwinVersion`、`mac_version` |
| `windowsVersion` | `winVersion`、`windows_version` |
| `linuxVersion` | `linux_version` |

### 上传示例

上传 mac 主包、可选更新脚本和发布说明：

```bash
curl -X POST https://aether.aiphys.cn/api/download/admin/upload \
  -H 'x-download-admin-password: <your-password>' \
  -F 'macVersion=1.3.3' \
  -F 'macos=@aether-darwin-arm64.dmg' \
  -F 'macInstaller=@update_darwin.command' \
  -F 'macNotesUrl=https://aether.aiphys.cn/release-notes/1.3.3'
```

一次上传多个平台：

```bash
curl -X POST https://aether.aiphys.cn/api/download/admin/upload \
  -F 'password=<your-password>' \
  -F 'macVersion=1.3.3' \
  -F 'macos=@aether-darwin-arm64.dmg' \
  -F 'macInstaller=@update_darwin.command' \
  -F 'linuxVersion=1.3.4' \
  -F 'linux=@aether-linux-x64.zip' \
  -F 'linuxInstaller=@update_linux.sh' \
  -F 'windowsVersion=1.3.5' \
  -F 'windows=@aether-windows-x64.zip' \
  -F 'winInstaller=@update_windows.bat'
```

## 开发者私有测试上传接口

该接口用于上传“仅供开发者测试”的最新产物，不会更新公开下载版本。

请求格式、字段、鉴权方式与 `/api/download/admin/upload` 相同，但写入行为不同：

1. 只覆盖 `downloads2/latest/`
2. 不写入 `downloads2/<version>/`
3. 不影响公开 `/download/latest/...` 的版本解析结果
4. 上传成功后应通过 `/api/download2/latest/...` 访问测试产物

上传示例：

```bash
curl -X POST https://aether.aiphys.cn/api/download2/admin/upload \
  -H 'x-download-admin-password: <your-password>' \
  -F 'macVersion=1.4.1-dev' \
  -F 'macos=@aether-darwin-arm64.dmg' \
  -F 'macInstaller=@update_darwin.command'
```

## 上传成功后的行为

每个已上传平台，服务端会执行以下操作：

1. 将安装包写入 `downloads/<version>/`
2. 刷新 `/download/latest/...` 对应的最新下载别名
3. 计算安装包的 `sha512` 和 `size`
4. 生成并覆盖对应平台的 manifest
5. 如果上传了对应平台的安装脚本字段，额外将脚本发布到对应版本，并同步刷新 `latest` 别名

补充说明：

- 当前 GitHub Release 与 web 初始分发包默认不再携带 `update_*` 脚本；这些字段主要供下载服务托管 installer 在运行时拉取的更新脚本使用
- 当前上传实现仍会写入 `downloads/latest/` 作为镜像目录
- 但客户端下载 `latest` 时，应将其视为“当前最新公开版本”的路由别名，而不是依赖某个固定物理目录
- 如需测试“已上传 latest 但暂不公开发布”的产物，开发者可使用 `/api/download2/...`；该路由直接读取 `downloads2/`，并要求提供 `x-download-admin-password` 请求头或 `?password=` 参数
- 如需上传仅供开发者测试的 `latest` 产物，可使用 `/api/download2/admin/upload`；该接口只覆盖 `downloads2/latest/`

## 开发者私有测试下载接口

该接口仅供开发者测试未公开的 `latest` 产物使用，不对外开放。

鉴权方式：

- 请求头 `x-download-admin-password`
- 或查询参数 `password`

示例：

```text
/api/download2/latest/mac-arm64.yml
/api/download2/latest/aether-darwin-arm64.dmg
/api/download2/1.4.1/mac-arm64.yml
```

说明：

- `/api/download2/latest/...` 直接读取 `downloads2/latest/`，与生产 `downloads/` 目录隔离
- `/api/download2/<version>/...` 按 `downloads2/<version>/` 目录读取文件
- 兼容 `/api/download/<filename>` 的旧地址形式，例如 `/api/download2/latest-web-mac.yml`

### 开发者私有测试上传响应

成功时返回的链接指向 `/api/download2/latest/...`，示例：

```json
{
  "ok": true,
  "releaseDate": "2026-04-08T10:00:00.000Z",
  "files": [
    {
      "platform": "mac",
      "version": "1.4.1-dev",
      "latestUrl": "/api/download2/latest/aether-darwin-arm64.dmg",
      "latestManifestUrl": "/api/download2/latest/mac-arm64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "latestInstallerUrl": "/api/download2/latest/update_darwin.command",
      "notesUrl": null
    }
  ]
}
```

## 上传响应

成功时返回 `200 OK`，响应体示例：

```json
{
  "ok": true,
  "releaseDate": "2026-04-02T07:12:00.000Z",
  "files": [
    {
      "platform": "mac",
      "version": "1.3.3",
      "url": "/download/1.3.3/aether-darwin-arm64.dmg",
      "latestUrl": "/download/latest/aether-darwin-arm64.dmg",
      "manifestUrl": "/download/1.3.3/mac-arm64.yml",
      "latestManifestUrl": "/download/latest/mac-arm64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "installerUrl": "/download/1.3.3/update_darwin.command",
      "latestInstallerUrl": "/download/latest/update_darwin.command",
      "notesUrl": "https://aether.aiphys.cn/release-notes/1.3.3"
    }
  ]
}
```

说明：

- `url` / `manifestUrl` 指向指定版本目录
- `latestUrl` / `latestManifestUrl` 指向 `latest` 别名，服务端会解析到当前最新版本
- `installerUrl` 与 `latestInstallerUrl` 在未上传对应平台安装脚本时为 `null`
- `notesUrl` 在未提供时为 `null`

## 下载接口

### 最新通道

客户端可以通过 `latest` 路由获取某个平台当前发布的最新公开版本：

- `/download/latest/mac-arm64.yml`
- `/download/latest/windows-x64.yml`
- `/download/latest/linux-x64.yml`

对应安装包：

- `/download/latest/aether-darwin-arm64.dmg`
- `/download/latest/aether-windows-x64.zip`
- `/download/latest/aether-linux-x64.zip`

如果服务端托管了更新脚本，installer 还会额外访问：

- `/download/latest/update_darwin.command`
- `/download/latest/update_windows.bat`
- `/download/latest/update_linux.sh`

解析规则：

- `latest` 会在公开版本目录中选择当前最新版本
- 例如同时存在 `1.3.9`、`1.4.0`、`1.4.1` 时，`latest` 会解析到 `1.4.1`
- 如果某个平台在最新版本下没有对应文件，则会继续向下寻找更早的可用版本

### 指定版本

客户端也可以显式拉取某个版本：

- `/download/<version>/mac-arm64.yml`
- `/download/<version>/windows-x64.yml`
- `/download/<version>/linux-x64.yml`

对应安装包：

- `/download/<version>/aether-darwin-arm64.dmg`
- `/download/<version>/aether-windows-x64.zip`
- `/download/<version>/aether-linux-x64.zip`

如果服务端托管了更新脚本，installer 还会额外访问：

- `/download/<version>/update_darwin.command`
- `/download/<version>/update_windows.bat`
- `/download/<version>/update_linux.sh`

### 兼容旧地址

以下旧地址仍然可用，默认映射到 `latest` 别名：

- `/download/latest-web-mac.yml`
- `/download/latest-web-windows.yml`
- `/download/latest-web-linux.yml`
- `/download/aether-darwin-arm64.dmg`
- `/download/update_darwin.command`
- `/download/aether-windows-x64.zip`
- `/download/update_windows.bat`
- `/download/aether-linux-x64.zip`
- `/download/update_linux.sh`

## macOS Manifest 协议

mac 客户端应优先读取：

```text
/download/latest/mac-arm64.yml
```

这里的 `latest` 同样表示“解析到当前最新公开版本的 manifest”，不是要求客户端访问某个固定目录。

或：

```text
/download/<version>/mac-arm64.yml
```

manifest 示例：

```yml
version: '1.3.3'
package:
  url: aether-darwin-arm64.dmg
  sha512: <base64-sha512>
  size: 93444053
installer:
  url: update_darwin.command
  size: 4096
notes_url: 'https://aether.aiphys.cn/release-notes/1.3.3'
files:
  - url: aether-darwin-arm64.dmg
    sha512: <base64-sha512>
    size: 93444053
releaseDate: '2026-04-02T07:12:00.000Z'
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `version` | 当前发布版本 |
| `package.url` | 主安装包文件名，客户端应拼接到下载根路径或当前 manifest 所在目录 |
| `package.sha512` | 主安装包的 Base64 SHA-512 |
| `package.size` | 主安装包字节数 |
| `installer.url` | 可选更新脚本文件名 |
| `installer.size` | 可选更新脚本字节数 |
| `notes_url` | 可选发布说明地址 |
| `files[0]` | 向后兼容字段，内容与 `package` 对应 |
| `releaseDate` | 发布时间 |

接入建议：

- 新客户端优先读取 `package`
- 如果存在 `installer`，可按产品流程决定是否额外下载并执行更新脚本
- 如果 `package` 不存在，可回退读取 `files[0]`
- `package.url` 和 `installer.url` 可能是相对路径，客户端应按 manifest 所在目录解析

## 错误响应

常见错误：

| HTTP 状态码 | 含义 |
| --- | --- |
| `400` | 请求格式错误、缺少版本号、版本格式非法、`releaseDate` 非法、`macNotesUrl` 非法 |
| `403` | 管理员密码错误 |
| `500` | 服务端未配置 `DOWNLOAD_ADMIN_PASSWORD` |

错误响应示例：

```json
{
  "error": "Invalid mac notesUrl"
}
```

## 版本格式

服务端接受的版本号字符范围为：

```text
[0-9A-Za-z._-]+
```

例如：

- `1.3.3`
- `1.3.3-beta.1`
- `2026.04.02`

## 相关代码

- [upload.ts](/root/aether-site/src/pages/api/download/admin/upload.ts)
- [downloads.ts](/root/aether-site/src/lib/server/downloads.ts)
