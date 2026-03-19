Dim fso, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Dim WshShell
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """" & scriptDir & "\aether.exe"" web", 0, False
