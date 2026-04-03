@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=https://aether.aiphys.cn/download"
set "META_URL=%BASE%/latest-web-windows.yml"
set "META_URL_OLD=%BASE%/latest-web.yml"

set "SELF=%~dp0"
if "%SELF:~-1%"=="\" set "SELF=%SELF:~0,-1%"

if exist "%SELF%\aether.exe" if exist "%SELF%\Aether.vbs" (
  set "APP=%SELF%"
) else if exist "%SELF%\..\aether.exe" if exist "%SELF%\..\Aether.vbs" (
  for %%i in ("%SELF%\..") do set "APP=%%~fi"
) else (
  set "APP=%USERPROFILE%\Applications\Aether-Web"
)

for %%i in ("%APP%") do (
  set "NAME=%%~nxi"
  set "PARENT=%%~dpi"
)

set "STATE=%APP%\.aether_web_version"
set "TMP=%TEMP%\aether-web-update-%RANDOM%%RANDOM%"
set "META=%TMP%\latest-web-windows.yml"
set "ZIP=%TMP%\aether-windows-x64-web.zip"
set "EXTRACT=%TMP%\extract"
set "SRC_FILE=%TMP%\src.txt"
set "NEXT=%TMP%\next"
set "HAS_APP=0"

if exist "%APP%\aether.exe" if exist "%APP%\Aether.vbs" set "HAS_APP=1"

if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%TMP%" || exit /b 1

echo [1/4] Checking remote version...
powershell -NoProfile -Command "& { try { Invoke-WebRequest -UseBasicParsing -Uri $env:META_URL -OutFile $env:META } catch { Invoke-WebRequest -UseBasicParsing -Uri $env:META_URL_OLD -OutFile $env:META } }" || goto :fail

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$m=Get-Content -Raw -Path $env:META; if($m -match '(?m)^version:\s*(.+)$'){ $matches[1].Trim() }"`) do set "VER_REMOTE=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$m=Get-Content -Raw -Path $env:META; if($m -match '(?m)^\s*-\s*url:\s*(.+)$'){ $matches[1].Trim() }"`) do set "URL_REMOTE=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$m=Get-Content -Raw -Path $env:META; if($m -match '(?m)^\s*sha512:\s*(.+)$'){ $matches[1].Trim() }"`) do set "SHA_REMOTE=%%i"

if "%VER_REMOTE%"=="" (
  echo Failed to read remote version from %META_URL%
  goto :fail
)

if "%URL_REMOTE%"=="" set "URL_REMOTE=aether-windows-x64-web.zip"

set "VER_LOCAL="
if exist "%STATE%" set /p VER_LOCAL=<"%STATE%"

echo Local version: %VER_LOCAL%
echo Remote version: %VER_REMOTE%

if "%HAS_APP%"=="1" if "%VER_LOCAL%"=="%VER_REMOTE%" (
  echo Already up to date.
  goto :ok
)

echo [2/4] Downloading new version...
powershell -NoProfile -Command "& { Invoke-WebRequest -UseBasicParsing -Uri ($env:BASE + '/' + $env:URL_REMOTE) -OutFile $env:ZIP }" || goto :fail

if not "%SHA_REMOTE%"=="" (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$h=[Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($env:ZIP)); [Convert]::ToBase64String($h)"`) do set "SHA_LOCAL=%%i"
  if /I not "!SHA_LOCAL!"=="%SHA_REMOTE%" (
    echo SHA512 mismatch. Stop update.
    goto :fail
  )
)

echo [3/4] Installing new version...
if exist "%NEXT%" rmdir /s /q "%NEXT%"
if exist "%EXTRACT%" rmdir /s /q "%EXTRACT%"
mkdir "%NEXT%" || goto :fail
mkdir "%EXTRACT%" || goto :fail

powershell -NoProfile -Command "& { Expand-Archive -Path $env:ZIP -DestinationPath $env:EXTRACT -Force; $src=$env:EXTRACT; if(-not ((Test-Path (Join-Path $src 'aether.exe')) -and (Test-Path (Join-Path $src 'Aether.vbs')))) { $dirs=Get-ChildItem -Path $env:EXTRACT -Directory; if($dirs.Count -eq 1) { $d=$dirs[0].FullName; if((Test-Path (Join-Path $d 'aether.exe')) -and (Test-Path (Join-Path $d 'Aether.vbs'))) { $src=$d } else { throw 'Bad package layout' } } else { throw 'Bad package layout' } }; [IO.File]::WriteAllText($env:SRC_FILE, $src) }" || goto :fail

set "SRC="
if exist "%SRC_FILE%" set /p SRC=<"%SRC_FILE%"
if "%SRC%"=="" (
  echo Missing valid app folder in new package.
  goto :fail
)

if not exist "%SRC%\aether.exe" (
  echo Missing aether.exe in new package.
  goto :fail
)

if not exist "%SRC%\Aether.vbs" (
  echo Missing Aether.vbs in new package.
  goto :fail
)

robocopy "%SRC%" "%NEXT%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo Failed to stage files. Robocopy exit code: %RC%
  goto :fail
)

powershell -NoProfile -Command "& { [IO.File]::WriteAllText((Join-Path $env:NEXT '.aether_web_version'), $env:VER_REMOTE) }" || goto :fail

if "%HAS_APP%"=="1" (
  robocopy "%NEXT%" "%APP%" /MIR /XF update_windows_web.bat /NFL /NDL /NJH /NJS /NP >nul
  set "RC=%ERRORLEVEL%"
  if !RC! GEQ 8 (
    echo Failed to apply files. Robocopy exit code: !RC!
    echo DEBUG APP=[%APP%]
    goto :fail
  )
) else (
  if exist "%APP%" (
    echo Target directory exists but is not a valid installation: %APP%
    echo Please clean this directory or run this script from an existing install folder.
    goto :fail
  )
  for %%i in ("%APP%") do set "APP_PARENT=%%~dpi"
  if not exist "%APP_PARENT%" mkdir "%APP_PARENT%" || goto :fail
  robocopy "%NEXT%" "%APP%" /MIR /XF update_windows_web.bat /NFL /NDL /NJH /NJS /NP >nul
  set "RC=%ERRORLEVEL%"
  if !RC! GEQ 8 (
    echo Failed to install files. Robocopy exit code: !RC!
    goto :fail
  )
)

echo [4/4] Deleting old version files...
if "%HAS_APP%"=="1" (
  echo Done. Current version: %VER_REMOTE%
) else (
  echo Installed. Current version: %VER_REMOTE%
  echo Install path: %APP%
)
goto :ok

:fail
echo Update failed.
rmdir /s /q "%TMP%" >nul 2>nul
exit /b 1

:ok
rmdir /s /q "%TMP%" >nul 2>nul
exit /b 0
