Dim fso, scriptDir, exePath, psCmd
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = scriptDir & "\aether.exe"

If Not fso.FileExists(exePath) Then
    MsgBox "找不到: " & exePath, 16, "启动失败"
    WScript.Quit 1
End If

psCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command ""Unblock-File -Path '" & exePath & "'"""
CreateObject("WScript.Shell").Run psCmd, 0, True

Dim logPath
logPath = scriptDir & "\aether-log.txt"

' Truncate log to last 2000 lines on each startup
Dim psCmd2
psCmd2 = "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & _
    "$f='" & logPath & "';" & _
    "if(Test-Path $f){" & _
        "$lines=Get-Content $f -Encoding UTF8 -ErrorAction SilentlyContinue;" & _
        "if($lines -ne $null -and $lines.Count -gt 2000){$lines[-2000..-1]|Set-Content $f -Encoding UTF8}}" & _
    """"
CreateObject("WScript.Shell").Run psCmd2, 0, True

Dim wsh
Set wsh = CreateObject("WScript.Shell")
wsh.CurrentDirectory = scriptDir
wsh.Run "cmd /c set NO_COLOR=1 && aether.exe web >> aether-log.txt 2>&1", 0, False

