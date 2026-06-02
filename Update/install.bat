@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
set "PSH=powershell -NoProfile -WindowStyle Hidden"
set "PSV=powershell -NoProfile"

if not defined LOCALAPPDATA set "LOCALAPPDATA=%USERPROFILE%\AppData\Local"
set "DEFAULT=%LOCALAPPDATA%\Programs\aether"
set "WORK=%USERPROFILE%\.local\share\aether\update\aether"
set "PATH_ARG="
set "RESTART=1"
set "NOHOLD=0"
set "HOLD=1"
set "OK=0"
set "LATEST_OK=20"
set "RUN_ERR=33"
set "DIR_ERR=40"
set "ARG_ERR=50"
set "PRUNE=0"
set "MPRUNE=0"
set "LAUNCH="
set "NOTE="
set "COPY_NOTE="
set "PKG=aether-windows-x64"
set "SRC_ERR="

if defined LOCALAPPDATA (
  set "DEBUG_DIR=%LOCALAPPDATA%\aether\update_debug"
) else (
  set "DEBUG_DIR=%TEMP%\aether\update_debug"
)
for /f "usebackq delims=" %%t in (`%PSH% -Command "Get-Date -Format 'yyyyMMdd_HHmmss'"`) do set "DEBUG_TS=%%t"
if not defined DEBUG_TS set "DEBUG_TS=%RANDOM%%RANDOM%"
set "DEBUG_LOG=%DEBUG_DIR%\install_%DEBUG_TS%.log"
call :debug_log "========== NEW GITHUB INSTALL RUN =========="

:parse
if "%~1"=="" goto :parse_done
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
if /I "%~1"=="--no-restart" (
  set "RESTART=0"
  shift
  goto :parse
)
if /I "%~1"=="--no-pause" (
  set "NOHOLD=1"
  set "HOLD="
  shift
  goto :parse
)
if /I "%~1"=="help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--help" goto :help
echo Unsupported argument: %~1
exit /b %ARG_ERR%

:parse_done
if "%NOHOLD%"=="1" set "HOLD="

set "SELF=%~dp0"
if "%SELF:~-1%"=="\" set "SELF=%SELF:~0,-1%"
set "SRC="
for %%i in ("%SELF%") do set "SELF_NAME=%%~nxi"
if /I "%SELF_NAME%"=="%PKG%" if exist "%SELF%\aether.exe" if exist "%SELF%\Aether.vbs" set "SRC=%SELF%"
if not defined SRC if exist "%SELF%\aether.exe" if exist "%SELF%\Aether.vbs" set "SRC_ERR=Package architecture mismatch: expected %PKG%, got %SELF_NAME%"
if not defined SRC if exist "%SELF%\%PKG%\aether.exe" if exist "%SELF%\%PKG%\Aether.vbs" set "SRC=%SELF%\%PKG%"
if not defined SRC (
  if defined SRC_ERR (
    echo %SRC_ERR%
  ) else (
    echo Missing app files ^(aether.exe/Aether.vbs^) in %SELF%
  )
  exit /b %RUN_ERR%
)
if not exist "%SRC%\.aether_web_version" (
  echo Missing .aether_web_version in %SRC%
  exit /b %RUN_ERR%
)
set /p VER=<"%SRC%\.aether_web_version"
if "%VER%"=="" (
  echo Empty .aether_web_version in %SRC%
  exit /b %RUN_ERR%
)

if defined PATH_ARG (
  call :normalize "%PATH_ARG%" MIRROR
) else (
  set "MIRROR=%DEFAULT%"
)
set "TARGET=%WORK%\aether_%VER%"
set "NEXT=%WORK%\.aether_%VER%.next"
set "RESULT=%WORK%\downloads\web-update-result.env"
set "AETHER_MIRROR_ROOT=%MIRROR%"
set "AETHER_CURRENT_DIR=%MIRROR%\aether_%VER%"
if exist "%RESULT%" del /f /q "%RESULT%" >nul 2>nul

echo Aether Windows GitHub Release Installer
echo(
echo Source directory:
echo   %SRC%
echo Work directory:
echo   %WORK%
echo Install directory:
echo   %MIRROR%
echo Version:
echo   %VER%

if not exist "%WORK%" mkdir "%WORK%" >nul 2>nul || goto :dir_fail
if not exist "%WORK%\downloads" mkdir "%WORK%\downloads" >nul 2>nul || goto :dir_fail
if not exist "%MIRROR%" mkdir "%MIRROR%" >nul 2>nul || goto :dir_fail

set "CUR="
call :installed "%MIRROR%" CUR
if defined CUR (
  call :cmp "%CUR%" "%VER%"
  if /I "!CMP!"=="eq" (
    call :write_result "up_to_date" "" ""
    echo(
    echo Current version: !CUR!
    echo Package version: %VER%
    echo Already up to date.
    call :hold
    exit /b %LATEST_OK%
  )
)

call :active_dir
call :clean_next
mkdir "%NEXT%" >nul 2>nul || (
  call :write_result "failed" "recover" "Failed to prepare next version directory"
  goto :fail
)
robocopy "%SRC%" "%NEXT%" /MIR /NFL /NDL /NJH /NJS /NP /XF install.bat >nul
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  call :write_result "failed" "recover" "Failed to copy files into %NEXT%"
  goto :fail
)
if exist "%TARGET%" rmdir /s /q "%TARGET%" >nul 2>nul
move "%NEXT%" "%TARGET%" >nul || (
  call :write_result "failed" "recover" "Failed to finalize install into %TARGET%"
  goto :fail
)

>"%TARGET%\.aether_web_version" echo(%VER%
if exist "%WORK%\.aether_web_version" del /f /q "%WORK%\.aether_web_version" >nul 2>nul
if exist "%WORK%\current" rmdir "%WORK%\current" >nul 2>nul
if exist "%WORK%\current" rmdir /s /q "%WORK%\current" >nul 2>nul

call :prune_versions || goto :fail
call :in_work "%WORK%"
if errorlevel 1 (
  call :mirror || (
    if not defined COPY_NOTE set "COPY_NOTE=Failed to mirror the new version near %AETHER_CURRENT_DIR%"
    call :write_result "failed" "mirror" "!COPY_NOTE!"
    goto :fail
  )
) else (
  set "COPY_NOTE=Current app already runs inside WorkDir; skipped mirror."
)
if defined MIRROR_DIR set "START=%MIRROR_DIR%"
if defined MIRROR_DIR call :prune_mirror
if not defined START set "START=%TARGET%"
call :write_launch "%START%"
call :register_protocol "%START%"

if "%RESTART%"=="1" call :restart

call :write_result "installed" "" ""
call :print_prune
echo [4/4] Done
echo Current version: %VER%
echo Version directory: %TARGET%
if defined MIRROR_DIR echo Mirror directory: %MIRROR_DIR%
if defined MPRUNE if not "%MPRUNE%"=="0" echo Mirror cleanup: removed %MPRUNE% older version directories.
echo Launch entry: %LAUNCH%
if defined NOTE echo %NOTE%
if defined COPY_NOTE echo %COPY_NOTE%
call :hold
call :debug_log "========== GITHUB INSTALL RUN COMPLETE =========="
exit /b %OK%

:normalize
set "IN=%~1"
set "BASE_NAME="
for %%i in ("%IN%") do set "BASE_NAME=%%~nxi"
if /I "%BASE_NAME%"=="aether" (
  set "%~2=%IN%"
) else (
  set "%~2=%IN%\aether"
)
exit /b 0

:cmp
set "A=%~1"
set "B=%~2"
for /f "usebackq delims=" %%i in (`%PSV% -Command "$a=$env:A; $b=$env:B; function norm([string]$v){ if($null -eq $v -or $v -eq ''){ return $null }; $v=$v.Trim(); $v=$v -replace '^v',''; $v=$v.Split('-')[0]; $p=$v.Split('.'); while($p.Count -lt 4){ $p += '0' }; if($p.Count -gt 4){ $p=$p[0..3] }; [string]::Join('.', $p) }; $x=norm $a; $y=norm $b; if($null -eq $x -or $null -eq $y){ if($a -eq $b){ 'eq' } else { 'lt' }; exit 0 }; if(([version]$x) -lt ([version]$y)){ 'lt' } elseif(([version]$x) -gt ([version]$y)){ 'gt' } else { 'eq' }"`) do set "CMP=%%i"
exit /b 0

:installed
set "%~2="
set "DIR=%~1"
for %%i in ("%DIR%") do set "NAME=%%~nxi"
for /f "usebackq delims=" %%i in (`%PSV% -Command "$name=$env:NAME; if($name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ [Console]::Write($matches[1]) }"`) do set "%~2=%%i"
if defined %~2 exit /b 0
for /f "usebackq delims=" %%i in (`%PSV% -Command "$root=$env:DIR; $best=Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending | Select-Object -First 1 -ExpandProperty Ver; if($best){ [Console]::Write($best) }"`) do set "%~2=%%i"
exit /b 0

:active_dir
set "OLD="
for /f "usebackq delims=" %%i in (`%PSV% -Command "$root=$env:WORK; $pick=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending | Select-Object -First 1 -ExpandProperty Dir; if($pick){ [Console]::Write($pick) }"`) do set "OLD=%%i"
exit /b 0

:in_work
set "CHK=%~1"
if not defined AETHER_CURRENT_DIR exit /b 1
for /f "usebackq delims=" %%i in (`%PSV% -Command "$cur=[IO.Path]::GetFullPath($env:AETHER_CURRENT_DIR); $root=[IO.Path]::GetFullPath($env:CHK); if($cur -eq $root -or $cur.StartsWith($root + [IO.Path]::DirectorySeparatorChar)){ Write-Output '1' } else { Write-Output '0' }"`) do set "IN_WORK=%%i"
if "!IN_WORK!"=="1" exit /b 0
exit /b 1

:mirror
set "MROOT=%MIRROR%"
set "MIRROR_DIR=%MROOT%\aether_%VER%"
if exist "%MIRROR_DIR%" (
  call :stamp TS
  set "MIRROR_DIR=%MROOT%\aether_%VER%_!TS!"
)
set "MCOPY=%MIRROR_DIR%.copy"
if exist "%MCOPY%" rmdir /s /q "%MCOPY%" >nul 2>nul
if exist "%MIRROR_DIR%" rmdir /s /q "%MIRROR_DIR%" >nul 2>nul
mkdir "%MCOPY%" >nul 2>nul || (
  set "COPY_NOTE=Warning: failed to prepare mirror directory near %AETHER_CURRENT_DIR%"
  exit /b 1
)
robocopy "%TARGET%" "%MCOPY%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=!ERRORLEVEL!"
if !RC! GEQ 8 (
  set "COPY_NOTE=Warning: failed to copy the new version near %AETHER_CURRENT_DIR%"
  if exist "%MCOPY%" rmdir /s /q "%MCOPY%" >nul 2>nul
  exit /b 1
)
move "%MCOPY%" "%MIRROR_DIR%" >nul || (
  set "COPY_NOTE=Warning: failed to finalize the copied version near %AETHER_CURRENT_DIR%"
  if exist "%MCOPY%" rmdir /s /q "%MCOPY%" >nul 2>nul
  exit /b 1
)
set "COPY_NOTE=Copied the new version near the current app location: %MIRROR_DIR%"
exit /b 0

:write_launch
set "CMD=%~1\Aether.vbs"
set "ICON=%~1\aether-icon.ico"
set "OUT=%TEMP%\aether-launch-%RANDOM%%RANDOM%.txt"
if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
%PSH% -Command "$cmd=$env:CMD; $icon=$env:ICON; $out=$env:OUT; $w=New-Object -ComObject WScript.Shell; $desk=[Environment]::GetFolderPath('DesktopDirectory'); if(-not $desk){ $desk=$w.SpecialFolders.Item('Desktop') }; $menu=[Environment]::GetFolderPath('Programs'); if(-not $menu){ $menu=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }; $desk2=[Environment]::GetFolderPath('CommonDesktopDirectory'); $menu2=[Environment]::GetFolderPath('CommonPrograms'); $all=@($desk,$menu,$desk2,$menu2) | Where-Object { $_ } | Select-Object -Unique; foreach($dir in $all){ $lnk=Join-Path $dir 'Aether.lnk'; try { if(Test-Path $lnk){ Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop } } catch {} }; $mk={ param($path,$target) try { $dir=Split-Path -Parent $path; if($dir -and -not (Test-Path $dir)){ New-Item -ItemType Directory -Path $dir -Force | Out-Null }; if(Test-Path $path){ Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }; $s=$w.CreateShortcut($path); $s.TargetPath=$target; $s.WorkingDirectory=(Split-Path -Parent $target); if($icon -and (Test-Path $icon)){$s.IconLocation=$icon}; $s.Save(); if(-not (Test-Path $path)){ return $false }; $hit=$w.CreateShortcut($path); return $hit.TargetPath -eq $target } catch { return $false } }; $launch=''; $note=''; $desk_ok=$false; $menu_ok=$false; $desk2_ok=$false; $menu2_ok=$false; if($desk){ $desk_ok=& $mk (Join-Path $desk 'Aether.lnk') $cmd }; if($menu){ $menu_ok=& $mk (Join-Path $menu 'Aether.lnk') $cmd }; if($desk2){ $desk2_ok=& $mk (Join-Path $desk2 'Aether.lnk') $cmd }; if($menu2){ $menu2_ok=& $mk (Join-Path $menu2 'Aether.lnk') $cmd }; if($desk_ok){ $launch=Join-Path $desk 'Aether.lnk'; $note='Double-click Aether.vbs on your desktop to run it.' } elseif($desk2_ok){ $launch=Join-Path $desk2 'Aether.lnk'; $note='Double-click Aether.vbs on your desktop to run it.' } elseif($menu_ok){ $launch=Join-Path $menu 'Aether.lnk'; $note='Run Aether.vbs from the Start Menu.' } elseif($menu2_ok){ $launch=Join-Path $menu2 'Aether.lnk'; $note='Run Aether.vbs from the Start Menu.' } else { $launch=$cmd; $note='Shortcut creation failed. Open File Explorer, find this path, and double-click the file to run it.' }; [IO.File]::WriteAllLines($out, @($launch,$note))"
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

:register_protocol
set "PROT_DIR=%~1"
set "PROT_HANDLER=%PROT_DIR%\aether-protocol-handler.vbs"
if not exist "%PROT_HANDLER%" exit /b 0
%PSH% -Command "$hkcu='HKCU:\Software\Classes\aether'; $handler=$env:PROT_HANDLER; if(-not (Test-Path $hkcu)){ New-Item -Path $hkcu -Force | Out-Null }; Set-ItemProperty -Path $hkcu -Name '(Default)' -Value 'URL:Aether Protocol' -Force; Set-ItemProperty -Path $hkcu -Name 'URL Protocol' -Value '' -Force; $cmd=$hkcu+'\shell\open\command'; if(-not (Test-Path $cmd)){ New-Item -Path $cmd -Force | Out-Null }; Set-ItemProperty -Path $cmd -Name '(Default)' -Value ('wscript.exe \"' + $handler + '\"') -Force" >nul 2>nul
exit /b 0

:restart
call :stop_runtime
timeout /t 1 /nobreak >nul
set "AETHER_WEB_OPEN_FALLBACK_MS=3000"
start "" "%START%\Aether.vbs"
exit /b 0

:stop_runtime
%PSH% -Command "$roots=@($env:OLD,$env:TARGET,$env:AETHER_CURRENT_DIR,$env:MIRROR_DIR); if($env:WORK -and (Test-Path -LiteralPath $env:WORK)){ Get-ChildItem -LiteralPath $env:WORK -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $roots += $_.FullName } }; if($env:MIRROR -and (Test-Path -LiteralPath $env:MIRROR)){ Get-ChildItem -LiteralPath $env:MIRROR -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $roots += $_.FullName } }; $roots=$roots | Where-Object { $_ } | ForEach-Object { try { [IO.Path]::GetFullPath($_) } catch { $_ } }; $names=@('aether.exe','wscript.exe','cscript.exe','node.exe','bun.exe'); function Hits { Get-CimInstance Win32_Process | Where-Object { $n=$_.Name.ToLowerInvariant(); if($names -notcontains $n){ return $false }; $cmd=$_.CommandLine; $exe=$_.ExecutablePath; foreach($r in $roots){ if(($cmd -and $cmd.IndexOf($r,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($exe -and $exe.StartsWith($r,[StringComparison]::OrdinalIgnoreCase))){ return $true } }; return $false } }; $hits=@(Hits); if($hits.Count -gt 0){ Write-Host 'Stopping old Aether processes...'; $hits | Sort-Object ProcessId -Descending | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } }; for($i=0; $i -lt 5; $i++){ Start-Sleep -Seconds 1; $hits=@(Hits); if($hits.Count -eq 0){ exit 0 } }; $hits=@(Hits); if($hits.Count -gt 0){ $hits | Sort-Object ProcessId -Descending | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; Start-Sleep -Seconds 1"
exit /b 0

:write_result
set "RESULT_STATUS=%~1"
set "RESULT_ACTION=%~2"
set "RESULT_ERROR=%~3"
if not defined RESULT exit /b 0
%PSH% -Command "$file=$env:RESULT; $dir=Split-Path -Parent $file; if($dir){ [IO.Directory]::CreateDirectory($dir) | Out-Null }; $err=$env:RESULT_ERROR; if($null -eq $err){ $err='' }; $err=($err -replace [char]10,' ' -replace [char]13,' '); $lines=@(('status=' + $env:RESULT_STATUS),('version=' + $env:VER),('action=' + $env:RESULT_ACTION),('error=' + $err),('at=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())); [IO.File]::WriteAllLines($file, $lines)" >nul
exit /b 0

:prune_versions
for /f "usebackq delims=" %%i in (`%PSV% -Command "$root=$env:WORK; $keep=1000; $hold=[IO.Path]::GetFullPath($env:TARGET); $items=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending; $keepers=New-Object System.Collections.Generic.List[string]; foreach($dir in @($hold)){ if($dir -and ($items | Where-Object { $_.Dir -eq $dir }) -and -not $keepers.Contains($dir)){ $keepers.Add($dir) } }; foreach($item in $items){ if($keepers.Count -ge $keep){ break }; if(-not $keepers.Contains($item.Dir)){ $keepers.Add($item.Dir) } }; $gone=0; foreach($item in $items){ if($keepers.Contains($item.Dir)){ continue }; Remove-Item $item.Dir -Recurse -Force -ErrorAction SilentlyContinue; if(-not (Test-Path $item.Dir)){ $gone++ } }; Write-Output $gone"`) do set "PRUNE=%%i"
if not defined PRUNE set "PRUNE=0"
exit /b 0

:prune_mirror
for /f "usebackq delims=" %%i in (`%PSV% -Command "$root=$env:MIRROR; $keep=1000; $hold=''; if($env:MIRROR_DIR){ $hold=[IO.Path]::GetFullPath($env:MIRROR_DIR) }; $items=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)($|_[0-9]{12}$)'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending; $keepers=New-Object System.Collections.Generic.List[string]; foreach($dir in @($hold)){ if($dir -and ($items | Where-Object { $_.Dir -eq $dir }) -and -not $keepers.Contains($dir)){ $keepers.Add($dir) } }; foreach($item in $items){ if($keepers.Count -ge $keep){ break }; if(-not $keepers.Contains($item.Dir)){ $keepers.Add($item.Dir) } }; $gone=0; foreach($item in $items){ if($keepers.Contains($item.Dir)){ continue }; Remove-Item $item.Dir -Recurse -Force -ErrorAction SilentlyContinue; if(-not (Test-Path $item.Dir)){ $gone++ } }; Write-Output $gone"`) do set "MPRUNE=%%i"
if not defined MPRUNE set "MPRUNE=0"
exit /b 0

:stamp
for /f "usebackq delims=" %%i in (`%PSH% -Command "Get-Date -Format 'yyyyMMddHHmm'"`) do set "%~1=%%i"
exit /b 0

:print_prune
if "%PRUNE%"=="0" (
  echo [3/4] Keeping the latest 1000 versions; no older version directories needed removal.
  exit /b 0
)
echo [3/4] Keeping the latest 1000 versions; removed %PRUNE% older version directories.
exit /b 0

:clean_next
if exist "%NEXT%" rmdir /s /q "%NEXT%" >nul 2>nul
exit /b 0

:dir_fail
call :write_result "failed" "recover" "Directory creation failed"
echo Directory creation failed.
call :hold
exit /b %DIR_ERR%

:fail
call :clean_next
echo Install failed.
call :hold
exit /b 1

:hold
if not defined HOLD exit /b 0
echo(
%PSV% -Command "if(-not [Environment]::UserInteractive){ exit 0 }; try { Write-Host 'Press Esc to close...'; while(([Console]::ReadKey($true)).Key -ne 'Escape') {} } catch { exit 0 }"
exit /b 0

:help
echo Aether Windows GitHub Release Installer
echo(
echo Usage:
echo   %~nx0 [--path ^<dir^>] [--no-restart] [--no-pause]
echo(
echo Options:
echo   --path ^<dir^>    Install target directory ^(default %DEFAULT%^)
echo   --no-restart     Do not restart Aether after install
echo   --no-pause       Do not wait for Esc before closing
exit /b %OK%

:debug_log
if not defined DEBUG_LOG exit /b 0
setlocal DisableDelayedExpansion
set "LOG=%DEBUG_LOG%"
set "DIR=%DEBUG_DIR%"
set "MSG=%~1"
if not exist "%DIR%" mkdir "%DIR%" >nul 2>nul
set "STAMP=%DATE% %TIME: =0%"
setlocal EnableDelayedExpansion
>>"!LOG!" echo(!STAMP! ^| !MSG! 2>nul
endlocal
endlocal
exit /b 0
