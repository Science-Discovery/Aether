@echo off
setlocal

for %%i in ("%~dp0..") do set "ROOT=%%~fi"
if "%~1"=="" (
  for /f %%i in ('cd /d "%ROOT%" ^& bun -e "const p=await Bun.file('packages/opencode/package.json').json();console.log(p.version)"') do set "VERSION=%%i"
) else (
  set "VERSION=%~1"
)

cd /d "%ROOT%\packages\opencode" || exit /b 1
call bun install || exit /b 1
call bun run --cwd "%ROOT%\packages\app" build || exit /b 1
call bun run build -- --single --skip-install --skip-web --skip-smoke || exit /b 1

set "SRC=%CD%\dist\aether-windows-x64\bin"
if not exist "%SRC%" (
  echo Missing %SRC%. Run this on windows x64.
  exit /b 1
)

set "UV=%SRC%\wechat-bridge\runtime\uv"
set "PKG=aether-windows-x64"
set "TMP=%TEMP%\aether-web-pack-%RANDOM%%RANDOM%"
set "OUT=%TMP%\%PKG%"
if exist "%UV%" (
  powershell -NoProfile -Command "& { $uv=$env:UV; Get-ChildItem -Path $uv -Directory | Where-Object { $_.Name -notlike '*x86_64-pc-windows-msvc*' } | Remove-Item -Recurse -Force }" || exit /b 1
)

if exist "%TMP%" rmdir /s /q "%TMP%"
mkdir "%OUT%" || exit /b 1

robocopy "%SRC%" "%OUT%" /E /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo Failed to stage files. Robocopy exit code: %RC%
  rmdir /s /q "%TMP%" >nul 2>nul
  exit /b 1
)

set "INS=%ROOT%\Update\aether_windows_installer.bat"
if exist "%INS%" (
  copy /y "%INS%" "%OUT%\aether_windows_installer.bat" >nul || exit /b 1
)

set "ICON=%ROOT%\icon-source\gen\icon.ico"
if exist "%ICON%" copy /y "%ICON%" "%OUT%\aether-icon.ico" >nul

if exist "%OUT%\.aether_version" del /f /q "%OUT%\.aether_version" >nul 2>nul
powershell -NoProfile -Command "& { [IO.File]::WriteAllText((Join-Path $env:OUT '.aether_web_version'), $env:VERSION) }" || exit /b 1

powershell -NoProfile -Command "& { $crlf=[char]13+[char]10; $txt=@('Aether Web (Windows x64)','', 'Quick start', '1) Extract this ZIP and copy the folder aether-windows-x64 to a local path, for example: C:\Aether-Web', '2) In that folder, double click Aether.vbs', '', 'Updates', '- Use Aether''s in-app update flow to download and install newer versions.') -join $crlf; Set-Content -Path (Join-Path $env:OUT 'README_FIRST.txt') -Value ($txt + $crlf) -Encoding ascii }" || exit /b 1

set "ZIP=%CD%\dist\aether-windows-x64.zip"
if exist "%ZIP%" del /f /q "%ZIP%"
powershell -NoProfile -Command "& { Compress-Archive -Path $env:OUT -DestinationPath $env:ZIP -CompressionLevel Optimal }" || exit /b 1

set "YML=%CD%\dist\latest-web-windows.yml"
set "ART=%ZIP%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$art=$env:ART; $ver=$env:VERSION; $yml=$env:YML; $url=[IO.Path]::GetFileName($art); $sha=[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($art))); $size=(Get-Item $art).Length; $date=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.000Z'); $lines=@(('version: '+$ver),('files:'),('  - url: '+$url),('    sha512: '+$sha),('    size: '+$size),('releaseDate: '+$date)); [IO.File]::WriteAllLines($yml, $lines)" || exit /b 1

rmdir /s /q "%TMP%" >nul 2>nul

echo Done
echo Asset: %ZIP%
echo YML:   %YML%
echo Note:  ZIP includes folder %PKG% and aether_windows_installer.bat
