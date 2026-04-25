@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=https://aether.aiphys.cn/downloadbeta"
set "LATEST=latest/windows-x64.yml"
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "DEFAULT=%LOCALAPPDATA%\Programs\aether"
set "WORK_DEFAULT=%USERPROFILE%\.local\share\aether\update\aether"
set "MODE=init"
set "ARG="
set "PATH_ARG="
set "MIRROR="
set "NOHOLD=0"
set "HOLD="

set "OK=0"
set "READY=10"
set "MANUAL_READY=11"
set "LATEST_OK=20"
set "MISS=21"
set "META_ERR=30"
set "DL_ERR=31"
set "SUM_ERR=32"
set "RUN_ERR=33"
set "DIR_ERR=40"
set "ARG_ERR=50"

set "CTO=15"
set "TMO=1800"
set "RETRY=3"
set "DELAY=2"
set "KEEP=3"

:parse
if "%~1"=="" goto :parse_done
if /I "%~1"=="--no-pause" (
  set "NOHOLD=1"
  shift
  goto :parse
)
if /I "%~1"=="--path" (
  if "%~2"=="" (
    echo --path needs a value
    exit /b %ARG_ERR%
  )
  set "PATH_ARG=%~2"
  shift
  shift
  goto :parse
)
if /I "%~1"=="init" set "MODE=init" & shift & goto :parse
if /I "%~1"=="auto" set "MODE=auto" & shift & goto :parse
if /I "%~1"=="manual" set "MODE=manual" & shift & goto :parse
if /I "%~1"=="help" set "MODE=help" & shift & goto :parse
if /I "%~1"=="-h" set "MODE=help" & shift & goto :parse
if /I "%~1"=="--help" set "MODE=help" & shift & goto :parse
if not defined ARG (
  set "ARG=%~1"
  shift
  goto :parse
)
echo Unsupported argument: %~1
exit /b %ARG_ERR%

:parse_done

if /I "%MODE%"=="help" goto :help
if /I "%MODE%"=="init" if "%NOHOLD%"=="0" set "HOLD=1"

set "WORK="
set "CUR="
set "REQ="
set "VER="
set "PKG="
set "SHA="
set "INS="
set "NOTE="
set "PKG_URL="
set "INS_URL="
set "NOTE_URL="
set "PKG_NAME="
set "INS_NAME="
set "PKG_FILE="
set "INS_FILE="
set "DL="
set "MANIFEST_URL="
set "RES="
set "RES_FILE="
set "FETCH_HTTP="

if /I "%MODE%"=="init" goto :init
if /I "%MODE%"=="auto" goto :auto
if /I "%MODE%"=="manual" goto :manual

echo Unsupported mode: %MODE%
goto :bad

:normalize
set "IN=%~1"
set "BASE_NAME="
for %%i in ("%IN%") do set "BASE_NAME=%%~ni"
if /I "%BASE_NAME%"=="aether" (
  set "%~2=%IN%"
) else (
  set "%~2=%IN%\aether"
)
exit /b 0

:init
echo Aether Windows Installer
echo.
set "WORK=%WORK_DEFAULT%"
if defined PATH_ARG (
  call :normalize "%PATH_ARG%" MIRROR
) else (
  set "MIRROR=%DEFAULT%"
)
echo Work directory:
echo   %WORK%
echo Install directory:
echo   %MIRROR%
call :prep "%WORK%" || goto :dir_fail

set "CUR="
call :latest || goto :meta_fail
call :print_latest
call :installed "%MIRROR%" CUR
if defined CUR (
  call :cmp "%CUR%" "%VER%"
  if /I "!CMP!"=="eq" (
    set "RES=up_to_date"
    call :result
    call :print_uptodate "!CUR!" "%VER%"
    goto :done
  )
)
call :cached_ready
if errorlevel 1 (
  call :grab || goto :dl_fail
) else (
  call :print_cached
)
set "RES=init_ready"
call :result

call :print_downloaded

if "%INS_FILE%"=="" (
  set "RES=run_error"
  call :result
  call :print_install_missing
  goto :run_fail
)

call :print_init_run
set "AETHER_MIRROR_ROOT=%MIRROR%"
set "AETHER_CURRENT_DIR=%MIRROR%\aether_%VER%"
call "%INS_FILE%" "%VER%" --restart
if errorlevel 1 (
  set "RES=run_error"
  call :result
  call :print_install_fail "%INS_FILE%"
  goto :run_fail
)

goto :done

:auto
call :work WORK
call :prep "%WORK%" || goto :dir_fail
call :latest || goto :meta_fail
call :print_latest
call :grab || goto :dl_fail
set "RES=update_ready"
call :result
exit /b %READY%

:manual
if "%ARG%"=="" (
  call :print_manual_arg
  goto :bad
)
set "CUR="
set "REQ=%ARG%"
call :work WORK
call :prep "%WORK%" || goto :dir_fail
call :version "%REQ%"
set "RC=%ERRORLEVEL%"
if "%RC%"=="%MISS%" (
  set "VER=%REQ%"
  set "RES=version_missing"
  call :result
  exit /b %MISS%
)
if not "%RC%"=="0" goto :meta_fail
call :print_manual_versions "%REQ%" "%VER%"
call :grab || goto :dl_fail
set "RES=manual_ready"
call :result
exit /b %MANUAL_READY%

:latest
set "MANIFEST_URL=%BASE%/%LATEST%"
call :manifest "%MANIFEST_URL%" latest
exit /b %ERRORLEVEL%

:version
set "MANIFEST_URL=%BASE%/%~1/windows-x64.yml"
call :manifest "%MANIFEST_URL%" version
exit /b %ERRORLEVEL%

:manifest
set "MANIFEST_URL=%~1"
set "KIND=%~2"
set "TMP=%TEMP%\aether-installer-%RANDOM%%RANDOM%"
if exist "%TMP%" rmdir /s /q "%TMP%" >nul 2>nul
mkdir "%TMP%" >nul 2>nul || exit /b %META_ERR%
set "MANIFEST=%TMP%\manifest.yml"
call :fetch_meta "%MANIFEST_URL%" "%MANIFEST%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  if /I "%KIND%"=="version" if "%FETCH_HTTP%"=="404" (
    rmdir /s /q "%TMP%" >nul 2>nul
    exit /b %MISS%
  )
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b %META_ERR%
)

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$sec=''; $ver=''; $pkg=''; $sha=''; $ins=''; $note=''; $clean={ param($v) $v.Trim().Trim([char]39).Trim([char]34) }; foreach($line in Get-Content -Path $env:MANIFEST){ if($line -match '^\s*version:\s*(.+?)\s*$'){ $ver=& $clean $matches[1]; continue }; if($line -match '^\s*package:\s*$'){ $sec='package'; continue }; if($line -match '^\s*installer:\s*$'){ $sec='installer'; continue }; if($line -match '^\s*notes_url:\s*(.+?)\s*$'){ $note=& $clean $matches[1]; continue }; if($line -match '^\S'){ $sec='' }; if($sec -eq 'package' -and $line -match '^\s*url:\s*(.+?)\s*$'){ $pkg=& $clean $matches[1]; continue }; if($sec -eq 'package' -and $line -match '^\s*sha512:\s*(.+?)\s*$'){ $sha=& $clean $matches[1]; continue }; if($sec -eq 'installer' -and $line -match '^\s*url:\s*(.+?)\s*$'){ $ins=& $clean $matches[1]; continue } }; if([string]::IsNullOrEmpty($pkg)){ foreach($line in Get-Content -Path $env:MANIFEST){ if($line -match '^\s*files:\s*$'){ $sec='files'; continue }; if($line -match '^\S'){ $sec='' }; if($sec -eq 'files' -and $line -match '^\s*-\s*url:\s*(.+?)\s*$'){ $pkg=& $clean $matches[1]; continue }; if($sec -eq 'files' -and $line -match '^\s*sha512:\s*(.+?)\s*$'){ $sha=& $clean $matches[1]; continue } } }; 'VER=' + $ver; 'PKG=' + $pkg; 'SHA=' + $sha; 'INS=' + $ins; 'NOTE=' + $note"`) do set "%%i"

if not defined VER (
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b %META_ERR%
)
if not defined PKG (
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b %META_ERR%
)

call :abs PKG_URL "%MANIFEST_URL%" "%PKG%"
if defined INS call :abs INS_URL "%MANIFEST_URL%" "%INS%"
if defined NOTE call :abs NOTE_URL "%MANIFEST_URL%" "%NOTE%"
for %%i in ("%PKG_URL%") do set "PKG_NAME=%%~nxi"
if defined INS_URL for %%i in ("%INS_URL%") do set "INS_NAME=%%~nxi"
rmdir /s /q "%TMP%" >nul 2>nul
exit /b 0

:grab
set "DL=%WORK%\downloads"
if not exist "%DL%" mkdir "%DL%" >nul 2>nul || exit /b %DIR_ERR%

for %%i in ("%PKG_NAME%") do set "PKG_EXT=%%~xi"
set "PKG_FILE=%DL%\aether-windows-x64-%VER%%PKG_EXT%"
set "INS_FILE="
set "NEED_PKG=1"

if exist "%PKG_FILE%" (
  if not defined SHA (
    set "NEED_PKG=0"
  ) else (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$h=[Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($env:PKG_FILE)); [Convert]::ToBase64String($h)"`) do set "SUM=%%i"
    if /I "!SUM!"=="!SHA!" set "NEED_PKG=0"
  )
)

if "%NEED_PKG%"=="1" (
  echo Downloading package:
  echo   %PKG_URL%
  call :fetch_file "%PKG_URL%" "%PKG_FILE%" || exit /b %DL_ERR%
) else (
  echo Using cached package:
  echo   %PKG_FILE%
)

if defined SHA (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$h=[Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($env:PKG_FILE)); [Convert]::ToBase64String($h)"`) do set "SUM=%%i"
  if /I not "!SUM!"=="!SHA!" exit /b %SUM_ERR%
)

if defined INS_URL if defined INS_NAME (
  for %%i in ("!INS_NAME!") do set "INS_EXT=%%~xi"
  set "INS_FILE=!DL!\update_windows-!VER!!INS_EXT!"
  if exist "!INS_FILE!" (
    echo Using cached installer:
    echo   !INS_FILE!
  ) else (
    echo Downloading installer:
    echo   !INS_URL!
    call :fetch_file "!INS_URL!" "!INS_FILE!" || exit /b %DL_ERR%
  )
)

call :prune
exit /b 0

:prune
set "DL=%WORK%\downloads"
powershell -NoProfile -Command "$dl=$env:DL; $keep=[int]$env:KEEP; if(-not (Test-Path $dl)){ exit 0 }; $a=Get-ChildItem -Path $dl -File -Filter 'aether-windows-x64-*' | Sort-Object Name; if($a.Count -gt $keep){ $a | Select-Object -First ($a.Count-$keep) | Remove-Item -Force }; $b=Get-ChildItem -Path $dl -File -Filter 'update_windows-*.bat' | Sort-Object Name; if($b.Count -gt $keep){ $b | Select-Object -First ($b.Count-$keep) | Remove-Item -Force }"
exit /b 0

:result
if not defined WORK exit /b 0
if not defined DL set "DL=%WORK%\downloads"
if not exist "%DL%" mkdir "%DL%" >nul 2>nul || exit /b 0
set "RES_FILE=%DL%\last-result.yml"
set "CODE=%OK%"
if /I "%RES%"=="update_ready" set "CODE=%READY%"
if /I "%RES%"=="manual_ready" set "CODE=%MANUAL_READY%"
if /I "%RES%"=="up_to_date" set "CODE=%LATEST_OK%"
if /I "%RES%"=="version_missing" set "CODE=%MISS%"
if /I "%RES%"=="meta_error" set "CODE=%META_ERR%"
if /I "%RES%"=="download_error" set "CODE=%DL_ERR%"
if /I "%RES%"=="checksum_error" set "CODE=%SUM_ERR%"
if /I "%RES%"=="run_error" set "CODE=%RUN_ERR%"
if /I "%RES%"=="dir_error" set "CODE=%DIR_ERR%"
if /I "%RES%"=="arg_error" set "CODE=%ARG_ERR%"

powershell -NoProfile -Command "$q={ param([string]$v) if([string]::IsNullOrEmpty($v)){ return '''''' }; return '''' + ($v -replace '''','''''''') + '''' }; $lines=@(('mode: ' + (& $q $env:MODE)),('status: ' + (& $q $env:RES)),('code: ' + $env:CODE),('current_version: ' + (& $q $env:CUR)),('target_version: ' + (& $q $env:VER)),('requested_version: ' + (& $q $env:REQ)),('work_dir: ' + (& $q $env:WORK)),('download_dir: ' + (& $q $env:DL)),('package_path: ' + (& $q $env:PKG_FILE)),('installer_path: ' + (& $q $env:INS_FILE)),('manifest_url: ' + (& $q $env:MANIFEST_URL)),('notes_url: ' + (& $q $env:NOTE_URL)),('mirror_root: ' + (& $q $env:MIRROR))); [IO.File]::WriteAllLines($env:RES_FILE, $lines)"
exit /b 0

:cmp
set "A=%~1"
set "B=%~2"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$a=$env:A; $b=$env:B; function norm([string]$v){ if($null -eq $v -or $v -eq ''){ return $null }; $v=$v.Trim(); $v=$v -replace '^v',''; $v=$v.Split('-')[0]; $p=$v.Split('.'); while($p.Count -lt 4){ $p += '0' }; if($p.Count -gt 4){ $p=$p[0..3] }; [string]::Join('.', $p) }; $x=norm $a; $y=norm $b; if($null -eq $x -or $null -eq $y){ if($a -eq $b){ 'eq' } else { 'lt' }; exit 0 }; if(([version]$x) -lt ([version]$y)){ 'lt' } elseif(([version]$x) -gt ([version]$y)){ 'gt' } else { 'eq' }"`) do set "CMP=%%i"
exit /b 0

:work
if defined AETHER_WORK_DIR (
  set "%~1=%AETHER_WORK_DIR%"
  exit /b 0
)
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
for %%i in ("%DIR%") do set "NAME=%%~nxi"
if /I "!NAME:~0,7!"=="aether_" (
  for %%i in ("%DIR%\..") do set "%~1=%%~fi"
  exit /b 0
)
set "%~1=%DIR%"
exit /b 0

:prep
set "DIR=%~1"
if exist "%DIR%" exit /b 0
mkdir "%DIR%" >nul 2>nul || exit /b 1
exit /b 0

:installed
set "%~2="
set "DIR=%~1"
for %%i in ("%DIR%") do set "NAME=%%~nxi"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$name=$env:NAME; if($name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ [Console]::Write($matches[1]) }"`) do set "%~2=%%i"
if defined %~2 exit /b 0
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$root=$env:DIR; $best=Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending | Select-Object -First 1 -ExpandProperty Ver; if($best){ [Console]::Write($best) }"`) do set "%~2=%%i"
exit /b 0

:cache_paths
for %%i in ("%PKG_NAME%") do set "PKG_EXT=%%~xi"
set "PKG_FILE=%WORK%\downloads\aether-windows-x64-%VER%%PKG_EXT%"
set "INS_FILE="
if defined INS_URL if defined INS_NAME (
  for %%i in ("%INS_NAME%") do set "INS_EXT=%%~xi"
  set "INS_FILE=%WORK%\downloads\update_windows-%VER%%INS_EXT%"
)
exit /b 0

:cached_ready
call :cache_paths
if not exist "%WORK%\downloads" exit /b 1
if not exist "%PKG_FILE%" exit /b 1
if defined SHA (
  set "SUM="
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$h=[Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($env:PKG_FILE)); [Convert]::ToBase64String($h)"`) do set "SUM=%%i"
  if /I not "!SUM!"=="!SHA!" exit /b 1
)
if not defined INS_FILE exit /b 1
if not exist "%INS_FILE%" exit /b 1
exit /b 0

:print_latest
echo.
echo Latest version: %VER%
echo.
exit /b 0

:print_versions
echo Current version: %~1
echo Remote version: %~2
exit /b 0

:print_uptodate
echo.
call :print_versions "%~1" "%~2"
echo Already up to date.
exit /b 0

:print_downloaded
echo.
echo Download finished.
echo Version:   %VER%
echo Package:   %PKG_FILE%
echo Installer: %INS_FILE%
echo Result:    %RES_FILE%
echo.
exit /b 0

:print_cached
echo Using cached package:
echo   %PKG_FILE%
echo Using cached installer:
echo   %INS_FILE%
exit /b 0

:print_install_missing
echo Install step failed: installer script missing in manifest.
exit /b 0

:print_init_run
echo [init] Running installer script...
exit /b 0

:print_install_fail
echo Install step failed while running: %~1
exit /b 0

:print_manual_arg
echo manual mode needs a version.
echo Example: %~nx0 manual 1.2.3
exit /b 0

:print_manual_versions
echo Requested version: %~1
echo Resolved version:  %~2
exit /b 0

:abs
set "VAL=%~3"
if not defined VAL (
  set "%~1="
  exit /b 0
)
set "ABS_URL="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$src=$env:SRC; $val=$env:VAL; if([string]::IsNullOrEmpty($val)){  } else { try { ([Uri]::new(([Uri]$src), $val)).AbsoluteUri } catch {  } }"`) do set "ABS_URL=%%i"
set "%~1=%ABS_URL%"
set "ABS_URL="
exit /b 0

:fetch_meta
set "URL=%~1"
set "OUT=%~2"
set "FETCH_HTTP="
set "META_404=0"
call :detect_git_curl
call :meta_try git
if "%ERRORLEVEL%"=="0" exit /b 0
if "%FETCH_HTTP%"=="404" set "META_404=1"
call :meta_try curl
if "%ERRORLEVEL%"=="0" exit /b 0
if "%FETCH_HTTP%"=="404" set "META_404=1"
call :meta_try iwr
if "%ERRORLEVEL%"=="0" exit /b 0
if "%FETCH_HTTP%"=="404" set "META_404=1"
call :meta_try bits
if "%ERRORLEVEL%"=="0" exit /b 0
if "%META_404%"=="1" set "FETCH_HTTP=404"
exit /b 1

:fetch_file
set "URL=%~1"
set "OUT=%~2"
call :detect_git_curl
call :file_try git
if "%ERRORLEVEL%"=="0" exit /b 0
call :file_try curl
if "%ERRORLEVEL%"=="0" exit /b 0
call :file_try iwr
if "%ERRORLEVEL%"=="0" exit /b 0
call :file_try bits
if "%ERRORLEVEL%"=="0" exit /b 0
exit /b 1

:detect_git_curl
set "GIT_CURL="
if exist "%ProgramFiles%\Git\mingw64\bin\curl.exe" set "GIT_CURL=%ProgramFiles%\Git\mingw64\bin\curl.exe"
if not defined GIT_CURL if exist "%ProgramFiles%\Git\usr\bin\curl.exe" set "GIT_CURL=%ProgramFiles%\Git\usr\bin\curl.exe"
if not defined GIT_CURL if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\Git\mingw64\bin\curl.exe" set "GIT_CURL=%ProgramFiles(x86)%\Git\mingw64\bin\curl.exe"
if not defined GIT_CURL if defined ProgramFiles(x86) if exist "%ProgramFiles(x86)%\Git\usr\bin\curl.exe" set "GIT_CURL=%ProgramFiles(x86)%\Git\usr\bin\curl.exe"
exit /b 0

:meta_try
set "TOOL=%~1"
if /I "%TOOL%"=="git" (
  if not defined GIT_CURL exit /b 1
  echo [meta] Downloader: git curl
  call :curl_meta "%GIT_CURL%"
  exit /b %ERRORLEVEL%
)
if /I "%TOOL%"=="curl" (
  where curl.exe >nul 2>nul
  if errorlevel 1 exit /b 1
  echo [meta] Downloader: curl.exe
  call :curl_meta "curl.exe"
  exit /b %ERRORLEVEL%
)
if /I "%TOOL%"=="iwr" (
  echo [meta] Downloader: Invoke-WebRequest
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "& { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile $env:OUT -PassThru -ErrorAction Stop; [Console]::Out.Write([int]$r.StatusCode) } catch { if(Test-Path $env:OUT){ Remove-Item -LiteralPath $env:OUT -Force -ErrorAction SilentlyContinue }; if($_.Exception.Response){ [Console]::Out.Write([int]$_.Exception.Response.StatusCode) } else { [Console]::Out.Write('000') }; exit 1 } }"`) do set "FETCH_HTTP=%%i"
  if "%FETCH_HTTP%"=="200" exit /b 0
  exit /b 1
)
if /I "%TOOL%"=="bits" (
  echo [meta] Downloader: Start-BitsTransfer
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "& { if(-not (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue)){ [Console]::Out.Write('000'); exit 1 }; try { Start-BitsTransfer -Source $env:URL -Destination $env:OUT -ErrorAction Stop; [Console]::Out.Write('200') } catch { if(Test-Path $env:OUT){ Remove-Item -LiteralPath $env:OUT -Force -ErrorAction SilentlyContinue }; [Console]::Out.Write('000'); exit 1 } }"`) do set "FETCH_HTTP=%%i"
  if "%FETCH_HTTP%"=="200" exit /b 0
  exit /b 1
)
exit /b 1

:file_try
set "TOOL=%~1"
if /I "%TOOL%"=="git" (
  if not defined GIT_CURL exit /b 1
  echo [file] Downloader: git curl
  call :curl_file "%GIT_CURL%"
  exit /b %ERRORLEVEL%
)
if /I "%TOOL%"=="curl" (
  where curl.exe >nul 2>nul
  if errorlevel 1 exit /b 1
  echo [file] Downloader: curl.exe
  call :curl_file "curl.exe"
  exit /b %ERRORLEVEL%
)
if /I "%TOOL%"=="iwr" (
  echo [file] Downloader: Invoke-WebRequest
  powershell -NoProfile -Command "& { try { Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile $env:OUT -ErrorAction Stop } catch { if(Test-Path $env:OUT){ Remove-Item -LiteralPath $env:OUT -Force -ErrorAction SilentlyContinue }; exit 1 } }"
  if errorlevel 1 exit /b 1
  exit /b 0
)
if /I "%TOOL%"=="bits" (
  echo [file] Downloader: Start-BitsTransfer
  powershell -NoProfile -Command "& { if(-not (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue)){ exit 1 }; try { Start-BitsTransfer -Source $env:URL -Destination $env:OUT -ErrorAction Stop } catch { if(Test-Path $env:OUT){ Remove-Item -LiteralPath $env:OUT -Force -ErrorAction SilentlyContinue }; exit 1 } }"
  if errorlevel 1 exit /b 1
  exit /b 0
)
exit /b 1

:curl_meta
set "BIN=%~1"
set "FETCH_HTTP="
set "HTTP_FILE=%TEMP%\aether-http-%RANDOM%%RANDOM%.txt"
"%BIN%" --location --silent --show-error --connect-timeout %CTO% --max-time %TMO% --retry %RETRY% --retry-delay %DELAY% --output "%OUT%" --write-out "%%{http_code}" "%URL%" > "%HTTP_FILE%"
if exist "%HTTP_FILE%" (
  set /p FETCH_HTTP=<"%HTTP_FILE%"
  del /f /q "%HTTP_FILE%" >nul 2>nul
)
if "%FETCH_HTTP%"=="200" exit /b 0
if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
exit /b 1

:curl_file
set "BIN=%~1"
"%BIN%" --fail --location --progress-bar --connect-timeout %CTO% --max-time %TMO% --retry %RETRY% --retry-delay %DELAY% --retry-all-errors --output "%OUT%" "%URL%"
if errorlevel 1 (
  if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
  exit /b 1
)
exit /b 0

:help
echo Aether Windows Installer
echo.
echo Usage:
echo   %~nx0 [--no-pause] [--path ^<dir^>] init
echo   %~nx0 [--no-pause] auto ^<current-version^>
echo   %~nx0 [--no-pause] manual ^<target-version^>
echo.
echo init mode:
echo   --path specifies the install target directory (default %DEFAULT%)
echo   Work directory is fixed at %WORK_DEFAULT%
echo   Downloads, installs, and mirrors to the target directory
echo.
echo auto mode:
echo   Called by the main app; work directory via AETHER_WORK_DIR
echo.
echo Remote manifests:
echo   %BASE%/%LATEST%
echo   %BASE%/1.2.3/windows-x64.yml
echo.
echo Result file:
echo   work_dir\downloads\last-result.yml
echo.
echo Exit codes:
echo   0   init finished successfully
echo   10  latest update downloaded and ready
echo   11  requested version downloaded and ready
echo   20  already up to date
echo   21  requested version not found
echo   30  manifest or network error
echo   31  download failed
echo   32  checksum mismatch
echo   33  init install run failed
echo   40  work directory error
echo   50  argument error
goto :done

:bad
set "RES=arg_error"
call :result
call :help
exit /b %ARG_ERR%

:meta_fail
set "RES=meta_error"
call :result
echo.
echo Manifest check failed.
if /I "%MODE%"=="init" goto :done_err
exit /b %META_ERR%

:dl_fail
set "RC=%ERRORLEVEL%"
set "RES=download_error"
if "%RC%"=="%SUM_ERR%" set "RES=checksum_error"
call :result
echo.
if "%RC%"=="%SUM_ERR%" (
  echo Checksum verification failed.
) else (
  echo Download failed.
)
if /I "%MODE%"=="init" goto :done_err
exit /b %RC%

:run_fail
if /I "%MODE%"=="init" goto :done_err
exit /b %RUN_ERR%

:dir_fail
set "RES=dir_error"
call :result
echo.
echo Work directory failed.
if /I "%MODE%"=="init" goto :done_err
exit /b %DIR_ERR%

:done_err
call :hold
exit /b 1

:done
call :hold
exit /b 0

:hold
if not defined HOLD exit /b 0
echo.
powershell -NoProfile -Command "& { if(-not [Environment]::UserInteractive){ exit 0 }; try { Write-Host 'Press Esc to close...'; while(([Console]::ReadKey($true)).Key -ne 'Escape') {} } catch { exit 0 } }"
exit /b 0
