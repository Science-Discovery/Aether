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
set "PRUNE=0"
set "LAUNCH="
set "NOTE="
set "CUR="
set "CMP="
set "RV="

if /I not "%BASE%"=="downloads" (
  echo Spec error: update_windows.bat must be placed in ...\aether\downloads. Current: %SELF%
  exit /b 1
)
for %%i in ("%WORK%") do set "WORK_NAME=%%~nxi"
if /I not "%WORK_NAME%"=="aether" (
  echo Spec error: work directory must be ...\aether. Current: %WORK%
  exit /b 1
)
if not exist "%WORK%\aether_windows_installer.bat" (
  echo Spec error: missing ...\aether\aether_windows_installer.bat
  exit /b 1
)

echo [0/4] Work directory: %WORK%

call :pick_pkg "%SELF%" "%WANT%"
if errorlevel 1 (
  echo No usable zip found in ...\aether\downloads; filename must include a version
  exit /b 1
)

set "TARGET=%WORK%\aether_%VER%"
echo [1/4] Package: %PKG_NAME%
echo       Target version: %VER%

call :installed "%WORK%" CUR
if defined CUR (
  call :cmp "%CUR%" "%VER%"
  if /I "!CMP!"=="eq" (
    echo [2/4] Version %VER% is already installed. Skipping install.
    exit /b 0
  )
)

set "TMP=%TEMP%\aether-install-%RANDOM%%RANDOM%"
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
  echo Package contents missing aether.exe or Aether.vbs
  goto :fail
)

echo [2/4] Extracting and installing to: %TARGET%
robocopy "%SRC%" "%NEXT%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 goto :fail

call :active_dir
if exist "%TARGET%" rmdir /s /q "%TARGET%" >nul 2>nul
move "%NEXT%" "%TARGET%" >nul || goto :fail

echo %VER%>"%TARGET%\.aether_web_version"
if exist "%WORK%\.aether_web_version" del /f /q "%WORK%\.aether_web_version" >nul 2>nul

if exist "%WORK%\current" rmdir "%WORK%\current" >nul 2>nul
if exist "%WORK%\current" rmdir /s /q "%WORK%\current" >nul 2>nul

call :write_launch
call :prune_versions || goto :fail

if "%RESTART%"=="1" call :restart

call :print_prune

echo [4/4] Done
echo Current version: %VER%
echo Version directory: %TARGET%
echo Launch entry: %LAUNCH%
if defined NOTE echo %NOTE%

call :clean_tmp
exit /b 0

:write_launch
set "CMD=%TARGET%\Aether.vbs"
set "OUT=%TEMP%\aether-launch-%RANDOM%%RANDOM%.txt"
if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
powershell -NoProfile -Command "$cmd=$env:CMD; $out=$env:OUT; $w=New-Object -ComObject WScript.Shell; $desk=[Environment]::GetFolderPath('DesktopDirectory'); if(-not $desk){ $desk=$w.SpecialFolders.Item('Desktop') }; $menu=[Environment]::GetFolderPath('Programs'); if(-not $menu){ $menu=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }; $desk2=[Environment]::GetFolderPath('CommonDesktopDirectory'); $menu2=[Environment]::GetFolderPath('CommonPrograms'); $all=@($desk,$menu,$desk2,$menu2) | Where-Object { $_ } | Select-Object -Unique; foreach($dir in $all){ $lnk=Join-Path $dir 'Aether.lnk'; try { if(Test-Path $lnk){ Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop } } catch {} }; $mk={ param($path,$target) try { $dir=Split-Path -Parent $path; if($dir -and -not (Test-Path $dir)){ New-Item -ItemType Directory -Path $dir -Force | Out-Null }; if(Test-Path $path){ Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }; $s=$w.CreateShortcut($path); $s.TargetPath=$target; $s.WorkingDirectory=(Split-Path -Parent $target); $s.Save(); if(-not (Test-Path $path)){ return $false }; $hit=$w.CreateShortcut($path); return $hit.TargetPath -eq $target } catch { return $false } }; $launch=''; $note=''; $desk_ok=$false; $menu_ok=$false; $desk2_ok=$false; $menu2_ok=$false; if($desk){ $desk_ok=& $mk (Join-Path $desk 'Aether.lnk') $cmd }; if($menu){ $menu_ok=& $mk (Join-Path $menu 'Aether.lnk') $cmd }; if($desk2){ $desk2_ok=& $mk (Join-Path $desk2 'Aether.lnk') $cmd }; if($menu2){ $menu2_ok=& $mk (Join-Path $menu2 'Aether.lnk') $cmd }; if($desk_ok){ $launch=Join-Path $desk 'Aether.lnk'; $note='Double-click Aether.vbs on your desktop to run it.' } elseif($desk2_ok){ $launch=Join-Path $desk2 'Aether.lnk'; $note='Double-click Aether.vbs on your desktop to run it.' } elseif($menu_ok){ $launch=Join-Path $menu 'Aether.lnk'; $note='Run Aether.vbs from the Start Menu.' } elseif($menu2_ok){ $launch=Join-Path $menu2 'Aether.lnk'; $note='Run Aether.vbs from the Start Menu.' } else { $launch=$cmd; $note='Shortcut creation failed. Open File Explorer, find this path, and double-click the file to run it.' }; [IO.File]::WriteAllLines($out, @($launch,$note))"
set "LAUNCH=%CMD%"
set "NOTE=Shortcut creation failed. Open File Explorer, find this path, and double-click the file to run it."
if exist "%OUT%" (
  set /p LAUNCH=<"%OUT%"
  for /f "usebackq skip=1 delims=" %%i in ("%OUT%") do (
    set "NOTE=%%i"
    goto :write_launch_done
  )
)
:write_launch_done
if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
exit /b 0

:print_prune
if "%PRUNE%"=="0" (
  echo [3/4] Keeping the latest 5 versions; no older version directories needed removal.
  exit /b 0
)
echo [3/4] Keeping the latest 5 versions; removed %PRUNE% older version directories.
exit /b 0

:restart
powershell -NoProfile -Command "& { $names=@('aether.exe','wscript.exe','cscript.exe','node.exe','bun.exe'); $roots=@(); if($env:OLD){ $roots += [IO.Path]::GetFullPath($env:OLD) }; if($env:TARGET){ $roots += [IO.Path]::GetFullPath($env:TARGET) }; $roots += (Get-ChildItem -Path $env:WORK -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }); $roots=$roots | Where-Object { $_ } | Select-Object -Unique; Get-CimInstance Win32_Process | Where-Object { $n=$_.Name.ToLowerInvariant(); if($names -notcontains $n){ return $false }; $cmd=$_.CommandLine; $exe=$_.ExecutablePath; foreach($r in $roots){ if(($cmd -and $cmd -like ('*' + $r + '*')) -or ($exe -and $exe -like ($r + '*'))){ return $true } }; return $false } | Sort-Object ProcessId -Descending | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }"
timeout /t 1 /nobreak >nul
start "" "%TARGET%\Aether.vbs"
exit /b 0

:active_dir
set "OLD="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$root=$env:WORK; $pick=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending | Select-Object -First 1 -ExpandProperty Dir; if($pick){ [Console]::Write($pick) }"`) do set "OLD=%%i"
if defined OLD exit /b 0
exit /b 0

:pick_pkg
set "DIR=%~1"
set "W=%~2"
set "PKG="
set "VER="
set "PKG_NAME="
if defined W (
  set "PKG=%DIR%\aether-windows-x64-%W%.zip"
  if exist "%PKG%" (
    set "VER=%W%"
    for %%i in ("%PKG%") do set "PKG_NAME=%%~nxi"
    exit /b 0
  )
)
for /f "usebackq tokens=1,2,3 delims=|" %%i in (`powershell -NoProfile -Command "$dir=$env:DIR; $hits=Get-ChildItem -Path $dir -File -Filter 'aether-windows-x64-*.zip' | ForEach-Object { $name='aether-windows-x64-'; if($_.BaseName.Length -gt $name.Length){ [PSCustomObject]@{Path=$_.FullName;Name=$_.Name;Ver=$_.BaseName.Substring($name.Length)} } } | Where-Object { $_ -and $_.Ver }; if(-not $hits){ exit 1 }; $pick=$hits | Sort-Object { [version](($_.Ver -replace '^v','').Split('-')[0]) } | Select-Object -Last 1; Write-Output ($pick.Path + '|' + $pick.Ver + '|' + $pick.Name)"`) do (
  set "PKG=%%i"
  set "VER=%%j"
  set "PKG_NAME=%%k"
)
if not defined PKG exit /b 1
exit /b 0

:cmp
set "A=%~1"
set "B=%~2"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$a=$env:A; $b=$env:B; function norm([string]$v){ if($null -eq $v -or $v -eq ''){ return $null }; $v=$v.Trim(); $v=$v -replace '^v',''; $v=$v.Split('-')[0]; $p=$v.Split('.'); while($p.Count -lt 4){ $p += '0' }; if($p.Count -gt 4){ $p=$p[0..3] }; [string]::Join('.', $p) }; $x=norm $a; $y=norm $b; if($null -eq $x -or $null -eq $y){ if($a -eq $b){ 'eq' } else { 'lt' }; exit 0 }; if(([version]$x) -lt ([version]$y)){ 'lt' } elseif(([version]$x) -gt ([version]$y)){ 'gt' } else { 'eq' }"`) do set "CMP=%%i"
exit /b 0

:installed
set "%~2="
set "DIR=%~1"
set "RV="
for %%i in ("%DIR%") do set "NAME=%%~nxi"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$name=$env:NAME; if($name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ [Console]::Write($matches[1]) }"`) do set "%~2=%%i"
if defined %~2 exit /b 0
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$root=$env:DIR; $best=Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending | Select-Object -First 1 -ExpandProperty Ver; if($best){ [Console]::Write($best) }"`) do set "%~2=%%i"
exit /b 0

:fail
echo Update failed.
call :clean_tmp
exit /b 1

:clean_tmp
if exist "%TMP%" rmdir /s /q "%TMP%" >nul 2>nul
if exist "%NEXT%" rmdir /s /q "%NEXT%" >nul 2>nul
exit /b 0

:prune_versions
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "& { $root=$env:WORK; $keep=5; $hold=[IO.Path]::GetFullPath($env:TARGET); $items=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending; $keepers=New-Object System.Collections.Generic.List[string]; foreach($dir in @($hold)){ if($dir -and ($items | Where-Object { $_.Dir -eq $dir }) -and -not $keepers.Contains($dir)){ $keepers.Add($dir) } }; foreach($item in $items){ if($keepers.Count -ge $keep){ break }; if(-not $keepers.Contains($item.Dir)){ $keepers.Add($item.Dir) } }; $gone=0; foreach($item in $items){ if($keepers.Contains($item.Dir)){ continue }; Remove-Item $item.Dir -Recurse -Force -ErrorAction SilentlyContinue; if(-not (Test-Path $item.Dir)){ $gone++ } }; Write-Output $gone }"`) do set "PRUNE=%%i"
if not defined PRUNE set "PRUNE=0"
exit /b 0
