@echo off
setlocal

set "ROOT=%~dp0"
if "%~1"=="" (
  for /f %%i in ('cd /d "%ROOT%" ^& bun -e "const p=await Bun.file('packages/desktop-electron/package.json').json();console.log(p.version)"') do set "VERSION=%%i"
) else (
  set "VERSION=%~1"
)

cd /d "%ROOT%packages\desktop-electron" || exit /b 1
set "OPENCODE_CHANNEL=prod"
set "OPENCODE_UPDATER_CHANNEL=latest"
set "RUST_TARGET=x86_64-pc-windows-msvc"

call bun run build || exit /b 1
call npx electron-builder --win nsis --x64 --publish never --config electron-builder.config.ts || exit /b 1

set "ART=%CD%\dist\aether-desktop-win-x64.exe"
if not exist "%ART%" (
  for %%f in ("%CD%\dist\*win*x64*.exe") do (
    if exist "%%~ff" (
      set "ART=%%~ff"
      goto :asset_ok
    )
  )
  echo No windows x64 exe found in packages\desktop-electron\dist
  exit /b 1
)

:asset_ok
set "YML=%CD%\dist\latest.yml"
set "ART=%ART%"
set "VERSION=%VERSION%"
set "YML=%YML%"

powershell -NoProfile -Command "& { $art=$env:ART; $ver=$env:VERSION; $yml=$env:YML; $url=[IO.Path]::GetFileName($art); $sha=[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($art))); $size=(Get-Item $art).Length; $date=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.000Z'); $txt=@('version: ' + $ver,'files:','  - url: ' + $url,'    sha512: ' + $sha,'    size: ' + $size,'releaseDate: ' + $date) -join "`n"; Set-Content -Path $yml -Value ($txt + "`n") -Encoding utf8 }" || exit /b 1

echo Done
echo Asset: %ART%
echo YML:   %YML%
