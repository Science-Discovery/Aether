Dim fso, scriptDir, portFile, port, wsh, url

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

portFile = CreateObject("WScript.Shell").ExpandEnvironmentStrings("%APPDATA%") & "\aether\__AETHER_CHANNEL__\serve-port"
port = ""

If fso.FileExists(portFile) Then
    On Error Resume Next
    Dim ts
    Set ts = fso.OpenTextFile(portFile, 1)
    port = ts.ReadLine
    ts.Close
    On Error GoTo 0
End If

If port = "" Then port = "19527"

url = "http://127.0.0.1:" & port & "/"

On Error Resume Next
Dim http
Set http = CreateObject("MSXML2.XMLHTTP.6.0")
If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.XMLHTTP.3.0")
End If
If Err.Number <> 0 Then
    Err.Clear
    Set http = CreateObject("MSXML2.XMLHTTP")
End If
If Err.Number <> 0 Then
    On Error GoTo 0
    GoTo NoCheck
End If
http.Open "GET", url, False
http.setRequestHeader "Connection", "close"
http.Send
If Err.Number = 0 Then
    On Error GoTo 0
    CreateObject("WScript.Shell").Run url, 1, False
    WScript.Quit 0
End If
On Error GoTo 0

NoCheck:

Dim vbsPath
vbsPath = scriptDir & "\Aether.vbs"
If Not fso.FileExists(vbsPath) Then
    MsgBox "找不到: " & vbsPath, 16, "启动失败"
    WScript.Quit 1
End If

CreateObject("WScript.Shell").Run "wscript.exe """ & vbsPath & """", 1, False
WScript.Quit 0