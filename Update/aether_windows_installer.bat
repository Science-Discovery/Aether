@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=https://aether.aiphys.cn/download"
set "LATEST=latest/windows-x64.yml"
if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "DEFAULT=%LOCALAPPDATA%\Programs\Aether"
set "CTO=15"
set "TMO=1800"
set "RETRY=3"
set "DELAY=2"
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
set "DIR_ERR=40"
set "ARG_ERR=50"

set "ARG1=%~1"
set "ARG2=%~2"
set "ARG3=%~3"

if /I "%ARG1%"=="--no-pause" (
  set "NOHOLD=1"
  set "ARG1=%~2"
  set "ARG2=%~3"
  set "ARG3=%~4"
)

if /I "%ARG1%"=="help" goto :help
if /I "%ARG1%"=="--help" goto :help
if /I "%ARG1%"=="-h" goto :help

set "MODE=%ARG1%"
if "%MODE%"=="" set "MODE=init"

if /I "%MODE%"=="init" (
  if "%NOHOLD%"=="0" set "HOLD=1"
  goto :init
)
if /I "%MODE%"=="auto" goto :auto
if /I "%MODE%"=="manual" goto :manual

echo Unsupported mode: %MODE%
goto :bad

:init
echo Aether Windows Installer
echo.
echo Default work directory:
echo   %DEFAULT%
echo.
set "WORK="
set /p WORK=Press Enter to use default, or input another path: 
if "%WORK%"=="" set "WORK=%DEFAULT%"
call :full WORK "%WORK%"
call :prep "%WORK%" || goto :dir_fail

copy /y "%~f0" "%WORK%\%~nx0" >nul || (
  echo Failed to copy installer to %WORK%
  goto :dir_fail
)

set "CUR="
call :latest || goto :meta_fail
call :grab || goto :dl_fail
set "RES=init_ready"
call :result

echo.
echo Download finished.
echo Version:   %VER%
echo Package:   %PKG_FILE%
echo Installer: %INS_FILE%
echo Result:    %RES_FILE%
echo.
echo Next step:
echo   Let Aether read last-result.yml and continue the installation flow.
goto :done

:auto
if "%ARG2%"=="" (
  echo auto mode needs current version.
  echo Example: %~nx0 auto 1.2.3
  goto :bad
)

set "CUR=%ARG2%"
call :work WORK
call :prep "%WORK%" || goto :dir_fail
call :latest || goto :meta_fail
call :cmp "%CUR%" "%VER%"

if /I "%CMP%"=="lt" (
  echo Current version: %CUR%
  echo Remote version: %VER%
  call :grab || goto :dl_fail
  set "RES=update_ready"
  call :result
  exit /b %READY%
)

echo Current version: %CUR%
echo Remote version: %VER%
echo Already up to date.
set "RES=up_to_date"
call :result
exit /b %LATEST_OK%

:manual
if "%ARG2%"=="" (
  echo manual mode needs a version.
  echo Example: %~nx0 manual 1.2.3
  goto :bad
)

set "CUR="
set "REQ=%ARG2%"
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

echo Requested version: %REQ%
echo Resolved version:  %VER%
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

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$sec=''; $ver=''; $pkg=''; $sha=''; $ins=''; $note=''; foreach($line in Get-Content -Path $env:MANIFEST){ if($line -match '^\s*version:\s*(.+?)\s*$'){ $ver=$matches[1].Trim().Trim("'"); continue }; if($line -match '^\s*package:\s*$'){ $sec='package'; continue }; if($line -match '^\s*installer:\s*$'){ $sec='installer'; continue }; if($line -match '^\s*notes_url:\s*(.+?)\s*$'){ $note=$matches[1].Trim(); continue }; if($line -match '^\S'){ $sec='' }; if($sec -eq 'package' -and $line -match '^\s*url:\s*(.+?)\s*$'){ $pkg=$matches[1].Trim(); continue }; if($sec -eq 'package' -and $line -match '^\s*sha512:\s*(.+?)\s*$'){ $sha=$matches[1].Trim(); continue }; if($sec -eq 'installer' -and $line -match '^\s*url:\s*(.+?)\s*$'){ $ins=$matches[1].Trim(); continue } }; if([string]::IsNullOrEmpty($pkg)){ foreach($line in Get-Content -Path $env:MANIFEST){ if($line -match '^\s*files:\s*$'){ $sec='files'; continue }; if($line -match '^\S'){ $sec='' }; if($sec -eq 'files' -and $line -match '^\s*-\s*url:\s*(.+?)\s*$'){ $pkg=$matches[1].Trim(); continue }; if($sec -eq 'files' -and $line -match '^\s*sha512:\s*(.+?)\s*$'){ $sha=$matches[1].Trim(); continue } } }; 'VER=' + $ver; 'PKG=' + $pkg; 'SHA=' + $sha; 'INS=' + $ins; 'NOTE=' + $note"`) do set "%%i"

if not defined VER (
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b %META_ERR%
)
if not defined PKG (
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b %META_ERR%
)

call :abs PKG_URL "%PKG%"
if defined INS call :abs INS_URL "%INS%"
if defined NOTE call :abs NOTE_URL "%NOTE%"

for %%i in ("%PKG_URL%") do set "PKG_NAME=%%~nxi"
if not defined PKG_NAME (
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b %META_ERR%
)
if defined INS_URL (
  for %%i in ("%INS_URL%") do set "INS_NAME=%%~nxi"
)

rmdir /s /q "%TMP%" >nul 2>nul
exit /b 0

:grab
set "DL=%WORK%\downloads"
if not exist "%DL%" mkdir "%DL%" >nul 2>nul || exit /b %DIR_ERR%

set "PKG_FILE=%DL%\%PKG_NAME%"
set "INS_FILE="

echo Downloading package:
echo   %PKG_URL%
call :fetch_file "%PKG_URL%" "%PKG_FILE%" || exit /b %DL_ERR%

if not defined SHA goto :grab_ins_check
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$h=[Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($env:PKG_FILE)); [Convert]::ToBase64String($h)"`) do set "SUM=%%i"
if /I not "%SUM%"=="%SHA%" exit /b %SUM_ERR%

:grab_ins_check
if not defined INS_URL exit /b 0
if not defined INS_NAME exit /b 0
set "INS_FILE=%DL%\%INS_NAME%"
echo Downloading installer:
echo   %INS_URL%
call :fetch_file "%INS_URL%" "%INS_FILE%" || exit /b %DL_ERR%
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
if /I "%RES%"=="dir_error" set "CODE=%DIR_ERR%"
if /I "%RES%"=="arg_error" set "CODE=%ARG_ERR%"

powershell -NoProfile -Command "$q={ param([string]$v) if([string]::IsNullOrEmpty($v)){ return '''''' }; return '''' + ($v -replace '''','''''''') + '''' }; $lines=@(('mode: ' + (& $q $env:MODE)),('status: ' + (& $q $env:RES)),('code: ' + $env:CODE),('current_version: ' + (& $q $env:CUR)),('target_version: ' + (& $q $env:VER)),('requested_version: ' + (& $q $env:REQ)),('work_dir: ' + (& $q $env:WORK)),('download_dir: ' + (& $q $env:DL)),('package_path: ' + (& $q $env:PKG_FILE)),('installer_path: ' + (& $q $env:INS_FILE)),('manifest_url: ' + (& $q $env:MANIFEST_URL)),('notes_url: ' + (& $q $env:NOTE_URL))); [IO.File]::WriteAllLines($env:RES_FILE, $lines)"
exit /b 0

:cmp
set "A=%~1"
set "B=%~2"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$a=$env:A; $b=$env:B; function norm([string]$v){ if(!$v){ return $null }; $v=$v.Trim(); $v=$v -replace '^v',''; $v=$v.Split('-')[0]; $p=$v.Split('.'); while($p.Count -lt 4){ $p += '0' }; if($p.Count -gt 4){ $p=$p[0..3] }; [string]::Join('.', $p) }; $x=norm $a; $y=norm $b; if(!$x -or !$y){ if($a -eq $b){ 'eq' } else { 'lt' }; exit 0 }; if(([version]$x) -lt ([version]$y)){ 'lt' } elseif(([version]$x) -gt ([version]$y)){ 'gt' } else { 'eq' }"`) do set "CMP=%%i"
exit /b 0

:work
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
for %%i in ("%DIR%") do set "NAME=%%~nxi"
if /I "!NAME:~0,7!"=="aether-" (
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

:full
for %%i in ("%~2") do set "%~1=%%~fi"
exit /b 0

:abs
set "VAL=%~2"
if not defined VAL (
  set "%~1="
  exit /b 0
)
if /I "%VAL:~0,7%"=="http://" (
  set "%~1=%VAL%"
  exit /b 0
)
if /I "%VAL:~0,8%"=="https://" (
  set "%~1=%VAL%"
  exit /b 0
)
if "%VAL:~0,1%"=="/" set "VAL=%VAL:~1%"
set "%~1=%BASE%/%VAL%"
exit /b 0

:fetch_meta
set "URL=%~1"
set "OUT=%~2"
set "FETCH_HTTP="
where curl.exe >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('curl.exe --location --silent --show-error --connect-timeout %CTO% --max-time %TMO% --retry %RETRY% --retry-delay %DELAY% --output "%OUT%" --write-out "%%{http_code}" "%URL%"') do set "FETCH_HTTP=%%i"
  if "%FETCH_HTTP%"=="200" exit /b 0
  if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
  exit /b 1
)

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "& { try { $r=Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile $env:OUT -PassThru; [Console]::Out.Write([int]$r.StatusCode) } catch { if(Test-Path $env:OUT){ Remove-Item -LiteralPath $env:OUT -Force -ErrorAction SilentlyContinue }; if($_.Exception.Response){ [Console]::Out.Write([int]$_.Exception.Response.StatusCode) } else { [Console]::Out.Write('000') }; exit 1 } }"`) do set "FETCH_HTTP=%%i"
if "%FETCH_HTTP%"=="200" exit /b 0
exit /b 1

:fetch_file
set "URL=%~1"
set "OUT=%~2"
where curl.exe >nul 2>nul
if not errorlevel 1 (
  curl.exe --fail --location --progress-bar --connect-timeout %CTO% --max-time %TMO% --retry %RETRY% --retry-delay %DELAY% --retry-all-errors --output "%OUT%" "%URL%"
  exit /b %ERRORLEVEL%
)

echo curl.exe not found. Falling back to PowerShell download...
powershell -NoProfile -Command "& { Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile $env:OUT }"
exit /b %ERRORLEVEL%

:help
echo Aether Windows Installer
echo.
echo Usage:
echo   %~nx0 [--no-pause] init
echo   %~nx0 [--no-pause] auto ^<current-version^>
echo   %~nx0 [--no-pause] manual ^<target-version^>
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

:dir_fail
set "RES=dir_error"
call :result
echo.
echo Work directory failed.
echo Choose another path or make sure the current user can write to this directory.
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
