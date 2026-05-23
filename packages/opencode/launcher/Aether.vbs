Dim fso, wsh, env, dbg, scriptDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")
Set env = wsh.Environment("PROCESS")
dbg = env("AETHER_DEBUG_LOG")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = scriptDir & "\aether.exe"

Sub Journal(msg)
    On Error Resume Next
    If dbg <> "" Then
        Dim ts
        Set ts = fso.OpenTextFile(dbg, 8, True)
        ts.WriteLine FormatDateTime(Now, 2) & " " & FormatDateTime(Now, 4) & " | VBS | " & msg
        ts.Close
    End If
    On Error GoTo 0
End Sub

Journal "START | script=" & WScript.ScriptFullName & " scriptDir=" & scriptDir & " exe=" & exePath
Journal "ENVR | AETHER_WEB_OPEN_FALLBACK_MS=" & env("AETHER_WEB_OPEN_FALLBACK_MS") & " AETHER_DEBUG_LOG=" & dbg

If Not fso.FileExists(exePath) Then
    Journal "FAIL | missing exe=" & exePath
    MsgBox "找不到: " & exePath, 16, "启动失败"
    WScript.Quit 1
End If

' Stop all existing Aether backend processes (any version/directory)
Dim stopCmd, stopCode
stopCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & _
    "$log=$env:AETHER_DEBUG_LOG;" & _
    "function L([string]$m){if($log){$dir=Split-Path -Parent $log;if($dir){[IO.Directory]::CreateDirectory($dir)|Out-Null};Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')+' | VBS_STOP | '+$m)}};" & _
    "function F([string]$s){if($null -eq $s){return ''};return ($s -replace [char]13,' ' -replace [char]10,' ')};" & _
    "L('scan start');" & _
    "$h=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'});" & _
    "L('initial count='+$h.Count);" & _
    "$h|Sort-Object ProcessId|ForEach-Object{L('initial pid='+$_.ProcessId+' exe='+(F $_.ExecutablePath)+' cmd='+(F $_.CommandLine))};" & _
    "if($h.Count-gt 0){" & _
        "$h|Sort-Object ProcessId -Descending|ForEach-Object{L('terminate pid='+$_.ProcessId);Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue};" & _
        "for($i=0;$i-lt 5;$i++){Start-Sleep -Seconds 1;" & _
            "$w=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'});L('after_soft_wait_'+($i+1)+' count='+$w.Count);" & _
            "if($w.Count-eq 0){L('all exited after soft stop');exit 0}};" & _
        "$r=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'});" & _
        "L('before_force count='+$r.Count);" & _
        "$r|Sort-Object ProcessId|ForEach-Object{L('before_force pid='+$_.ProcessId+' exe='+(F $_.ExecutablePath)+' cmd='+(F $_.CommandLine))};" & _
        "if($r.Count-gt 0){" & _
            "$r|Sort-Object ProcessId -Descending|ForEach-Object{L('force pid='+$_.ProcessId);Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue};" & _
            "Start-Sleep -Seconds 2;" & _
            "$f=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'});L('final count='+$f.Count);" & _
            "$f|Sort-Object ProcessId|ForEach-Object{L('final pid='+$_.ProcessId+' exe='+(F $_.ExecutablePath)+' cmd='+(F $_.CommandLine))}" & _
        "}" & _
    "} else {L('no aether.exe processes found')}" & _
    """"
Journal "STOP | running stop command"
stopCode = wsh.Run(stopCmd, 0, True)
Journal "STOP | exit=" & stopCode

Dim logPath
logPath = scriptDir & "\aether-log.txt"

' Unblock exe and truncate log to last 2000 lines in a single PowerShell call
Dim psCmd, psCode
psCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & _
    "$log=$env:AETHER_DEBUG_LOG;" & _
    "function L([string]$m){if($log){Add-Content -LiteralPath $log -Encoding UTF8 -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')+' | VBS_PREP | '+$m)}};" & _
    "L('unblock start exe=' + $env:EXE_PATH + ' log=' + $env:AETHER_APP_LOG);" & _
    "Unblock-File -Path '" & exePath & "';" & _
    "$f='" & logPath & "';" & _
    "if(Test-Path $f){" & _
        "$lines=Get-Content $f -Encoding UTF8 -ErrorAction SilentlyContinue;" & _
        "if($lines -eq $null){L('app log lines=0')} elseif($lines.Count -gt 2000){L('truncating app log lines='+$lines.Count);$lines[-2000..-1]|Set-Content $f -Encoding UTF8} else {L('app log lines='+$lines.Count)}}" & _
    " else {L('app log missing before launch')};" & _
    "L('unblock done')" & _
    """"
env("EXE_PATH") = exePath
env("AETHER_APP_LOG") = logPath
Journal "PREP | running unblock/log trim"
psCode = wsh.Run(psCmd, 0, True)
Journal "PREP | exit=" & psCode

wsh.CurrentDirectory = scriptDir
Journal "BOOT | cwd=" & scriptDir & " cmd=cmd /c set NO_COLOR=1 && aether.exe web >> aether-log.txt 2>&1"
wsh.Run "cmd /c set NO_COLOR=1 && aether.exe web >> aether-log.txt 2>&1", 0, False
Journal "BOOT | command issued"
