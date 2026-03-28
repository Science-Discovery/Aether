@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: Aether + WeChat Bridge 启动脚本 (Windows 批处理)

set "PORT=4096"
if defined AETHER_PORT set "PORT=%AETHER_PORT%"

set "SCRIPT_DIR=%~dp0"
set "SKILL_DIR=%SCRIPT_DIR%.."
set "AETHER_DIR=%SKILL_DIR%\.."
set "AETHER_BIN=%AETHER_DIR%\bin\aether.exe"
set "WECHAT_BRIDGE=%SKILL_DIR%\assets\wechat-bridge"

echo ==========================================
echo   Aether + WeChat Bridge (Windows)
echo ==========================================
echo.

if not exist "%AETHER_BIN%" (
    echo 错误: 找不到 Aether 二进制文件
    echo 路径: %AETHER_BIN%
    echo.
    echo 请确保目录结构正确:
    echo   aether-windows-x64\
    echo   ├── bin\aether.exe
    echo   └── wechat-bridge-skill\
    echo       ├── scripts\start-windows.bat
    echo       └── assets\wechat-bridge\
    exit /b 1
)

if not exist "%WECHAT_BRIDGE%" (
    echo 错误: 找不到微信桥接目录
    echo 路径: %WECHAT_BRIDGE%
    exit /b 1
)

:: 检查 Python
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "PYTHON_CMD=python"
) else (
    where python3 >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        set "PYTHON_CMD=python3"
    ) else (
        echo 错误: 需要安装 Python 3.11+
        echo 建议: 从 https://www.python.org/downloads/ 下载安装
        exit /b 1
    )
)

for /f "tokens=*" %%i in ('%PYTHON_CMD% --version 2^>^&1') do set PYTHON_VERSION=%%i
echo [检查] Python 版本: %PYTHON_VERSION%

:: 检查虚拟环境
set "VENV_PATH=%WECHAT_BRIDGE%\venv"
set "ACTIVATE_SCRIPT=%VENV_PATH%\Scripts\activate.bat"

if not exist "%VENV_PATH%" (
    echo [创建] Python 虚拟环境...
    %PYTHON_CMD% -m venv "%VENV_PATH%"
    if !ERRORLEVEL! neq 0 (
        echo 错误: 虚拟环境创建失败
        exit /b 1
    )
)

call "%ACTIVATE_SCRIPT%"

:: 检查依赖
python -c "import wechat_agent_sdk" >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [安装] 正在安装微信桥接依赖...
    pip install -r "%WECHAT_BRIDGE%\requirements.txt"
    if !ERRORLEVEL! neq 0 (
        echo 错误: 依赖安装失败
        exit /b 1
    )
)

echo.

echo [启动] Aether 服务 (端口: %PORT%)...
start /b "" "%AETHER_BIN%" serve --port %PORT%

echo [等待] Aether 服务启动中...
set "WAITED=0"
set "MAX_WAIT=15"
set "STARTED=0"

:wait_loop
if %WAITED% geq %MAX_WAIT% goto :wait_done
curl -s "http://127.0.0.1:%PORT%/path" >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "STARTED=1"
    goto :wait_done
)
timeout /t 1 /nobreak >nul
set /a WAITED+=1
goto :wait_loop

:wait_done
if %STARTED% equ 0 (
    echo 错误: Aether 服务启动失败
    taskkill /f /im aether.exe >nul 2>&1
    exit /b 1
)

echo [成功] Aether 服务已启动
echo.

set "AETHER_WORK_DIR=%AETHER_DIR%"

echo [启动] 微信桥接...
echo [提示] 请用微信扫描下方二维码登录
echo.
echo ----------------------------------------

cd /d "%WECHAT_BRIDGE%"
python aether_wechat_agent.py

echo.
echo [清理] 正在关闭服务...
taskkill /f /im aether.exe >nul 2>&1
echo [清理] Aether 服务已停止