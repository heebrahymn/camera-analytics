Set fso = CreateObject("Scripting.FileSystemObject")
ScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run chr(34) & ScriptDir & "\start_worker.bat" & chr(34), 0, False
Set WshShell = Nothing
Set fso = Nothing
