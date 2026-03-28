# Aether + WeChat Bridge 启动脚本 (Windows PowerShell)

param(
    [string]$Port = $env:AETHER_PORT
)

if (-not $Port) { $Port = "4096" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillDir = Split-Path -Parent $ScriptDir
$AetherDir = Split-Path -Parent $SkillDir
$AetherBin = Join-Path $AetherDir "bin\aether.exe"
$WechatBridge = Join-Path $SkillDir "assets\wechat-bridge"

$AetherProcess = $null

function Cleanup {
    Write-Host ""
    Write-Host "[清理] 正在关闭服务..." -ForegroundColor Yellow
    if ($AetherProcess -and !$AetherProcess.HasExited) {
        Stop-Process -Id $AetherProcess.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[清理] Aether 服务已停止 (PID: $($AetherProcess.Id))" -ForegroundColor Yellow
    }
    exit 0
}

trap { Cleanup }

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Aether + WeChat Bridge (Windows)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $AetherBin)) {
    Write-Host "错误: 找不到 Aether 二进制文件" -ForegroundColor Red
    Write-Host "路径: $AetherBin"
    Write-Host ""
    Write-Host "请确保目录结构正确:"
    Write-Host "  aether-windows-x64\"
    Write-Host "  ├── bin\aether.exe"
    Write-Host "  └── wechat-bridge-skill\"
    Write-Host "      ├── scripts\start-windows.ps1"
    Write-Host "      └── assets\wechat-bridge\"
    exit 1
}

if (-not (Test-Path $WechatBridge)) {
    Write-Host "错误: 找不到微信桥接目录" -ForegroundColor Red
    Write-Host "路径: $WechatBridge"
    exit 1
}

$PythonCmd = $null
if (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonCmd = "python"
} elseif (Get-Command python3 -ErrorAction SilentlyContinue) {
    $PythonCmd = "python3"
} else {
    Write-Host "错误: 需要安装 Python 3.11+" -ForegroundColor Red
    Write-Host "建议: 从 https://www.python.org/downloads/ 下载安装"
    exit 1
}

$PythonVersion = & $PythonCmd --version 2>&1
Write-Host "[检查] Python 版本: $PythonVersion"

$VenvPath = Join-Path $WechatBridge "venv"
$ActivateScript = Join-Path $VenvPath "Scripts\Activate.ps1"

if (-not (Test-Path $VenvPath)) {
    Write-Host "[创建] Python 虚拟环境..." -ForegroundColor Green
    & $PythonCmd -m venv $VenvPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: 虚拟环境创建失败" -ForegroundColor Red
        exit 1
    }
}

& $ActivateScript

$CheckModule = & python -c "import wechat_agent_sdk" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[安装] 正在安装微信桥接依赖..." -ForegroundColor Green
    $RequirementsPath = Join-Path $WechatBridge "requirements.txt"
    & pip install -r $RequirementsPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "错误: 依赖安装失败" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

Write-Host "[启动] Aether 服务 (端口: $Port)..." -ForegroundColor Green
$AetherProcess = Start-Process -FilePath $AetherBin -ArgumentList "serve", "--port", $Port -WindowStyle Hidden -PassThru

Write-Host "[等待] Aether 服务启动中..." -ForegroundColor Green
$MaxWait = 15
$Waited = 0
$Started = $false

while ($Waited -lt $MaxWait) {
    try {
        $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/path" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($Response) {
            $Started = $true
            break
        }
    } catch {}
    Start-Sleep -Seconds 1
    $Waited++
}

if (-not $Started) {
    Write-Host "错误: Aether 服务启动失败" -ForegroundColor Red
    if ($AetherProcess -and !$AetherProcess.HasExited) {
        Stop-Process -Id $AetherProcess.Id -Force -ErrorAction SilentlyContinue
    }
    exit 1
}

Write-Host "[成功] Aether 服务已启动 (PID: $($AetherProcess.Id))" -ForegroundColor Green
Write-Host ""

$env:AETHER_WORK_DIR = $AetherDir

Write-Host "[启动] 微信桥接..." -ForegroundColor Green
Write-Host "[提示] 请用微信扫描下方二维码登录" -ForegroundColor Yellow
Write-Host ""
Write-Host "----------------------------------------"

Set-Location $WechatBridge
& python aether_wechat_agent.py

Cleanup