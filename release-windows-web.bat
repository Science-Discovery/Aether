@echo off
setlocal

set "ROOT=%~dp0"
if "%~1"=="" (
  for /f %%i in ('cd /d "%ROOT%" ^& bun -e "const p=await Bun.file('packages/opencode/package.json').json();console.log(p.version)"') do set "VERSION=%%i"
) else (
  set "VERSION=%~1"
)

cd /d "%ROOT%packages\opencode" || exit /b 1
call bun run build -- --single || exit /b 1

set "SRC=%CD%\dist\aether-windows-x64\bin"
if not exist "%SRC%" (
  echo Missing %SRC%. Run this on windows x64.
  exit /b 1
)

set "UV=%SRC%\wechat-bridge\runtime\uv"
if exist "%UV%" (
  powershell -NoProfile -Command "& { $uv=$env:UV; Get-ChildItem -Path $uv -Directory | Where-Object { $_.Name -notlike '*x86_64-pc-windows-msvc*' } | Remove-Item -Recurse -Force }" || exit /b 1
)

set "ZIP=%CD%\dist\aether-windows-x64-web.zip"
if exist "%ZIP%" del /f /q "%ZIP%"
powershell -NoProfile -Command "& { Compress-Archive -Path '%SRC%\*' -DestinationPath '%ZIP%' -CompressionLevel Optimal }" || exit /b 1

set "YML=%CD%\dist\latest-web.yml"
set "ART=%ZIP%"
set "VERSION=%VERSION%"
set "YML=%YML%"

powershell -NoProfile -Command "& { $art=$env:ART; $ver=$env:VERSION; $yml=$env:YML; $url=[IO.Path]::GetFileName($art); $sha=[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes($art))); $size=(Get-Item $art).Length; $date=(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.000Z'); $txt=@('version: ' + $ver,'files:','  - url: ' + $url,'    sha512: ' + $sha,'    size: ' + $size,'releaseDate: ' + $date) -join "`n"; Set-Content -Path $yml -Value ($txt + "`n") -Encoding utf8 }" || exit /b 1

echo Done
echo Asset: %ZIP%
echo YML:   %YML%
