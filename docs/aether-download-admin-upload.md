# Aether Download API 说明

本文档面向客户端开发者，说明 Aether 下载发布接口、下载地址约定，以及 macOS manifest 协议。

## 概览

Aether 下载服务分为两个发布渠道：

- **公开渠道** (`/download/`)：正式发布，支持版本化目录、manifest、OSS 推送
- **测试版渠道** (`/downloadbeta/`)：测试发布，结构与公开渠道一致，但版本索引和 OSS 存储与公开渠道隔离

信息站点中的"手动安装"下载链接不再维护独立 manual 包，直接指向公开渠道的 `/download/latest/<filename>`，由服务端解析到当前最新公开版本。

每个渠道都有独立的管理员 OSS 直传接口。

**重要**：公开渠道和测试版渠道要求配置 `DOWNLOAD_OSS_PUBLIC_BASE_URL`，下载时通过 302 重定向到 OSS。未配置时下载接口会返回错误。

当前支持的平台：

- macOS Apple Silicon
- macOS Intel
- Windows x64
- Linux x64
- Linux ARM64

## 基础约定

下载根路径：

```text
https://aether.aiphys.cn/download       # 公开渠道
https://aether.aiphys.cn/downloadbeta   # 测试版渠道
```

管理员 OSS 直传接口（公开渠道）：

```text
POST https://aether.aiphys.cn/api/download/admin/presign   # 获取预签名 URL
POST https://aether.aiphys.cn/api/download/admin/commit     # 提交元数据，触发服务端处理
```

管理员 OSS 直传接口（测试版渠道）：

```text
POST https://aether.aiphys.cn/api/downloadbeta/admin/presign   # 获取预签名 URL
POST https://aether.aiphys.cn/api/downloadbeta/admin/commit     # 提交元数据，触发服务端处理
```

公开渠道版本目录约定：

- 最新通道：`/download/latest/`
- 解析规则：`latest` 会解析到当前可用的最新公开版本，不限制大版本号
- 指定版本：`/download/<version>/`

例如：

- `/download/latest/mac-arm64.yml`
- `/download/latest/aether-darwin-arm64.dmg`
- `/download/1.3.3/mac-arm64.yml`
- `/download/1.3.3/aether-darwin-arm64.dmg`

测试版渠道版本目录约定：

- 最新通道：`/downloadbeta/latest/`
- 解析规则：`latest` 会解析到当前可用的最新测试版，不影响公开渠道
- 指定版本：`/downloadbeta/<version>/`

例如：

- `/downloadbeta/latest/mac-arm64.yml`
- `/downloadbeta/latest/aether-darwin-arm64.dmg`
- `/downloadbeta/1.3.3-beta.1/mac-arm64.yml`
- `/downloadbeta/1.3.3-beta.1/aether-darwin-arm64.dmg`

## 公开渠道 OSS 直传上传

服务端配置了 `ALIYUN_OSS_*` 环境变量后，大文件从客户端直传 OSS，不经过服务器中转，速度更快、节省服务器带宽。

流程分为三步：

1. **presign** — 获取各平台文件的 OSS 预签名 PUT URL
2. **upload** — 客户端并行直传文件到 OSS
3. **commit** — 通知服务端计算校验信息、生成 manifest、更新版本记录

### Step 1: 获取预签名 URL

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/download/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体示例：

```json
{
  "mac": { "version": "1.3.3" },
  "macIntel": { "version": "1.3.3" },
  "windows": { "version": "1.3.3" },
  "linux": { "version": "1.3.3" },
  "linuxArm64": { "version": "1.3.3" }
}
```

响应示例：

```json
{
  "ok": true,
  "platforms": {
    "mac": {
      "archive": {
        "objectKey": "1.3.3/aether-darwin-arm64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/aether-darwin-arm64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "1.3.3/update_darwin.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/update_darwin.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "macIntel": {
      "archive": {
        "objectKey": "1.3.3/aether-darwin-x64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/aether-darwin-x64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "1.3.3/update_darwin_x64.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/update_darwin_x64.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "windows": { ... },
    "linux": { ... },
    "linuxArm64": {
      "archive": {
        "objectKey": "1.3.3/aether-linux-arm64.zip",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/aether-linux-arm64.zip?x-oss-signature-version=...",
        "contentType": "application/zip"
      },
      "installer": {
        "objectKey": "1.3.3/update_linux_arm64.sh",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/1.3.3/update_linux_arm64.sh?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    }
  },
  "expiresInSeconds": 1800
}
```

### Step 2: 直传文件到 OSS

使用预签名 URL 将文件 PUT 到 OSS：

```bash
# 并行上传三个平台的主包
curl -X PUT \
  -H 'Content-Type: application/x-apple-diskimage' \
  --data-binary @aether-darwin-arm64.dmg \
  '<mac archive presigned url>' &

curl -X PUT \
  -H 'Content-Type: application/zip' \
  --data-binary @aether-windows-x64.zip \
  '<windows archive presigned url>' &

curl -X PUT \
  -H 'Content-Type: application/zip' \
  --data-binary @aether-linux-x64.zip \
  '<linux archive presigned url>' &

wait
```

### Step 3: 提交元数据

所有文件上传到 OSS 后，调用 commit 接口通知服务端完成后续处理。

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/download/admin/commit`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体示例：

```json
{
  "mac": { "version": "1.3.3" },
  "macIntel": { "version": "1.3.3" },
  "windows": { "version": "1.3.3" },
  "linux": { "version": "1.3.3" },
  "linuxArm64": { "version": "1.3.3" },
  "releaseDate": "2026-04-13T00:00:00.000Z"
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `<platform>.version` | 是 | 该平台的版本号 |
| `releaseDate` | 否 | ISO 时间字符串，不传由服务端生成 |

响应格式与公开上传接口相同。

服务端处理流程：

1. 从 OSS 下载各平台的安装包（走内网，速度快）
2. 计算安装包的 `sha512` 和 `size`
3. 生成 manifest 并写入 OSS 的 `{version}/` 目录
4. 更新 `downloads/latest-versions.json`

服务端不会把安装包、版本安装脚本或 manifest 写入本地 `downloads/{version}/` 或 `downloads/latest/`。运行时唯一允许写入 `downloads/` 的文件是 `downloads/latest-versions.json`。

### 公开安装器 OSS key

下载页的安装器链接会重定向到 OSS 的固定 `installer/` 前缀，不走版本目录：

```text
installer/aether_windows_installer.bat
installer/aether_darwin_installer.command
installer/aether_darwin_x64_installer.command
installer/aether_linux_installer.sh
installer/aether_linux_arm64_installer.sh
```

如果 OSS 返回 `NoSuchKey`，要先确认上传的是上面的完整 key。尤其 Linux ARM64 安装器必须是：

```text
installer/aether_linux_arm64_installer.sh
```

`installer/aether_linux_installer_arm64.sh` 是另一个不同对象，上传这个名字不会被 `/download/installer/aether_linux_arm64_installer.sh` 命中。

## 测试版渠道 OSS 直传上传

测试版渠道用于发布可被客户端自动更新读取的 beta 产物。接口协议与公开渠道一致，但存储、版本索引和下载路径必须与公开渠道隔离。
下载成功统计也与公开渠道隔离：页面下载路由上报 `download_channel = 'download_beta'`，API 下载路由上报 `download_channel = 'api_download_beta'`。

流程分为三步：

1. **presign** — 获取各平台文件的 OSS 预签名 PUT URL
2. **upload** — 客户端并行直传文件到 OSS
3. **commit** — 通知服务端计算校验信息、生成 manifest、更新测试版版本记录

### Step 1: 获取预签名 URL

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/downloadbeta/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体与公开渠道相同：

```json
{
  "mac": { "version": "1.3.3-beta.1" },
  "macIntel": { "version": "1.3.3-beta.1" },
  "windows": { "version": "1.3.3-beta.1" },
  "linux": { "version": "1.3.3-beta.1" },
  "linuxArm64": { "version": "1.3.3-beta.1" }
}
```

响应格式与公开渠道相同。测试版对象必须写入独立 OSS 前缀，建议使用 `beta/<version>/...`：

```json
{
  "ok": true,
  "platforms": {
    "mac": {
      "archive": {
        "objectKey": "beta/1.3.3-beta.1/aether-darwin-arm64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/aether-darwin-arm64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "beta/1.3.3-beta.1/update_darwin.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/update_darwin.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "macIntel": {
      "archive": {
        "objectKey": "beta/1.3.3-beta.1/aether-darwin-x64.dmg",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/aether-darwin-x64.dmg?x-oss-signature-version=...",
        "contentType": "application/x-apple-diskimage"
      },
      "installer": {
        "objectKey": "beta/1.3.3-beta.1/update_darwin_x64.command",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/update_darwin_x64.command?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    },
    "windows": { ... },
    "linux": { ... },
    "linuxArm64": {
      "archive": {
        "objectKey": "beta/1.3.3-beta.1/aether-linux-arm64.zip",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/aether-linux-arm64.zip?x-oss-signature-version=...",
        "contentType": "application/zip"
      },
      "installer": {
        "objectKey": "beta/1.3.3-beta.1/update_linux_arm64.sh",
        "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/beta/1.3.3-beta.1/update_linux_arm64.sh?x-oss-signature-version=...",
        "contentType": "text/x-shellscript; charset=utf-8"
      }
    }
  },
  "expiresInSeconds": 1800
}
```

### Step 2: 直传文件到 OSS

上传方式与公开渠道相同，使用 presign 响应中的 URL 执行 PUT。

### Step 3: 提交元数据

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/downloadbeta/admin/commit`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体与公开渠道相同：

```json
{
  "mac": { "version": "1.3.3-beta.1" },
  "macIntel": { "version": "1.3.3-beta.1" },
  "windows": { "version": "1.3.3-beta.1" },
  "linux": { "version": "1.3.3-beta.1" },
  "linuxArm64": { "version": "1.3.3-beta.1" },
  "releaseDate": "2026-04-13T00:00:00.000Z"
}
```

服务端处理流程：

1. 从 OSS 的 `beta/<version>/` 前缀读取各平台安装包
2. 计算安装包的 `sha512` 和 `size`
3. 生成 manifest 并写入 OSS 的 `beta/<version>/` 目录
4. 更新测试版 latest 索引，建议使用 `downloads/beta-latest-versions.json` 或 OSS 内等价独立对象

测试版 commit 响应中的下载链接必须指向 `/downloadbeta`，例如：

```json
{
  "ok": true,
  "releaseDate": "2026-04-13T00:00:00.000Z",
  "files": [
    {
      "platform": "mac",
      "version": "1.3.3-beta.1",
      "url": "/downloadbeta/1.3.3-beta.1/aether-darwin-arm64.dmg",
      "latestUrl": "/downloadbeta/latest/aether-darwin-arm64.dmg",
      "manifestUrl": "/downloadbeta/1.3.3-beta.1/mac-arm64.yml",
      "latestManifestUrl": "/downloadbeta/latest/mac-arm64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "installerUrl": "/downloadbeta/1.3.3-beta.1/update_darwin.command",
      "latestInstallerUrl": "/downloadbeta/latest/update_darwin.command"
    }
  ]
}
```

## 手动安装包下载接口

信息站点前端"手动安装"链接直接使用公开渠道最新安装包，无需维护独立 manual 对象。

下载路径：

```text
/download/latest/aether-darwin-arm64.dmg
/download/latest/aether-darwin-x64.dmg
/download/latest/aether-windows-x64.zip
/download/latest/aether-linux-x64.zip
/download/latest/aether-linux-arm64.zip
```

说明：

- `latest` 会按平台解析到当前最新公开版本
- 通过 302 重定向到 OSS 公开地址
- 下载成功后按公开渠道上报 analytics 事件

## 下载接口

### 下载模式

公开渠道和测试版渠道要求配置 `DOWNLOAD_OSS_PUBLIC_BASE_URL`，通过 302 重定向到 OSS 对象地址。未配置时返回错误。

例如：

- `/download/latest/aether-darwin-arm64.dmg` 会先解析 `latest` 到具体版本（如 `1.4.1`），再重定向到 `https://<bucket-endpoint>/1.4.1/aether-darwin-arm64.dmg`
- `/downloadbeta/latest/aether-darwin-arm64.dmg` 会先解析测试版 `latest` 到具体版本（如 `1.4.2-beta.1`），再重定向到 `https://<bucket-endpoint>/beta/1.4.2-beta.1/aether-darwin-arm64.dmg`
- `/download/1.3.3/aether-windows-x64.zip` 会重定向到 `https://<bucket-endpoint>/1.3.3/aether-windows-x64.zip`
- `/download/1.3.3/aether-linux-arm64.zip` 会重定向到 `https://<bucket-endpoint>/1.3.3/aether-linux-arm64.zip`
- `/downloadbeta/1.3.3-beta.1/aether-windows-x64.zip` 会重定向到 `https://<bucket-endpoint>/beta/1.3.3-beta.1/aether-windows-x64.zip`
- `/downloadbeta/1.3.3-beta.1/aether-linux-arm64.zip` 会重定向到 `https://<bucket-endpoint>/beta/1.3.3-beta.1/aether-linux-arm64.zip`

### 最新通道

客户端可以通过 `latest` 路由获取某个平台当前发布的最新公开版本：

- `/download/latest/mac-arm64.yml`
- `/download/latest/mac-x64.yml`
- `/download/latest/windows-x64.yml`
- `/download/latest/linux-x64.yml`
- `/download/latest/linux-arm64.yml`

对应安装包：

- `/download/latest/aether-darwin-arm64.dmg`
- `/download/latest/update_darwin.command`
- `/download/latest/aether-darwin-x64.dmg`
- `/download/latest/update_darwin_x64.command`
- `/download/latest/aether-windows-x64.zip`
- `/download/latest/update_windows.bat`
- `/download/latest/aether-linux-x64.zip`
- `/download/latest/update_linux.sh`
- `/download/latest/aether-linux-arm64.zip`
- `/download/latest/update_linux_arm64.sh`

解析规则：

- `latest` 会在公开版本目录中选择当前最新版本
- 例如同时存在 `1.3.9`、`1.4.0`、`1.4.1` 时，`latest` 会解析到 `1.4.1`
- 如果某个平台在最新版本下没有对应文件，则会继续向下寻找更早的可用版本

测试版渠道使用相同文件名和解析规则，但根路径改为 `/downloadbeta`，且只读取测试版版本索引：

- `/downloadbeta/latest/mac-arm64.yml`
- `/downloadbeta/latest/mac-x64.yml`
- `/downloadbeta/latest/windows-x64.yml`
- `/downloadbeta/latest/linux-x64.yml`
- `/downloadbeta/latest/linux-arm64.yml`
- `/downloadbeta/latest/aether-darwin-arm64.dmg`
- `/downloadbeta/latest/update_darwin.command`
- `/downloadbeta/latest/aether-darwin-x64.dmg`
- `/downloadbeta/latest/update_darwin_x64.command`
- `/downloadbeta/latest/aether-windows-x64.zip`
- `/downloadbeta/latest/update_windows.bat`
- `/downloadbeta/latest/aether-linux-x64.zip`
- `/downloadbeta/latest/update_linux.sh`
- `/downloadbeta/latest/aether-linux-arm64.zip`
- `/downloadbeta/latest/update_linux_arm64.sh`

### 指定版本

客户端也可以显式拉取某个版本：

- `/download/<version>/mac-arm64.yml`
- `/download/<version>/mac-x64.yml`
- `/download/<version>/windows-x64.yml`
- `/download/<version>/linux-x64.yml`
- `/download/<version>/linux-arm64.yml`

对应安装包：

- `/download/<version>/aether-darwin-arm64.dmg`
- `/download/<version>/update_darwin.command`
- `/download/<version>/aether-darwin-x64.dmg`
- `/download/<version>/update_darwin_x64.command`
- `/download/<version>/aether-windows-x64.zip`
- `/download/<version>/update_windows.bat`
- `/download/<version>/aether-linux-x64.zip`
- `/download/<version>/update_linux.sh`
- `/download/<version>/aether-linux-arm64.zip`
- `/download/<version>/update_linux_arm64.sh`

测试版渠道的指定版本路径同样只需把根路径替换为 `/downloadbeta`：

- `/downloadbeta/<version>/mac-arm64.yml`
- `/downloadbeta/<version>/mac-x64.yml`
- `/downloadbeta/<version>/windows-x64.yml`
- `/downloadbeta/<version>/linux-x64.yml`
- `/downloadbeta/<version>/aether-darwin-arm64.dmg`
- `/downloadbeta/<version>/update_darwin.command`
- `/downloadbeta/<version>/aether-darwin-x64.dmg`
- `/downloadbeta/<version>/update_darwin_x64.command`
- `/downloadbeta/<version>/aether-windows-x64.zip`
- `/downloadbeta/<version>/update_windows.bat`
- `/downloadbeta/<version>/aether-linux-x64.zip`
- `/downloadbeta/<version>/update_linux.sh`

## macOS Manifest 协议

mac 客户端应优先读取：

```text
/download/latest/mac-arm64.yml
```

这里的 `latest` 同样表示"解析到当前最新公开版本的 manifest"，不是要求客户端访问某个固定目录。

或：

```text
/download/<version>/mac-arm64.yml
```

测试版自动更新客户端应把本机 `Global.Path.config/update-config.jsonc` 配置为测试版下载根路径：

```jsonc
{
  "updateBaseUrl": "https://aether.aiphys.cn/downloadbeta"
}
```

各系统默认配置文件位置：

- Windows: `C:\Users\<user>\.config\aether\update-config.jsonc`
- macOS: `~/.config/aether/update-config.jsonc`
- Linux: `~/.config/aether/update-config.jsonc`

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
| `installer.url` | 更新脚本文件名 |
| `installer.size` | 更新脚本字节数 |
| `files[0]` | 向后兼容字段，内容与 `package` 对应 |
| `releaseDate` | 发布时间 |

接入建议：

- 新客户端优先读取 `package`
- 如果存在 `installer`，可按产品流程决定是否额外下载并执行更新脚本
- 如果 `package` 不存在，可回退读取 `files[0]`
- `package.url` 和 `installer.url` 可能是相对路径，客户端应按 manifest 所在目录解析

## 上传响应

公开渠道 commit 成功时返回 `200 OK`，响应体示例：

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
      "latestInstallerUrl": "/download/latest/update_darwin.command"
    },
    {
      "platform": "macIntel",
      "version": "1.3.3",
      "url": "/download/1.3.3/aether-darwin-x64.dmg",
      "latestUrl": "/download/latest/aether-darwin-x64.dmg",
      "manifestUrl": "/download/1.3.3/mac-x64.yml",
      "latestManifestUrl": "/download/latest/mac-x64.yml",
      "sha512": "<base64-sha512>",
      "size": 93444053,
      "installerUrl": "/download/1.3.3/update_darwin_x64.command",
      "latestInstallerUrl": "/download/latest/update_darwin_x64.command"
    }
  ]
}
```

OSS 上传失败时的响应示例：

```json
{
  "ok": true,
  "releaseDate": "2026-04-02T07:12:00.000Z",
  "ossWarnings": [
    { "objectKey": "1.3.3/mac-arm64.yml", "error": "OSS upload failed: 403 ..." }
  ],
  "files": [...]
}
```

说明：

- `url` / `manifestUrl` 指向指定版本目录
- `latestUrl` / `latestManifestUrl` 指向 `latest` 别名，服务端会解析到当前最新版本
- `ossWarnings` 仅在部分文件上传失败时出现

## 错误响应

常见错误：

| HTTP 状态码 | 含义 |
| --- | --- |
| `400` | 请求格式错误、缺少版本号、版本格式非法、`releaseDate` 非法 |
| `403` | 管理员密码错误 |
| `500` | 服务端未配置 `DOWNLOAD_ADMIN_PASSWORD` 或 `DOWNLOAD_OSS_PUBLIC_BASE_URL` |

错误响应示例：

```json
{
  "error": "Invalid releaseDate"
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

- [presign.ts](../src/pages/api/download/admin/presign.ts)（公开渠道 OSS 直传预签名）
- [commit.ts](../src/pages/api/download/admin/commit.ts)（公开渠道 OSS 直传提交）
- [presign.ts](../src/pages/api/downloadbeta/admin/presign.ts)（测试版渠道 OSS 直传预签名）
- [commit.ts](../src/pages/api/downloadbeta/admin/commit.ts)（测试版渠道 OSS 直传提交）
- [download-upload.ts](../src/lib/server/download-upload.ts)
- [downloads.ts](../src/lib/server/downloads.ts)
- [oss.ts](../src/lib/server/oss.ts)
