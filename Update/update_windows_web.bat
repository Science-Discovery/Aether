@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

set "WANT=%~1"
set "RESTART=0"
if /I "%~2"=="--restart" set "RESTART=1"
set "SELF=%~dp0"
if "%SELF:~-1%"=="\" set "SELF=%SELF:~0,-1%"
for %%i in ("%SELF%") do set "BASE=%%~nxi"
for %%i in ("%SELF%\..") do set "WORK=%%~fi"
set "LAUNCH="
set "NOTE="

if /I not "%BASE%"=="downloads" (
  echo 规范错误：update_windows_web.bat 必须放在 ...\Aether\downloads 目录。当前: %SELF%
  exit /b 1
)
for %%i in ("%WORK%") do set "WORK_NAME=%%~nxi"
if /I not "%WORK_NAME%"=="Aether" (
  echo 规范错误：工作目录必须是 ...\Aether。当前: %WORK%
  exit /b 1
)
if not exist "%WORK%\aether_windows_installer.bat" (
  echo 规范错误：缺少 ...\Aether\aether_windows_installer.bat
  exit /b 1
)

echo [0/4] 工作目录: %WORK%

call :pick_pkg "%SELF%" "%WANT%"
if errorlevel 1 (
  echo 未在 ...\Aether\downloads 找到可用 zip（文件名需包含版本号）
  exit /b 1
)

set "TARGET=%WORK%\aether_%VER%"
echo [1/4] 安装包: %PKG_NAME%
echo       目标版本: %VER%

set "TMP=%TEMP%\aether-web-install-%RANDOM%%RANDOM%"
set "EX=%TMP%\extract"
set "NEXT=%WORK%\.aether_%VER%.next"
set "SRC_FILE=%TMP%\src.txt"

call :clean_tmp
mkdir "%EX%" || exit /b 1
mkdir "%NEXT%" || exit /b 1

powershell -NoProfile -Command "& { Expand-Archive -Path $env:PKG -DestinationPath $env:EX -Force; $hit=Get-ChildItem -Path $env:EX -Filter 'aether.exe' -File -Recurse | Where-Object { Test-Path (Join-Path $_.DirectoryName 'Aether.vbs') } | Sort-Object { $_.DirectoryName.Length } | Select-Object -First 1; if(-not $hit){ throw 'missing app files' }; [IO.File]::WriteAllText($env:SRC_FILE, $hit.DirectoryName) }" || goto :fail

set "SRC="
if exist "%SRC_FILE%" set /p SRC=<"%SRC_FILE%"
if "%SRC%"=="" (
  echo 安装包内容缺少 aether.exe 或 Aether.vbs
  goto :fail
)

echo [2/4] 解包并安装到: %TARGET%
robocopy "%SRC%" "%NEXT%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 goto :fail

call :active_dir
set "SMALL=0"
if defined OLD if exist "%OLD%\.aether_web_version" (
  set /p OLD_VER=<"%OLD%\.aether_web_version"
  call :major_minor "%OLD_VER%" OM
  call :major_minor "%VER%" NM
  if /I "%OM%"=="%NM%" set "SMALL=1"
)

if exist "%TARGET%" rmdir /s /q "%TARGET%" >nul 2>nul
move "%NEXT%" "%TARGET%" >nul || goto :fail

echo %VER%>"%TARGET%\.aether_web_version"
echo %VER%>"%WORK%\.aether_web_version"

call :set_current || goto :fail

call :write_launch

if "%RESTART%"=="1" call :restart

if "%SMALL%"=="1" if defined OLD if /I not "%OLD%"=="%TARGET%" (
  echo [3/4] 小版本更新：替换旧目录
  rmdir /s /q "%OLD%" >nul 2>nul
) else (
  echo [3/4] 大版本更新：保留旧版本目录
)

echo [4/4] 完成
echo 当前版本: %VER%
echo 版本目录: %TARGET%
echo 启动入口: %LAUNCH%
if defined NOTE echo %NOTE%

call :clean_tmp
exit /b 0

:write_launch
set "DESK=%USERPROFILE%\Desktop"
if not exist "%DESK%" mkdir "%DESK%"
set "LNK=%DESK%\Aether.lnk"
set "MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
if not exist "%MENU%" mkdir "%MENU%"
set "MLNK=%MENU%\Aether.lnk"
set "CMD=%WORK%\current\Aether.vbs"
if exist "%LNK%" del /f /q "%LNK%" >nul 2>nul
if exist "%MLNK%" del /f /q "%MLNK%" >nul 2>nul
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $mk={ param($p,$t) $s=$w.CreateShortcut($p); $s.TargetPath=$t; $s.WorkingDirectory=(Split-Path -Parent $t); $s.Save() }; & $mk $env:LNK $env:CMD; & $mk $env:MLNK $env:CMD"
if exist "%LNK%" (
  set "LAUNCH=%LNK%"
) else if exist "%MLNK%" (
  set "LAUNCH=%MLNK%"
  set "NOTE=Desktop shortcut failed, Start Menu shortcut created."
) else (
  set "LAUNCH=%CMD%"
  set "NOTE=Desktop and Start Menu shortcuts both failed, using direct launch path."
)
exit /b 0

:restart
powershell -NoProfile -Command "& { $names=@('aether.exe','wscript.exe','cscript.exe','node.exe','bun.exe'); $roots=@(); if($env:OLD){ $roots += [IO.Path]::GetFullPath($env:OLD) }; $roots += [IO.Path]::GetFullPath($env:WORK + '\current'); if($env:TARGET){ $roots += [IO.Path]::GetFullPath($env:TARGET) }; $roots += (Get-ChildItem -Path $env:WORK -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }); $roots=$roots | Where-Object { $_ } | Select-Object -Unique; Get-CimInstance Win32_Process | Where-Object { $n=$_.Name.ToLowerInvariant(); if($names -notcontains $n){ return $false }; $cmd=$_.CommandLine; $exe=$_.ExecutablePath; foreach($r in $roots){ if(($cmd -and $cmd -like ('*' + $r + '*')) -or ($exe -and $exe -like ($r + '*'))){ return $true } }; return $false } | Sort-Object ProcessId -Descending | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"
timeout /t 1 /nobreak >nul
start "" "%WORK%\current\Aether.vbs"
exit /b 0

:active_dir
set "OLD="
if exist "%WORK%\current\.aether_web_version" (
  set "OLD=%WORK%\current"
  exit /b 0
)
if exist "%WORK%\.aether_web_version" (
  set /p RV=<"%WORK%\.aether_web_version"
  if exist "%WORK%\aether_%RV%\.aether_web_version" (
    set "OLD=%WORK%\aether_%RV%"
    exit /b 0
  )
)
for /d %%i in ("%WORK%\aether_*") do (
  if exist "%%~fi\.aether_web_version" (
    set "OLD=%%~fi"
    exit /b 0
  )
)
exit /b 0

:major_minor
set "IN=%~1"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$v=$env:IN; if(!$v){'0.0'; exit}; $v=$v.Trim().TrimStart('v'); $v=$v.Split('-')[0]; $p=$v.Split('.'); if($p.Count -lt 2){$p+= '0'}; ($p[0] + '.' + $p[1])"`) do set "%~2=%%i"
exit /b 0

:pick_pkg
set "DIR=%~1"
set "W=%~2"
set "PKG="
set "VER="
set "PKG_NAME="
for /f "usebackq tokens=1,2,3 delims=|" %%i in (`powershell -NoProfile -Command "$dir=$env:DIR; $want=$env:W; $hits=Get-ChildItem -Path $dir -File -Filter '*.zip' | ForEach-Object { if($_.BaseName -match '([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ [PSCustomObject]@{Path=$_.FullName;Name=$_.Name;Ver=$matches[1]} } } | Where-Object { $_ }; if($want){ $hits=$hits | Where-Object { $_.Ver -eq $want } }; if(-not $hits){ exit 1 }; $pick=$hits | Sort-Object { [version](($_.Ver -replace '^v','').Split('-')[0]) } | Select-Object -Last 1; Write-Output ($pick.Path + '|' + $pick.Ver + '|' + $pick.Name)"`) do (
  set "PKG=%%i"
  set "VER=%%j"
  set "PKG_NAME=%%k"
)
if not defined PKG exit /b 1
exit /b 0

:fail
echo Update failed.
call :clean_tmp
exit /b 1

:clean_tmp
if exist "%TMP%" rmdir /s /q "%TMP%" >nul 2>nul
if exist "%NEXT%" rmdir /s /q "%NEXT%" >nul 2>nul
exit /b 0

:set_current
if exist "%WORK%\current" rmdir "%WORK%\current" >nul 2>nul
if exist "%WORK%\current" rmdir /s /q "%WORK%\current" >nul 2>nul
mklink /J "%WORK%\current" "%TARGET%" >nul 2>nul
if exist "%WORK%\current\Aether.vbs" exit /b 0

mkdir "%WORK%\current" >nul 2>nul
robocopy "%TARGET%" "%WORK%\current" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 exit /b 1
if not exist "%WORK%\current\Aether.vbs" exit /b 1
exit /b 0
