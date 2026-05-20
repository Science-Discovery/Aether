Dim fso, scriptDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = scriptDir & "\aether.exe"

If Not fso.FileExists(exePath) Then
    MsgBox "找不到: " & exePath, 16, "启动失败"
    WScript.Quit 1
End If

' Stop all existing Aether backend processes (any version/directory)
Dim stopCmd
stopCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & _
    "$h=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'});" & _
    "if($h.Count-gt 0){" & _
        "$h|Sort-Object ProcessId -Descending|ForEach-Object{Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue};" & _
        "for($i=0;$i-lt 5;$i++){Start-Sleep -Seconds 1;" & _
            "if(@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'}).Count-eq 0){exit 0}};" & _
        "$r=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'aether.exe'});" & _
        "if($r.Count-gt 0){" & _
            "$r|Sort-Object ProcessId -Descending|ForEach-Object{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue};" & _
            "Start-Sleep -Seconds 2}" & _
    "}" & _
    """"
CreateObject("WScript.Shell").Run stopCmd, 0, True

Dim logPath
logPath = scriptDir & "\aether-log.txt"

' Unblock exe and truncate log to last 2000 lines in a single PowerShell call
Dim psCmd
psCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & _
    "Unblock-File -Path '" & exePath & "';" & _
    "$f='" & logPath & "';" & _
    "if(Test-Path $f){" & _
        "$lines=Get-Content $f -Encoding UTF8 -ErrorAction SilentlyContinue;" & _
        "if($lines -ne $null -and $lines.Count -gt 2000){$lines[-2000..-1]|Set-Content $f -Encoding UTF8}}" & _
    """"
CreateObject("WScript.Shell").Run psCmd, 0, True

Dim wsh
Set wsh = CreateObject("WScript.Shell")
wsh.CurrentDirectory = scriptDir
wsh.Run "cmd /c set NO_COLOR=1 && aether.exe web >> aether-log.txt 2>&1", 0, False

