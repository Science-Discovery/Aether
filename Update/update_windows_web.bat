@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "BASE=https://aether.aiphys.cn/download"
set "META_URL=%BASE%/latest-web-windows.yml"
set "META_URL_OLD=%BASE%/latest-web.yml"
set "HOLD=1"
set "RETRY=3"
set "DELAY=2"
set "CTO=10"
set "TMO=1800"

if /I "%~1"=="--no-pause" set "HOLD="

set "SELF=%~dp0"
if "%SELF:~-1%"=="\" set "SELF=%SELF:~0,-1%"
set "CACHE=%SELF%\aether-windows-x64-web.zip"
set "STAMP=%SELF%\.aether_web_package_version"

if exist "%SELF%\aether.exe" if exist "%SELF%\Aether.vbs" (
  set "APP=%SELF%"
) else if exist "%SELF%\..\aether.exe" if exist "%SELF%\..\Aether.vbs" (
  for %%i in ("%SELF%\..") do set "APP=%%~fi"
) else (
  set "APP=%SELF%"
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

mkdir "%TMP%" || (
  echo Failed to create temp folder: %TMP%
  call :hold
  exit /b 1
)

echo [1/4] Checking remote version...
call :fetch "%META_URL%" "%META%" meta || call :fetch "%META_URL_OLD%" "%META%" meta || (
  echo Failed to download version metadata.
  goto :fail
)

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
echo Source: %BASE%/%URL_REMOTE%
echo Retry: %RETRY%  Connect timeout: %CTO%s  Total timeout: %TMO%s
call :reuse || call :fetch "%BASE%/%URL_REMOTE%" "%ZIP%" file || goto :fail

if not "%SHA_REMOTE%"=="" (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$h=[Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($env:ZIP)); [Convert]::ToBase64String($h)"`) do set "SHA_LOCAL=%%i"
  if /I not "!SHA_LOCAL!"=="%SHA_REMOTE%" (
    echo SHA512 mismatch. Stop update.
    goto :fail
  )
)

call :stash || goto :fail

echo [3/4] Installing new version...
if exist "%NEXT%" rmdir /s /q "%NEXT%"
if exist "%EXTRACT%" rmdir /s /q "%EXTRACT%"
mkdir "%NEXT%" || goto :fail
mkdir "%EXTRACT%" || goto :fail

powershell -NoProfile -Command "& { Expand-Archive -Path $env:ZIP -DestinationPath $env:EXTRACT -Force; $hit=Get-ChildItem -Path $env:EXTRACT -Filter 'aether.exe' -File -Recurse | Where-Object { Test-Path (Join-Path $_.DirectoryName 'Aether.vbs') } | Sort-Object { $_.DirectoryName.Length } | Select-Object -First 1; if(-not $hit) { throw 'Missing aether.exe or Aether.vbs in package' }; [IO.File]::WriteAllText($env:SRC_FILE, $hit.DirectoryName) }" || goto :fail

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
  robocopy "%NEXT%" "%APP%" /MIR /NFL /NDL /NJH /NJS /NP >nul
  set "RC=!ERRORLEVEL!"
  if !RC! GEQ 8 (
    echo Failed to apply files. Robocopy exit code: !RC!
    goto :fail
  )
) else (
  if exist "%APP%" (
    echo Target directory exists but is not a valid installation: %APP%
    echo Please clean this directory or run this script from an existing install folder.
    goto :fail
  )
  move "%NEXT%" "%APP%" >nul || goto :fail
)

if exist "%APP%\package.json" (
  where bun >nul 2>nul
  if errorlevel 1 (
    echo package.json found but bun is missing. Install bun and retry.
    goto :fail
  )
  pushd "%APP%" || goto :fail
  call bun install || (
    popd
    echo bun install failed.
    goto :fail
  )
  popd
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
call :hold
exit /b 1

:ok
rmdir /s /q "%TMP%" >nul 2>nul
call :hold
exit /b 0

:fetch
set "URL=%~1"
set "OUT=%~2"
set "MODE=%~3"
where curl.exe >nul 2>nul
if not errorlevel 1 (
  if /I "%MODE%"=="meta" (
    curl.exe --fail --location --silent --show-error --connect-timeout %CTO% --max-time %TMO% --retry %RETRY% --retry-delay %DELAY% --retry-all-errors --output "%OUT%" "%URL%"
  ) else (
    curl.exe --fail --location --progress-bar --connect-timeout %CTO% --max-time %TMO% --retry %RETRY% --retry-delay %DELAY% --retry-all-errors --output "%OUT%" "%URL%"
  )
  set "RC=!ERRORLEVEL!"
  exit /b !RC!
)

echo curl.exe not found. Falling back to PowerShell download...
powershell -NoProfile -Command "& { Invoke-WebRequest -UseBasicParsing -Uri $env:URL -OutFile $env:OUT }"
exit /b %ERRORLEVEL%

:reuse
if not exist "%CACHE%" exit /b 1
if not exist "%STAMP%" exit /b 1
set "CACHED="
set /p CACHED=<"%STAMP%"
if /I not "%CACHED%"=="%VER_REMOTE%" exit /b 1
echo Using cached package: %CACHE%
copy /y "%CACHE%" "%ZIP%" >nul
exit /b %ERRORLEVEL%

:stash
if not exist "%ZIP%" exit /b 0
copy /y "%ZIP%" "%CACHE%" >nul || exit /b 1
> "%STAMP%" <nul set /p =%VER_REMOTE%
echo Package cached at: %CACHE%
exit /b 0

:hold
if not defined HOLD exit /b 0
echo.
powershell -NoProfile -Command "& { Write-Host 'Press Esc to close...'; while(([Console]::ReadKey($true)).Key -ne 'Escape') {} }"
exit /b 0
