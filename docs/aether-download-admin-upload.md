# Aether Download API 说明

本文档面向客户端开发者，说明 Aether 下载发布接口、下载地址约定，以及 macOS manifest 协议。

## 概览

Aether 下载服务分为三个渠道：

- **公开渠道** (`/download/`)：正式发布，支持版本化目录、manifest、OSS 推送
- **私有测试渠道** (`/api/download2/`)：开发者测试产物，需鉴权，与公开渠道隔离
- **手动安装渠道** (`/manual/`)：前端"手动安装"链接指向此渠道，仅存储 `latest` 安装包，无需鉴权

每个渠道都有独立的管理员上传接口和独立的存储目录。

**重要**：公开渠道和手动安装渠道要求配置 `DOWNLOAD_OSS_PUBLIC_BASE_URL`，下载时通过 302 重定向到 OSS。未配置时下载接口会返回错误。

当前支持的平台：

- macOS Apple Silicon
- Windows x64
- Linux x64

## 基础约定

下载根路径：

```text
https://aether.aiphys.cn/download
```

管理员 OSS 直传接口（公开渠道）：

```text
POST https://aether.aiphys.cn/api/download/admin/presign   # 获取预签名 URL
POST https://aether.aiphys.cn/api/download/admin/commit     # 提交元数据，触发服务端处理
```

管理员 OSS 直传接口（手动安装渠道）：

```text
POST https://aether.aiphys.cn/api/manual/admin/presign      # 获取预签名 URL
```

开发者私有测试下载接口：

```text
GET https://aether.aiphys.cn/api/download2/...
```

开发者私有测试上传接口：

```text
POST https://aether.aiphys.cn/api/download2/admin/upload
```

手动安装包下载接口：

```text
GET https://aether.aiphys.cn/manual/latest/<filename>
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

## 公开渠道 OSS 直传上传

服务端配置了 `ALIYUN_OSS_*` 环境变量后，大文件从客户端直传 OSS，不经过服务器中转，速度更快、节省服务器带宽。

流程分为三步：

1. **presign** — 获取各平台文件的 OSS 预签名 PUT URL
2. **upload** — 客户端并行直传文件到 OSS
3. **commit** — 通知服务端完成本地写入、manifest 生成、版本记录等后续处理

### Step 1: 获取预签名 URL

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/download/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体示例：

```json
{
  "mac": { "version": "1.3.3" },
  "windows": { "version": "1.3.3" },
  "linux": { "version": "1.3.3" }
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
    "windows": { ... },
    "linux": { ... }
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
  "mac": { "version": "1.3.3", "hasInstaller": true },
  "windows": { "version": "1.3.3", "hasInstaller": true },
  "linux": { "version": "1.3.3", "hasInstaller": true },
  "releaseDate": "2026-04-13T00:00:00.000Z"
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `<platform>.version` | 是 | 该平台的版本号 |
| `<platform>.hasInstaller` | 否 | 是否上传了安装脚本，默认 `false` |
| `releaseDate` | 否 | ISO 时间字符串，不传由服务端生成 |

响应格式与公开上传接口相同。

服务端处理流程：

1. 从 OSS 下载各平台的安装包（走内网，速度快）
2. 计算安装包的 `sha512` 和 `size`
3. 生成 manifest 并写入本地和 OSS
4. 将安装包和安装脚本写入本地 `downloads/{version}/` 和 `downloads/latest/`
5. 更新 `downloads/latest-versions.json`

## 手动安装渠道 OSS 直传上传

手动安装渠道的文件直传到 OSS 后即生效，无需 commit 步骤（用户下载时直接 302 重定向到 OSS）。

流程分为两步：

1. **presign** — 获取各平台文件的 OSS 预签名 PUT URL
2. **upload** — 客户端并行直传文件到 OSS

### Step 1: 获取预签名 URL

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/manual/admin/presign`
- Content-Type: `application/json`
- 鉴权：请求头 `x-download-admin-password`

请求体示例：

```json
{
  "platforms": ["mac", "windows", "linux"]
}
```

响应示例：

```json
{
  "ok": true,
  "platforms": {
    "mac": {
      "objectKey": "manual/latest/aether-darwin-arm64.dmg",
      "url": "https://aether-asset.oss-cn-beijing.aliyuncs.com/manual/latest/aether-darwin-arm64.dmg?x-oss-signature-version=...",
      "contentType": "application/x-apple-diskimage"
    },
    "windows": {
      "objectKey": "manual/latest/aether-windows-x64.zip",
      "url": "...",
      "contentType": "application/zip"
    },
    "linux": {
      "objectKey": "manual/latest/aether-linux-x64.zip",
      "url": "...",
      "contentType": "application/zip"
    }
  },
  "expiresInSeconds": 1800
}
```

### Step 2: 直传文件到 OSS

```bash
curl -X PUT \
  -H 'Content-Type: application/x-apple-diskimage' \
  --data-binary @aether-darwin-arm64.dmg \
  '<mac presigned url>' &

curl -X PUT \
  -H 'Content-Type: application/zip' \
  --data-binary @aether-windows-x64.zip \
  '<windows presigned url>' &

curl -X PUT \
  -H 'Content-Type: application/zip' \
  --data-binary @aether-linux-x64.zip \
  '<linux presigned url>' &

wait
```

上传完成后，用户即可通过 `/manual/latest/<filename>` 下载。

## 开发者私有测试上传接口

该接口用于上传"仅供开发者测试"的最新产物，不会更新公开下载版本。

- Method: `POST`
- URL: `https://aether.aiphys.cn/api/download2/admin/upload`
- Content-Type: `multipart/form-data`
- 鉴权：请求头 `x-download-admin-password` 或表单字段 `password`

写入行为：

1. 只覆盖 `downloads2/latest/`
2. 不写入 `downloads2/<version>/`
3. 不影响公开 `/download/latest/...` 的版本解析结果
4. 上传成功后应通过 `/api/download2/latest/...` 访问测试产物

### 文件字段

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

### 上传示例

```bash
curl -X POST https://aether.aiphys.cn/api/download2/admin/upload \
  -H 'x-download-admin-password: <your-password>' \
  -F 'macVersion=1.4.1-dev' \
  -F 'macos=@aether-darwin-arm64.dmg' \
  -F 'macInstaller=@update_darwin.command'
```

### 上传响应

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
      "latestInstallerUrl": "/api/download2/latest/update_darwin.command"
    }
  ]
}
```

## 手动安装包下载接口

该接口供前端"手动安装"链接使用，无需鉴权。

下载路径：

```text
/manual/latest/aether-darwin-arm64.dmg
/manual/latest/aether-windows-x64.zip
/manual/latest/aether-linux-x64.zip
```

说明：

- 通过 302 重定向到 OSS 公开地址
- 下载成功后自动上报 analytics 事件（`download_channel = 'manual'`）

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

## 下载接口

### 下载模式

公开渠道和手动安装渠道要求配置 `DOWNLOAD_OSS_PUBLIC_BASE_URL`，通过 302 重定向到 OSS 对象地址。未配置时返回错误。

例如：

- `/download/latest/aether-darwin-arm64.dmg` 会先解析 `latest` 到具体版本（如 `1.4.1`），再重定向到 `https://<bucket-endpoint>/1.4.1/aether-darwin-arm64.dmg`
- `/download/1.3.3/aether-windows-x64.zip` 会重定向到 `https://<bucket-endpoint>/1.3.3/aether-windows-x64.zip`
- `/manual/latest/aether-darwin-arm64.dmg` 会重定向到 `https://<bucket-endpoint>/manual/latest/aether-darwin-arm64.dmg`

私有测试渠道始终从本地文件系统读取，不经过 OSS 重定向。

### 最新通道

客户端可以通过 `latest` 路由获取某个平台当前发布的最新公开版本：

- `/download/latest/mac-arm64.yml`
- `/download/latest/windows-x64.yml`
- `/download/latest/linux-x64.yml`

对应安装包：

- `/download/latest/aether-darwin-arm64.dmg`
- `/download/latest/update_darwin.command`
- `/download/latest/aether-windows-x64.zip`
- `/download/latest/update_windows.bat`
- `/download/latest/aether-linux-x64.zip`
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
- `/download/<version>/update_darwin.command`
- `/download/<version>/aether-windows-x64.zip`
- `/download/<version>/update_windows.bat`
- `/download/<version>/aether-linux-x64.zip`
- `/download/<version>/update_linux.sh`

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
| `installer.url` | 可选更新脚本文件名 |
| `installer.size` | 可选更新脚本字节数 |
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
    { "objectKey": "1.3.3/aether-darwin-arm64.dmg", "error": "OSS upload failed: 403 ..." }
  ],
  "files": [...]
}
```

说明：

- `url` / `manifestUrl` 指向指定版本目录
- `latestUrl` / `latestManifestUrl` 指向 `latest` 别名，服务端会解析到当前最新版本
- `installerUrl` 与 `latestInstallerUrl` 在未上传对应平台安装脚本时为 `null`
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

- [presign.ts](/root/aether-site/src/pages/api/download/admin/presign.ts)（公开渠道 OSS 直传预签名）
- [commit.ts](/root/aether-site/src/pages/api/download/admin/commit.ts)（公开渠道 OSS 直传提交）
- [presign.ts](/root/aether-site/src/pages/api/manual/admin/presign.ts)（手动安装渠道 OSS 直传预签名）
- [upload.ts](/root/aether-site/src/pages/api/download2/admin/upload.ts)（私有测试渠道上传）
- [download-upload.ts](/root/aether-site/src/lib/server/download-upload.ts)
- [downloads.ts](/root/aether-site/src/lib/server/downloads.ts)
- [oss.ts](/root/aether-site/src/lib/server/oss.ts)
