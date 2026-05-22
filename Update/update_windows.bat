@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

if defined LOCALAPPDATA (
  set "DEBUG_DIR=%LOCALAPPDATA%\aether\update_debug"
) else (
  set "DEBUG_DIR=%TEMP%\aether\update_debug"
)
if defined AETHER_DEBUG_LOG (
  set "DEBUG_LOG=%AETHER_DEBUG_LOG%"
  for %%i in ("%DEBUG_LOG%") do set "DEBUG_DIR=%%~dpi"
) else (
  for /f "usebackq delims=" %%t in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd_HHmmss'"`) do set "DEBUG_TS=%%t"
  if not defined DEBUG_TS set "DEBUG_TS=%RANDOM%%RANDOM%"
  set "DEBUG_LOG=%DEBUG_DIR%\update_%DEBUG_TS%.log"
)

call :debug_log "========== NEW UPDATE RUN =========="

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
set "COPY_NOTE="
set "MIRROR="
set "START="
set "CUR="
set "CMP="
set "RV="
set "RESULT=%AETHER_UPDATE_RESULT%"
if not defined RESULT set "RESULT=%WORK%\downloads\web-update-result.env"
set "MIRROR_ONLY=%AETHER_MIRROR_ONLY%"

call :debug_log "ENVR | AETHER_CURRENT_DIR=%AETHER_CURRENT_DIR%"
call :debug_log "ENVR | AETHER_WORK_DIR=%AETHER_WORK_DIR%"
call :debug_log "ENVR | AETHER_UPDATE_RESULT=%AETHER_UPDATE_RESULT%"
call :debug_log "ENVR | AETHER_MIRROR_ROOT=%AETHER_MIRROR_ROOT%"
call :debug_log "ENVR | AETHER_MIRROR_ONLY=%MIRROR_ONLY%"
call :debug_log "ENVR | AETHER_DEBUG_LOG=%DEBUG_LOG%"
call :debug_log "ENVR | RESULT=%RESULT%"
call :debug_log "START | WANT=%WANT% RESTART=%RESTART% SELF=%SELF% BASE=%BASE% WORK=%WORK%"

if /I not "%BASE%"=="downloads" (
  echo Spec error: update_windows.bat must be placed in ...\aether\downloads. Current: %SELF%
  exit /b 1
)
for %%i in ("%WORK%") do set "WORK_NAME=%%~nxi"
if /I not "%WORK_NAME%"=="aether" (
  echo Spec error: work directory must be ...\aether. Current: %WORK%
  exit /b 1
)

echo [0/4] Work directory: %WORK%

call :debug_log "DISK | checking disk space on WORK=%WORK%"
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "(Get-PSDrive -Name ([IO.Path]::GetPathRoot($env:WORK).Substring(0,1)) -ErrorAction SilentlyContinue).Free / 1MB"`) do call :debug_log "DISK | free_mb=%%d"

if exist "%RESULT%" (
  call :debug_log "RESULT | deleting stale result file=%RESULT%"
  del /f /q "%RESULT%" >nul 2>nul
)

call :pick_pkg "%SELF%" "%WANT%"
if "%MIRROR_ONLY%"=="1" goto :pick_pkg_done
if errorlevel 1 (
  call :debug_log "PICK | FAILED no usable zip found"
  echo No usable zip found in ...\aether\downloads; filename must include a version
  call :write_result "failed" "recover" "No usable zip found in ...\aether\downloads; filename must include a version"
  exit /b 1
)
:pick_pkg_done
call :debug_log "PICK | PKG=%PKG% VER=%VER% PKG_NAME=%PKG_NAME%"

if "%VER%"=="" set "VER=%WANT%"

set "TARGET=%WORK%\aether_%VER%"
call :debug_log "START | VER=%VER% TARGET=%TARGET%"
echo [1/4] Package: %PKG_NAME%
echo       Target version: %VER%

call :installed "%WORK%" CUR
call :active_dir
call :debug_log "ACTIVE | CUR=%CUR% OLD=%OLD%"
if defined CUR (
  call :cmp "%CUR%" "%VER%"
  if /I "!CMP!"=="eq" (
    if defined OLD set "TARGET=%OLD%"
    if not defined OLD if exist "%WORK%\aether_%VER%" set "TARGET=%WORK%\aether_%VER%"
    if exist "%TARGET%" (
      echo [2/4] Version %VER% is already installed. Skipping install.
      goto :post_install
    )
  )
)

set "TMP=%TEMP%\aether-install-%RANDOM%%RANDOM%"
set "EX=%TMP%\extract"
set "NEXT=%WORK%\.aether_%VER%.next"
set "SRC_FILE=%TMP%\src.txt"

call :clean_tmp
if "%MIRROR_ONLY%"=="1" (
  if not exist "%TARGET%" (
    set "MSG=Installed version directory not found for mirror retry: %TARGET%"
    call :write_result "failed" "recover" "!MSG!"
    echo !MSG!
    goto :fail
  )
  call :debug_log "MIRROR_ONLY | reusing installed version at %TARGET%"
  echo [2/4] Reusing installed version at: %TARGET%
) else (
  mkdir "%EX%" || (
    call :write_result "failed" "recover" "Failed to prepare extract directory"
    goto :fail
  )
  mkdir "%NEXT%" || (
    call :write_result "failed" "recover" "Failed to prepare next version directory"
    goto :fail
  )
  call :debug_log "EXTRACT | prepared TMP=%TMP% EX=%EX% NEXT=%NEXT%"

  call :debug_log "EXTRACT | Expand-Archive PKG=%PKG% EX=%EX%"
  powershell -NoProfile -Command "& { Expand-Archive -Path $env:PKG -DestinationPath $env:EX -Force; $hit=Get-ChildItem -Path $env:EX -Filter 'aether.exe' -File -Recurse | Where-Object { Test-Path (Join-Path $_.DirectoryName 'Aether.vbs') } | Sort-Object { $_.DirectoryName.Length } | Select-Object -First 1; if(-not $hit){ throw 'missing app files' }; [IO.File]::WriteAllText($env:SRC_FILE, $hit.DirectoryName) }" || (
    call :write_result "failed" "recover" "Failed to extract %PKG%"
    call :debug_log "EXTRACT | FAILED Expand-Archive"
    goto :fail
  )
  call :debug_log "EXTRACT | Expand-Archive success"

  set "SRC="
  if exist "%SRC_FILE%" set /p SRC=<"%SRC_FILE%"
  call :debug_log "EXTRACT | SRC=!SRC!"
  if "!SRC!"=="" (
    call :write_result "failed" "recover" "Package contents missing aether.exe or Aether.vbs"
    echo Package contents missing aether.exe or Aether.vbs
    goto :fail
  )

echo [2/4] Extracting and installing to: %TARGET%
  call :debug_log "INSTALL | robocopy SRC=!SRC! NEXT=%NEXT%"
  robocopy "!SRC!" "!NEXT!" /MIR /NFL /NDL /NJH /NJS /NP >nul
  set "RC=!ERRORLEVEL!"
  call :debug_log "INSTALL | robocopy RC=!RC!"
  if !RC! GEQ 8 (
    call :write_result "failed" "recover" "Failed to copy files into %NEXT%"
    call :debug_log "INSTALL | robocopy failed RC=!RC!"
    goto :fail
  )

  if exist "%TARGET%" rmdir /s /q "%TARGET%" >nul 2>nul
  call :debug_log "INSTALL | move NEXT=%NEXT% TARGET=%TARGET%"
  move "%NEXT%" "%TARGET%" >nul || (
    call :write_result "failed" "recover" "Failed to finalize install into %TARGET%"
    call :debug_log "INSTALL | move failed"
    goto :fail
  )
  call :debug_log "INSTALL | move success"
)

:post_install
>"%TARGET%\.aether_web_version" echo(%VER%
call :debug_log "VERSION | wrote %TARGET%\.aether_web_version ver=%VER%"
if exist "%WORK%\.aether_web_version" del /f /q "%WORK%\.aether_web_version" >nul 2>nul

if exist "%WORK%\current" rmdir "%WORK%\current" >nul 2>nul
if exist "%WORK%\current" rmdir /s /q "%WORK%\current" >nul 2>nul

call :prune_versions || goto :fail
call :debug_log "PRUNE | PRUNE=%PRUNE%"
call :in_work "%WORK%"
if errorlevel 1 (
  call :debug_log "IN_WORK | AETHER_CURRENT_DIR not under WORK, attempting mirror"
  call :mirror || (
    set "MSG=!COPY_NOTE!"
    if not defined MSG set "MSG=Failed to mirror the new version near %AETHER_CURRENT_DIR%"
    call :write_result "failed" "mirror" "!MSG!"
    call :debug_log "MIRROR | FAILED: !MSG!"
    echo !MSG!
    goto :fail
  )
  call :debug_log "MIRROR | success MIRROR=!MIRROR!"
) else (
  call :debug_log "IN_WORK | AETHER_CURRENT_DIR under WORK, skipping mirror"
  set "COPY_NOTE=Current app already runs inside WorkDir; skipped mirror."
)
if defined MIRROR set "START=%MIRROR%"
if defined MIRROR call :prune_mirror
if not defined START set "START=%TARGET%"
call :debug_log "LAUNCH | START=%START% TARGET=%TARGET% MIRROR=%MIRROR% MPRUNE=%MPRUNE%"
call :write_launch "%START%"
call :debug_log "LAUNCH | LAUNCH=%LAUNCH% NOTE=%NOTE%"
call :register_protocol "%START%"
call :debug_log "REG | protocol handler registered for %START%"

if "%RESTART%"=="1" call :debug_log "RESTART | entering restart block"
if "%RESTART%"=="1" call :restart

call :write_result "installed" "" ""
call :debug_log "RESULT | status=installed version=%VER%"

call :print_prune

echo [4/4] Done
echo Current version: %VER%
echo Version directory: %TARGET%
if defined MIRROR echo Mirror directory: %MIRROR%
if defined MPRUNE if not "%MPRUNE%"=="0" echo Mirror cleanup: removed %MPRUNE% older version directories.
echo Launch entry: %LAUNCH%
if defined NOTE echo %NOTE%
if defined COPY_NOTE echo %COPY_NOTE%

call :clean_tmp
call :debug_log "END | ver=%VER% target=%TARGET% mirror=%MIRROR% launch=%LAUNCH% restart=%RESTART% prune=%PRUNE%"
call :debug_log "========== UPDATE RUN COMPLETE =========="
exit /b 0

:write_launch
set "CMD=%~1\Aether.vbs"
set "ICON=%~1\aether-icon.ico"
set "OUT=%TEMP%\aether-launch-%RANDOM%%RANDOM%.txt"
if exist "%OUT%" del /f /q "%OUT%" >nul 2>nul
powershell -NoProfile -Command "$cmd=$env:CMD; $icon=$env:ICON; $out=$env:OUT; $w=New-Object -ComObject WScript.Shell; $desk=[Environment]::GetFolderPath('DesktopDirectory'); if(-not $desk){ $desk=$w.SpecialFolders.Item('Desktop') }; $menu=[Environment]::GetFolderPath('Programs'); if(-not $menu){ $menu=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }; $desk2=[Environment]::GetFolderPath('CommonDesktopDirectory'); $menu2=[Environment]::GetFolderPath('CommonPrograms'); $all=@($desk,$menu,$desk2,$menu2) | Where-Object { $_ } | Select-Object -Unique; foreach($dir in $all){ $lnk=Join-Path $dir 'Aether.lnk'; try { if(Test-Path $lnk){ Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop } } catch {} }; $mk={ param($path,$target) try { $dir=Split-Path -Parent $path; if($dir -and -not (Test-Path $dir)){ New-Item -ItemType Directory -Path $dir -Force | Out-Null }; if(Test-Path $path){ Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }; $s=$w.CreateShortcut($path); $s.TargetPath=$target; $s.WorkingDirectory=(Split-Path -Parent $target); if($icon -and (Test-Path $icon)){$s.IconLocation=$icon}; $s.Save(); if(-not (Test-Path $path)){ return $false }; $hit=$w.CreateShortcut($path); return $hit.TargetPath -eq $target } catch { return $false } }; $launch=''; $note=''; $desk_ok=$false; $menu_ok=$false; $desk2_ok=$false; $menu2_ok=$false; if($desk){ $desk_ok=& $mk (Join-Path $desk 'Aether.lnk') $cmd }; if($menu){ $menu_ok=& $mk (Join-Path $menu 'Aether.lnk') $cmd }; if($desk2){ $desk2_ok=& $mk (Join-Path $desk2 'Aether.lnk') $cmd }; if($menu2){ $menu2_ok=& $mk (Join-Path $menu2 'Aether.lnk') $cmd }; if($desk_ok){ $launch=Join-Path $desk 'Aether.lnk'; $note='Double-click Aether.vbs on your desktop to run it.' } elseif($desk2_ok){ $launch=Join-Path $desk2 'Aether.lnk'; $note='Double-click Aether.vbs on your desktop to run it.' } elseif($menu_ok){ $launch=Join-Path $menu 'Aether.lnk'; $note='Run Aether.vbs from the Start Menu.' } elseif($menu2_ok){ $launch=Join-Path $menu2 'Aether.lnk'; $note='Run Aether.vbs from the Start Menu.' } else { $launch=$cmd; $note='Shortcut creation failed. Open File Explorer, find this path, and double-click the file to run it.' }; [IO.File]::WriteAllLines($out, @($launch,$note))"
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

:write_result
set "RESULT_STATUS=%~1"
set "RESULT_ACTION=%~2"
set "RESULT_ERROR=%~3"
if not defined RESULT exit /b 0
call :debug_log "RESULT | status=%RESULT_STATUS% version=%VER% action=%RESULT_ACTION% error=%RESULT_ERROR%"
powershell -NoProfile -Command "$file=$env:RESULT; $dir=Split-Path -Parent $file; if($dir){ [IO.Directory]::CreateDirectory($dir) | Out-Null }; $err=$env:RESULT_ERROR; if($null -eq $err){ $err='' }; $err=($err -replace [char]10,' ' -replace [char]13,' '); $lines=@(('status=' + $env:RESULT_STATUS),('version=' + $env:VER),('action=' + $env:RESULT_ACTION),('error=' + $err),('at=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())); [IO.File]::WriteAllLines($file, $lines)" >nul
exit /b 0

:print_prune
if "%PRUNE%"=="0" (
  echo [3/4] Keeping the latest 1000 versions; no older version directories needed removal.
  exit /b 0
)
echo [3/4] Keeping the latest 1000 versions; removed %PRUNE% older version directories.
exit /b 0

:mirror
call :debug_log "MIRROR_DIR | starting, AETHER_MIRROR_ROOT=%AETHER_MIRROR_ROOT% AETHER_CURRENT_DIR=%AETHER_CURRENT_DIR%"
if defined AETHER_MIRROR_ROOT set "MROOT=%AETHER_MIRROR_ROOT%" & goto mirror_have_root
if not defined AETHER_CURRENT_DIR exit /b 1
for %%i in ("%AETHER_CURRENT_DIR%\..") do set "MROOT=%%~fi"
:mirror_have_root
if not defined MROOT exit /b 1
set "MIRROR=%MROOT%\aether_%VER%"
if exist "%MIRROR%" call :stamp TS & set "MIRROR=%MROOT%\aether_%VER%_!TS!"
call :debug_log "MIRROR_DIR | MROOT=%MROOT% MIRROR=%MIRROR%"
set "MCOPY=%MIRROR%.copy"
if exist "%MCOPY%" rmdir /s /q "%MCOPY%" >nul 2>nul
if exist "%MIRROR%" rmdir /s /q "%MIRROR%" >nul 2>nul
mkdir "%MCOPY%" >nul 2>nul || (
  set "COPY_NOTE=Warning: failed to prepare mirror directory near %AETHER_CURRENT_DIR%"
  call :debug_log "MIRROR_DIR | mkdir MCOPY failed"
  exit /b 1
)
call :debug_log "MIRROR_DIR | robocopy TARGET=%TARGET% MCOPY=%MCOPY%"
robocopy "%TARGET%" "%MCOPY%" /MIR /NFL /NDL /NJH /NJS /NP >nul
set "RC=!ERRORLEVEL!"
call :debug_log "MIRROR_DIR | robocopy RC=!RC!"
if !RC! GEQ 8 (
  set "COPY_NOTE=Warning: failed to copy the new version near %AETHER_CURRENT_DIR%"
  call :debug_log "MIRROR_DIR | robocopy failed RC=!RC!"
  if exist "%MCOPY%" rmdir /s /q "%MCOPY%" >nul 2>nul
  exit /b 1
)
call :debug_log "MIRROR_DIR | move MCOPY=%MCOPY% MIRROR=%MIRROR%"
move "%MCOPY%" "%MIRROR%" >nul || (
  set "COPY_NOTE=Warning: failed to finalize the copied version near %AETHER_CURRENT_DIR%"
  call :debug_log "MIRROR_DIR | move failed"
  if exist "%MCOPY%" rmdir /s /q "%MCOPY%" >nul 2>nul
  exit /b 1
)
set "COPY_NOTE=Copied the new version near the current app location: %MIRROR%"
call :debug_log "MIRROR_DIR | success MIRROR=%MIRROR%"
exit /b 0

:stamp
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Get-Date -Format 'yyyyMMddHHmm'"`) do set "%~1=%%i"
exit /b 0

:in_work
set "CHK=%~1"
if not defined AETHER_CURRENT_DIR exit /b 1
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$cur=[IO.Path]::GetFullPath($env:AETHER_CURRENT_DIR); $root=[IO.Path]::GetFullPath($env:CHK); if($cur -eq $root -or $cur.StartsWith($root + [IO.Path]::DirectorySeparatorChar)){ Write-Output '1' } else { Write-Output '0' }"`) do set "IN_WORK=%%i"
if "!IN_WORK!"=="1" exit /b 0
exit /b 1

:restart
call :debug_log "RESTART | stopping runtime START=%START% TARGET=%TARGET% MIRROR=%MIRROR%"
call :stop_runtime
call :debug_log "RESTART | stop_runtime returned ERRORLEVEL=%ERRORLEVEL%"
call :snapshot_runtime "RESTART_AFTER_STOP"
call :debug_log "RESTART | waiting 1s before boot"
timeout /t 1 /nobreak >nul
set "AETHER_WEB_OPEN_FALLBACK_MS=3000"
call :debug_log "BOOT | fallback_ms=%AETHER_WEB_OPEN_FALLBACK_MS% debug_log=%DEBUG_LOG%"
if exist "%START%\Aether.vbs" (
  call :debug_log "BOOT | launcher exists %START%\Aether.vbs"
) else (
  call :debug_log "BOOT | launcher missing %START%\Aether.vbs"
)
call :debug_log "BOOT | launching %START%\Aether.vbs"
start "" "%START%\Aether.vbs"
call :debug_log "BOOT | start command issued"
call :snapshot_runtime "BOOT_AFTER_START"
exit /b 0

:stop_runtime
call :debug_log "STOP | starting stop_runtime OLD=%OLD% TARGET=%TARGET% AETHER_CURRENT_DIR=%AETHER_CURRENT_DIR% MIRROR=%MIRROR%"
powershell -NoProfile -Command "& { function Log([string]$m){ if(-not $env:DEBUG_LOG){ return }; $dir=Split-Path -Parent $env:DEBUG_LOG; if($dir){ [IO.Directory]::CreateDirectory($dir) | Out-Null }; Add-Content -LiteralPath $env:DEBUG_LOG -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' | ' + $m) }; function Flat([string]$s){ if($null -eq $s){ return '' }; return ($s -replace [char]13,' ' -replace [char]10,' ') }; $roots=New-Object System.Collections.Generic.List[string]; function AddRoot([string]$p){ if([string]::IsNullOrWhiteSpace($p)){ return }; try { $full=[IO.Path]::GetFullPath($p); if((Test-Path -LiteralPath $full) -and -not $roots.Contains($full)){ [void]$roots.Add($full); Log ('STOP | root=' + $full) } } catch { Log ('STOP | root_error path=' + (Flat $p) + ' error=' + (Flat $_.Exception.Message)) } }; AddRoot $env:OLD; AddRoot $env:TARGET; AddRoot $env:AETHER_CURRENT_DIR; AddRoot $env:MIRROR; if($env:WORK -and (Test-Path -LiteralPath $env:WORK)){ Get-ChildItem -LiteralPath $env:WORK -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { AddRoot $_.FullName } }; $base=''; if($env:AETHER_MIRROR_ROOT){ $base=$env:AETHER_MIRROR_ROOT } elseif($env:AETHER_CURRENT_DIR){ try { $base=[IO.Directory]::GetParent([IO.Path]::GetFullPath($env:AETHER_CURRENT_DIR)).FullName } catch { Log ('STOP | mirror_root_error error=' + (Flat $_.Exception.Message)) } }; if($base -and (Test-Path -LiteralPath $base)){ Get-ChildItem -LiteralPath $base -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { AddRoot $_.FullName } }; $names=@('aether.exe','wscript.exe','cscript.exe','node.exe','bun.exe'); function Hits { Get-CimInstance Win32_Process | Where-Object { $n=$_.Name.ToLowerInvariant(); if($names -notcontains $n){ return $false }; $cmd=$_.CommandLine; $exe=$_.ExecutablePath; foreach($r in $roots){ if(($cmd -and $cmd.IndexOf($r,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($exe -and $exe.StartsWith($r,[StringComparison]::OrdinalIgnoreCase))){ return $true } }; return $false } }; function Dump([string]$tag,[array]$hits){ Log ('STOP | ' + $tag + ' count=' + $hits.Count); $hits | Sort-Object ProcessId | ForEach-Object { Log ('STOP | ' + $tag + ' pid=' + $_.ProcessId + ' name=' + $_.Name + ' exe=' + (Flat $_.ExecutablePath) + ' cmd=' + (Flat $_.CommandLine)) } }; Log ('STOP | scan start roots=' + $roots.Count); $hits=@(Hits); Dump 'initial' $hits; if($hits.Count -gt 0){ Write-Host 'Stopping old Aether processes...'; $hits | Sort-Object ProcessId -Descending | ForEach-Object { Log ('STOP | terminate pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } }; for($i=0; $i -lt 5; $i++){ Start-Sleep -Seconds 1; $hits=@(Hits); Dump ('after_soft_wait_' + ($i + 1)) $hits; if($hits.Count -eq 0){ Log 'STOP | all processes exited after soft stop'; exit 0 } }; $hits=@(Hits); Dump 'before_force' $hits; if($hits.Count -gt 0){ $hits | Sort-Object ProcessId -Descending | ForEach-Object { Log ('STOP | force pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; for($i=0; $i -lt 3; $i++){ Start-Sleep -Seconds 1; $hits=@(Hits); Dump ('after_force_wait_' + ($i + 1)) $hits; if($hits.Count -eq 0){ Log 'STOP | all processes exited after force stop'; exit 0 } }; $hits=@(Hits); Dump 'final' $hits; if($hits.Count -gt 0){ Write-Host 'Warning: old Aether processes are still running; starting the new version anyway.'; Log 'STOP | warning old processes still running' } }"
call :debug_log "STOP | powershell exit=%ERRORLEVEL%"
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
  set "PKG=!DIR!\aether-windows-x64-!W!.zip"
  if exist "!PKG!" (
    set "VER=!W!"
    for %%i in ("!PKG!") do set "PKG_NAME=%%~nxi"
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
call :debug_log "FAIL | update failed"
echo Update failed.
call :clean_tmp
exit /b 1

:clean_tmp
call :debug_log "CLEANUP | TMP=%TMP% NEXT=%NEXT%"
if exist "%TMP%" rmdir /s /q "%TMP%" >nul 2>nul
if exist "%NEXT%" rmdir /s /q "%NEXT%" >nul 2>nul
exit /b 0

:snapshot_runtime
set "SNAP_TAG=%~1"
powershell -NoProfile -Command "& { function Log([string]$m){ if(-not $env:DEBUG_LOG){ return }; $dir=Split-Path -Parent $env:DEBUG_LOG; if($dir){ [IO.Directory]::CreateDirectory($dir) | Out-Null }; Add-Content -LiteralPath $env:DEBUG_LOG -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff') + ' | ' + $m) }; function Flat([string]$s){ if($null -eq $s){ return '' }; return ($s -replace [char]13,' ' -replace [char]10,' ') }; $roots=@($env:START,$env:TARGET,$env:MIRROR,$env:AETHER_CURRENT_DIR) | Where-Object { $_ } | ForEach-Object { try { [IO.Path]::GetFullPath($_) } catch { $_ } }; $names=@('aether.exe','wscript.exe','cscript.exe','node.exe','bun.exe'); $hits=@(Get-CimInstance Win32_Process | Where-Object { $n=$_.Name.ToLowerInvariant(); if($names -notcontains $n){ return $false }; if($roots.Count -eq 0){ return $n -eq 'aether.exe' }; $cmd=$_.CommandLine; $exe=$_.ExecutablePath; foreach($r in $roots){ if(($cmd -and $cmd.IndexOf($r,[StringComparison]::OrdinalIgnoreCase) -ge 0) -or ($exe -and $exe.StartsWith($r,[StringComparison]::OrdinalIgnoreCase))){ return $true } }; return $false }); Log ('SNAP | ' + $env:SNAP_TAG + ' count=' + $hits.Count + ' roots=' + ($roots -join ';')); $hits | Sort-Object ProcessId | ForEach-Object { Log ('SNAP | ' + $env:SNAP_TAG + ' pid=' + $_.ProcessId + ' name=' + $_.Name + ' exe=' + (Flat $_.ExecutablePath) + ' cmd=' + (Flat $_.CommandLine)) } }"
exit /b 0

:prune_versions
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "& { $root=$env:WORK; $keep=1000; $hold=[IO.Path]::GetFullPath($env:TARGET); $items=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)$'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending; $keepers=New-Object System.Collections.Generic.List[string]; foreach($dir in @($hold)){ if($dir -and ($items | Where-Object { $_.Dir -eq $dir }) -and -not $keepers.Contains($dir)){ $keepers.Add($dir) } }; foreach($item in $items){ if($keepers.Count -ge $keep){ break }; if(-not $keepers.Contains($item.Dir)){ $keepers.Add($item.Dir) } }; $gone=0; foreach($item in $items){ if($keepers.Contains($item.Dir)){ continue }; Remove-Item $item.Dir -Recurse -Force -ErrorAction SilentlyContinue; if(-not (Test-Path $item.Dir)){ $gone++ } }; Write-Output $gone }"`) do set "PRUNE=%%i"
if not defined PRUNE set "PRUNE=0"
exit /b 0

:prune_mirror
if not defined AETHER_CURRENT_DIR exit /b 0
for %%i in ("%AETHER_CURRENT_DIR%\..") do set "PROOT=%%~fi"
if not defined PROOT exit /b 0
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "& { $root=$env:PROOT; $keep=1000; $hold=''; if($env:MIRROR){ $hold=[IO.Path]::GetFullPath($env:MIRROR) }; $items=Get-ChildItem -Path $root -Directory -Filter 'aether_*' -ErrorAction SilentlyContinue | ForEach-Object { $ver=''; if(Test-Path (Join-Path $_.FullName '.aether_web_version')){ $ver=(Get-Content (Join-Path $_.FullName '.aether_web_version') -TotalCount 1).Trim() }; if(-not $ver -and $_.Name -match '^aether[-_]([0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z]+)*)($|_[0-9]{12}$)'){ $ver=$matches[1] }; if($ver){ [PSCustomObject]@{ Dir=$_.FullName; Ver=$ver } } } | Where-Object { $_ } | Sort-Object @{Expression={ [version](($_.Ver -replace '^v','').Split('-')[0]) }} -Descending; $keepers=New-Object System.Collections.Generic.List[string]; foreach($dir in @($hold)){ if($dir -and ($items | Where-Object { $_.Dir -eq $dir }) -and -not $keepers.Contains($dir)){ $keepers.Add($dir) } }; foreach($item in $items){ if($keepers.Count -ge $keep){ break }; if(-not $keepers.Contains($item.Dir)){ $keepers.Add($item.Dir) } }; $gone=0; foreach($item in $items){ if($keepers.Contains($item.Dir)){ continue }; Remove-Item $item.Dir -Recurse -Force -ErrorAction SilentlyContinue; if(-not (Test-Path $item.Dir)){ $gone++ } }; Write-Output $gone }"`) do set "MPRUNE=%%i"
if not defined MPRUNE set "MPRUNE=0"
exit /b 0

:register_protocol
set "PROT_DIR=%~1"
set "PROT_HANDLER=%PROT_DIR%\aether-protocol-handler.vbs"
if not exist "%PROT_HANDLER%" (call :debug_log "REG | no protocol handler at %PROT_HANDLER%" & exit /b 0)
call :debug_log "REG | registering protocol handler=%PROT_HANDLER%"
powershell -NoProfile -Command "& { $hkcu='HKCU:\Software\Classes\aether'; $handler=$env:PROT_HANDLER; if(-not (Test-Path $hkcu)){ New-Item -Path $hkcu -Force | Out-Null }; Set-ItemProperty -Path $hkcu -Name '(Default)' -Value 'URL:Aether Protocol' -Force; Set-ItemProperty -Path $hkcu -Name 'URL Protocol' -Value '' -Force; $cmd=$hkcu+'\shell\open\command'; if(-not (Test-Path $cmd)){ New-Item -Path $cmd -Force | Out-Null }; Set-ItemProperty -Path $cmd -Name '(Default)' -Value ('wscript.exe \"' + $handler + '\"') -Force }" >nul 2>nul
call :debug_log "REG | registry write done"
exit /b 0

:debug_log
if not defined DEBUG_LOG exit /b 0
setlocal DisableDelayedExpansion
set "LOG=%DEBUG_LOG%"
set "DIR=%DEBUG_DIR%"
set "MSG=%~1"
if not defined DIR for %%i in ("%LOG%") do set "DIR=%%~dpi"
if not exist "%DIR%" mkdir "%DIR%" >nul 2>nul
set "STAMP=%DATE% %TIME: =0%"
setlocal EnableDelayedExpansion
>>"!LOG!" echo(!STAMP! ^| !MSG! 2>nul
endlocal
endlocal
exit /b 0
