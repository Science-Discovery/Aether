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
CreateObject("WScript.Shell").Run "cmd /c """ & exePath & """ web >> """ & logPath & """ 2>&1", 0, False

